"""Ephemeral, owner-issued motion freshness enforced beside the BLE transport."""
import asyncio
import math
import secrets
import struct
import time

from .bluetooth_catalog import DATA

WATCHDOG = .250
MAX_RUN = 60.0


def command_for(action, parameters):
    if not isinstance(parameters, dict):
        raise ValueError('Motion parameters must be an object')
    if action == 'drive' and set(parameters) == {'left', 'right', 'flags'}:
        left, right, flags = (parameters[k] for k in ('left', 'right', 'flags'))
        if any(type(v) is not int or not 0 <= v <= 255 for v in (left, right)) or type(flags) is not int or flags not in (0, 8, 16, 24):
            raise ValueError('Invalid wheel demand')
        return 22, 8, bytes([left, right, flags])
    if action == 'dome' and set(parameters) == {'degrees'}:
        degrees = parameters['degrees']
        if type(degrees) not in (int, float) or not math.isfinite(degrees) or not -160 <= degrees <= 180:
            raise ValueError('Invalid dome target')
        return 23, 15, struct.pack('>f', degrees)
    if action == 'stance' and set(parameters) == {'stance'}:
        stance = parameters['stance']
        if stance not in ('two', 'three', 'waddle'):
            raise ValueError('Invalid stance')
        return 23, 13, bytes([{'two': 2, 'three': 1, 'waddle': 3}[stance]])
    if action == 'animation' and set(parameters) == {'animation_id'}:
        item = next((i for i in DATA['catalogs']['animations']['items'] if i['id'] == parameters['animation_id']), None)
        if item is None:
            raise ValueError('Unknown animation')
        return 23, 5, item['firmware_id'].to_bytes(2, 'big')
    if action == 'renew' and not parameters:
        return None
    raise ValueError('Unsupported motion command')


class MotionLease:
    def __init__(self, session, *, clock=time.monotonic):
        self.session, self.clock = session, clock
        self.owner = self.lease_id = self.token = None
        self.action = None
        self.expires = self.limit = self.deadline = 0.0
        self._timer = None
        self._opening = None
        self._cleanup = None
        self._sending = False
        self._started = False
        self.transition_owner = None

    @property
    def active(self):
        return self.lease_id is not None

    def revoke(self):
        self.owner = self.lease_id = self.token = self.action = None
        self._started = False
        if self._timer:
            self._timer.cancel()
            self._timer = None

    def _owns(self, owner, lease_id):
        if not self.active or self.owner != owner or self.lease_id != lease_id:
            raise ValueError('Motion lease was released or belongs to another controller')
        self.session._ready()

    async def open(self, owner):
        self.session._ready()
        if self._opening or self.active or self.session._stop_task:
            raise ValueError('Release the current motion owner before starting another action')
        marker = object()
        # stop() revokes every old command before this new owner is installed.
        self._opening = marker
        generation = self.session._generation
        self.transition_owner = owner
        try:
            if self.session.busy and not self.session.recoverable_stop:
                await self.session.stop()
                generation += 1
            # A second STOP or connection change invalidates this preparation.
            self.session._check(generation)
            self.session._ready()
            if self.active:
                raise ValueError('Motion owner changed while preparing')
            self.owner, self.lease_id = owner, secrets.token_hex(16)
            self.action = None
            self.limit = self.clock() + MAX_RUN
            challenge = self.challenge(owner, self.lease_id)
            self.deadline = self.expires
            self._arm_deadline()
            return {'lease_id': self.lease_id, **challenge}
        finally:
            self.transition_owner = None
            if self._opening is marker:
                self._opening = None

    def challenge(self, owner, lease_id):
        self._owns(owner, lease_id)
        now = self.clock()
        if now >= self.limit or self._started and now >= self.deadline:
            self._expire()
            raise ValueError('Motion lease expired; a fresh user action is required')
        self.token = secrets.token_hex(16)
        self.expires = min(now + WATCHDOG, self.limit)
        return {'token': self.token}

    def _arm_deadline(self):
        if self._timer:
            self._timer.cancel()
        self._timer = asyncio.get_running_loop().call_later(max(0, self.deadline - self.clock()), self._expire)

    def _expire(self):
        started = self._started
        self.revoke()
        if started:
            # Fence native reply/write continuations synchronously, before the
            # async STOP task can yield to another controller request.
            self.session._revoke('Motion watchdog or command canceled')
            self.session._publish(control='blocked', detail='Motion stopped; awaiting cleanup acknowledgment.')
            task = self._cleanup = asyncio.create_task(self.session.stop())
            task.add_done_callback(self.session._observe_background)

    async def command(self, owner, lease_id, token, action, parameters):
        wire = command_for(action, parameters)
        self._owns(owner, lease_id)
        if action == 'drive' and any(wire[2][:2]) and self.session._drive_stop_unconfirmed:
            raise RuntimeError('Wheel stop is unconfirmed. Retry STOP before driving.')
        if not isinstance(token, str) or self.token is None or not secrets.compare_digest(token, self.token):
            raise ValueError('Motion challenge was consumed or replaced')
        self.token = None
        now = self.clock()
        if now >= self.expires or now >= self.limit or self._started and now >= self.deadline:
            self._expire()
            raise ValueError('Motion challenge or watchdog expired before dispatch')
        if self.action and action not in (self.action, 'renew'):
            raise ValueError('Release the current motion before changing action')
        if action == 'renew' and not self._started:
            raise ValueError('No motion to renew')
        if self._sending:
            raise ValueError('Motion write is still in progress; demands cannot queue')
        self.deadline = self.expires
        self._started = True
        self._arm_deadline()
        if wire is None:
            return {'state': 'dispatched', 'confirmation': 'none', **self.challenge(owner, lease_id)}
        self.action = action
        if action == 'drive':
            self.session._drive_mode = 'tank'
        self._sending = True
        generation = self.session._generation
        try:
            telemetry = getattr(self.session, 'telemetry', None)
            if telemetry:
                telemetry.interrupt()
            async with asyncio.timeout(max(0, self.deadline - self.clock())):
                async with self.session._operations:
                    self._owns(owner, lease_id)
                    self.session._check(generation)
                    if self.clock() >= self.deadline:
                        raise TimeoutError('Motion expired waiting for GATT admission')
                    packet = await self.session._exchange(wire, generation)
            # Issue freshness for the next request without extending this command's watchdog.
            return {'state': 'dispatched', 'confirmation': 'ack', **self.challenge(owner, lease_id),
                    'evidence': {'did': packet['did'], 'cid': packet['cid'], 'sequence': packet['seq'], 'physical_completion': False}}
        except BaseException as error:
            if isinstance(error, TimeoutError):
                self.session._fail('Motion deadline elapsed; command outcome unconfirmed')
            # Stop even if the caller vanished after submitting an output write.
            if self.lease_id == lease_id:
                self._expire()
            raise
        finally:
            self._sending = False

    async def release(self, owner, lease_id):
        if self.lease_id is None:
            # Expiry schedules STOP before session.stop can install its own task.
            if self._cleanup:
                await asyncio.shield(self._cleanup)
            if self.session._stop_task:
                await asyncio.shield(self.session._stop_task)
            if self.session._fault:
                raise RuntimeError(self.session._fault)
            return {'state': 'completed'}
        self._owns(owner, lease_id)
        self.revoke()
        self.transition_owner = owner
        try:
            await self.session.stop()
            if self.session._fault:
                raise RuntimeError(self.session._fault)
            return {'state': 'completed'}
        finally:
            self.transition_owner = None
