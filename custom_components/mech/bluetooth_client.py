"""Home Assistant-owned Bluetooth sessions and durable semantic operations."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import hashlib
import json
import math
import time
from uuid import uuid4

from habluetooth import HaBleakClientWrapper
from bleak_retry_connector import establish_connection
from homeassistant.components import bluetooth
from homeassistant.helpers.storage import Store

from .api import APIError
from .bluetooth_protocol import CommandCancelled, DroidBluetoothSession, catalog, prepare


class PreferenceConflict(APIError):
    """Another client saved the shared preferences first."""


class BluetoothClient:
    def __init__(self, hass, entry, *, session_factory=DroidBluetoothSession, store=None):
        self.hass, self.entry = hass, entry
        self.address = entry.data['address']
        self.droid_id = entry.data['droid_ids'][0]
        self.name = entry.data.get('name', 'R2-D2')
        self._store = store or Store(hass, 1, f'mech.bluetooth.{entry.entry_id}', private=True)
        self._data = {'operations': {}, 'keys': {}, 'cooldowns': {}, 'fault': None,
                      'preferences': {'revision': 0, 'values': {}}}
        self._storage_lock = asyncio.Lock()
        self._ordinary_lock = asyncio.Lock()
        self._replacements = 0
        self._generation = 0
        self._listeners = set()
        self._closed = False
        self._owner_token = None
        self._background = set()
        self._admissions = {}
        self._tokens = 20.0
        self._rate_updated = time.monotonic()
        self.session = session_factory(self.address, self.name, self._connect, on_change=self._changed)

    async def async_initialize(self):
        saved = await self._store.async_load()
        if saved is not None:
            if not self._valid_storage(saved):
                raise APIError('Stored Bluetooth state is invalid; it was not overwritten')
            self._data = saved
            interrupted = False
            for operation in saved['operations'].values():
                if operation['state'] in {'accepted', 'running'}:
                    operation.update(state='interrupted', reason='Home Assistant restarted; action was not replayed')
                    interrupted = True
            if interrupted:
                await self._persist()

    def _valid_storage(self, saved):
        if not isinstance(saved, dict) or any(key not in saved for key in self._data):
            return False
        operations, keys, cooldowns, prefs = (saved[k] for k in ('operations', 'keys', 'cooldowns', 'preferences'))
        if not all(isinstance(value, dict) for value in (operations, keys, cooldowns, prefs)):
            return False
        if saved['fault'] is not None and not isinstance(saved['fault'], str):
            return False
        if type(prefs.get('revision')) is not int or prefs['revision'] < 0 or not isinstance(prefs.get('values'), dict):
            return False
        if any(not isinstance(k, str) or not isinstance(v, str) for k, v in prefs['values'].items()):
            return False
        if any(not isinstance(k, str) or type(v) not in (int, float) or not math.isfinite(v) for k, v in cooldowns.items()):
            return False
        states = {'accepted', 'running', 'interrupted', 'completed', 'dispatched', 'failed', 'skipped', 'expired', 'rejected'}
        for key, operation in operations.items():
            if not isinstance(operation, dict) or operation.get('operation_id') != key or operation.get('droid_id') != self.droid_id or operation.get('state') not in states:
                return False
        return all(isinstance(value, dict) and value.get('id') in operations and isinstance(value.get('digest'), str) for value in keys.values())

    async def _persist(self):
        async with self._storage_lock:
            await self._store.async_save(deepcopy(self._data))

    async def _record_admission(self, key):
        future = asyncio.get_running_loop().create_future()
        self._admissions[key] = future
        saved = False
        try:
            await self._persist()
            saved = True
        finally:
            future.set_result(saved)
            self._admissions.pop(key, None)

    def _check_droid(self, droid_id):
        if droid_id != self.droid_id:
            raise APIError('Droid is not enrolled in this integration entry')

    async def _connect(self, on_disconnect):
        if self._closed:
            raise APIError('Integration is unloading')
        owners = self.hass.data.setdefault('mech_bluetooth_owners', {})
        if self.address in owners and owners[self.address] is not self:
            raise APIError('Droid already has a Home Assistant session owner')
        # HA's cached device retains the local or proxy backend needed for GATT access.
        device = bluetooth.async_ble_device_from_address(self.hass, self.address, connectable=True)
        if device is None:
            raise APIError('Droid is not available through Home Assistant Bluetooth')
        owners[self.address] = self
        token = self._owner_token = object()
        establishing = True
        link_lost = False
        def lost(_client):
            nonlocal link_lost
            # A previous link can report disconnection after this client reconnects.
            if self._owner_token is not token or link_lost:
                return
            link_lost = True
            # Establishment can still be retrying; cleanup owns its reservation.
            if not establishing:
                self._owner_token = None
                if owners.get(self.address) is self:
                    owners.pop(self.address, None)
            on_disconnect()
        partial = None
        class OwnedClient(HaBleakClientWrapper):
            def __init__(inner_self, *args, **kwargs):
                nonlocal partial
                super().__init__(*args, **kwargs)
                partial = inner_self
        try:
            async with asyncio.timeout(20):
                client = await establish_connection(OwnedClient, device, self.name,
                    disconnected_callback=lost, max_attempts=1, pair=False)
            if self._closed:
                raise APIError('Integration unloaded while connecting')
            if link_lost or self._owner_token is not token:
                raise APIError('Bluetooth link lost while connecting')
            establishing = False
            return client
        except BaseException:
            try:
                if partial is not None:
                    cleanup = asyncio.create_task(partial.disconnect())
                    try:
                        async with asyncio.timeout(3):
                            await asyncio.shield(cleanup)
                    finally:
                        if not cleanup.done():
                            cleanup.cancel()
                        await asyncio.gather(cleanup, return_exceptions=True)
            finally:
                if self._owner_token is token:
                    self._owner_token = None
                    if owners.get(self.address) is self:
                        owners.pop(self.address, None)
            raise

    def _changed(self):
        if (self.session.snapshot().get('control') == 'failed' or self.session.snapshot().get('stop_failure')) and not self._data['fault']:
            self._data['fault'] = self.session.snapshot().get('detail') or 'Droid session failed'
            async def save_fault():
                try:
                    await self._persist()
                except Exception:
                    # A disk failure cannot prevent STOP or erase the in-memory latch.
                    pass
            task = self.hass.async_create_task(save_fault())
            self._track_background(task)
        for listener in tuple(self._listeners):
            listener()

    def subscribe(self, listener):
        self._listeners.add(listener)
        return lambda: self._listeners.discard(listener)

    def _track_background(self, task):
        self._background.add(task)

        def finished(done):
            self._background.discard(done)
            if not done.cancelled():
                done.exception()

        task.add_done_callback(finished)

    async def validate(self):
        return {'api_version': '1', 'instance_id': self.entry.data['instance_id']}

    async def droids(self):
        return [await self.snapshot(self.droid_id)]

    async def snapshot(self, droid_id):
        self._check_droid(droid_id)
        result = deepcopy(self.session.snapshot())
        if self._data['fault'] and not result.get('stop_failure'):
            result.update(control='failed', detail=self._data['fault'])
        return {'droid_id': self.droid_id, 'name': self.name, **result}

    @property
    def light_frame_generation(self):
        return (self._generation, self.session.control_generation)

    async def light_frame(self, droid_id, rgb):
        """Apply a transient visible-controller frame without durable history."""
        self._check_droid(droid_id)
        if not isinstance(rgb, list) or len(rgb) != 6 or any(type(v) is not int or not 0 <= v <= 255 for v in rgb):
            raise APIError('Expected six dome RGB bytes')
        if self._closed or self._data['fault'] and not getattr(self.session, 'recoverable_stop', False):
            raise APIError('Droid session failed or is unloading')
        if self._ordinary_lock.locked() or self._replacements:
            raise APIError('Droid is busy; light frames are not queued')
        now = time.monotonic()
        self._tokens = min(20.0, self._tokens + max(0, now - self._rate_updated) * 10)
        self._rate_updated = now
        if self._tokens < 1:
            raise APIError('Rate limit exceeded; STOP remains available')
        self._tokens -= 1
        plan = prepare('lights.apply', {'settings': dict(zip(
            ('front_dome_red', 'front_dome_green', 'front_dome_blue', 'rear_dome_red', 'rear_dome_green', 'rear_dome_blue'), rgb))}, {})
        # Uncontended acquisition does not yield; native execution fences STOP
        # and transport changes while waiting for the existing command lock.
        async with self._ordinary_lock:
            return await self.session.execute_prepared(plan)

    async def catalog(self, droid_id, kind):
        self._check_droid(droid_id)
        return deepcopy(catalog(kind, self._data['preferences']['values']))

    async def preferences(self, droid_id):
        self._check_droid(droid_id)
        return deepcopy(self._data['preferences'])

    async def save_preferences(self, droid_id, revision, values):
        self._check_droid(droid_id)
        if self._closed:
            raise APIError('Integration is unloading')
        if not isinstance(values, dict) or len(json.dumps(values)) > 262144 or any(
            not isinstance(k, str) or not isinstance(v, str) or k.startswith('service.') or
            k in {'connection.lifecycle.v1', 'battery.profiling.v1', '__proto__'} for k, v in values.items()
        ):
            raise APIError('Invalid shared preferences')
        # HA storage may finish its disk write after the request is canceled.
        # The revision and storage lock must settle together before another save.
        task = asyncio.create_task(self._save_preferences(revision, deepcopy(values)))
        self._track_background(task)
        return await asyncio.shield(task)

    async def _save_preferences(self, revision, values):
        async with self._storage_lock:
            if self._closed:
                raise APIError('Integration is unloading')
            previous = self._data['preferences']
            if type(revision) is not int or revision != previous['revision']:
                raise PreferenceConflict('Shared preferences changed; review before saving again')
            next_value = {'revision': revision + 1, 'values': deepcopy(values)}
            candidate = {**self._data, 'preferences': next_value}
            try:
                await self._store.async_save(deepcopy(candidate))
            except Exception:
                raise APIError('Could not save preferences') from None
            self._data['preferences'] = next_value
        self._changed()
        return deepcopy(next_value)

    async def operation(self, operation_id):
        if operation_id not in self._data['operations']:
            raise APIError('Unknown operation')
        return deepcopy(self._data['operations'][operation_id])

    @staticmethod
    def _policy(policy):
        if not isinstance(policy, dict) or set(policy) - {'if_unavailable', 'if_busy', 'expires_in_ms', 'cooldown_key', 'cooldown_ms'}:
            raise APIError('Invalid operation policy')
        value = {'if_unavailable': 'skip', 'if_busy': 'skip', 'expires_in_ms': 5000, 'cooldown_ms': 0, **policy}
        if value['if_unavailable'] not in {'skip', 'error', 'connect'} or value['if_busy'] not in {'skip', 'error', 'replace'}:
            raise APIError('Invalid operation policy')
        for key, low, high in [('expires_in_ms', 100, 30000), ('cooldown_ms', 0, 3600000)]:
            if type(value[key]) is not int or not low <= value[key] <= high:
                raise APIError('Invalid operation deadline or cooldown')
        if value['cooldown_ms'] and (not isinstance(value.get('cooldown_key'), str) or not 1 <= len(value['cooldown_key']) <= 128):
            raise APIError('A bounded cooldown key is required')
        return value

    async def submit(self, droid_id, action, parameters, policy=None, key=None):
        """Return a durable operation ID without holding the HA request open."""
        if action == 'activity.stop':
            return await self.operate(droid_id, action, parameters, policy, key)
        accepted = asyncio.get_running_loop().create_future()
        task = self.hass.async_create_task(self.operate(droid_id, action, parameters, policy, key, _accepted=accepted))
        self._track_background(task)
        await asyncio.wait({accepted, task}, return_when=asyncio.FIRST_COMPLETED)
        if accepted.done():
            return accepted.result()
        accepted.cancel()
        return task.result()

    async def operate(self, droid_id, action, parameters, policy=None, key=None, *, _accepted=None):
        started = time.monotonic()
        self._check_droid(droid_id)
        if self._closed:
            raise APIError('Integration is unloading')
        if not isinstance(parameters, dict):
            raise APIError('Parameters must be an object')
        policy = self._policy({} if policy is None else policy)
        key = uuid4().hex if key is None else key
        if not isinstance(key, str) or not 1 <= len(key) <= 128 or not key.isascii() or not key.isprintable():
            raise APIError('Invalid idempotency key')
        digest = hashlib.sha256(json.dumps([action, parameters, policy], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        previous = self._data['keys'].get(key)
        if previous:
            if previous['digest'] != digest:
                raise APIError('Idempotency key was already used for a different request')
            pending = self._admissions.get(key)
            if pending is not None and not await asyncio.shield(pending):
                raise APIError('Original operation admission could not be saved; no command was sent')
            return await self.operation(previous['id'])
        if action != 'activity.stop':
            now = time.monotonic()
            self._tokens = min(20.0, self._tokens + max(0, now - self._rate_updated) * 10)
            self._rate_updated = now
            if self._tokens < 1:
                raise APIError('Rate limit exceeded; STOP remains available')
            self._tokens -= 1
        lifecycle = action in {'connection.connect', 'connection.disconnect', 'activity.stop'}
        if lifecycle and parameters:
            raise APIError('Lifecycle actions do not accept parameters')
        if not lifecycle and action not in {'sound.play', 'lights.apply', 'protocol.run'}:
            raise APIError('Motion and unknown commands are unavailable through this integration')
        plan = None if lifecycle else prepare(action, deepcopy(parameters), self._data['preferences']['values'])
        if self._data['fault'] and not getattr(self.session, 'recoverable_stop', False) and not lifecycle:
            raise APIError('Droid session failed; no new activity is allowed')
        operation_id = uuid4().hex
        result = {'operation_id': operation_id, 'droid_id': droid_id, 'action': action,
                  'state': 'accepted', 'confirmation': 'none', 'parameters': deepcopy(parameters if plan is None else plan.parameters)}
        # STOP must reach the session even when persistence is broken or another action holds its lock.
        if action == 'activity.stop':
            self._data['operations'][operation_id] = result
            self._data['keys'][key] = {'id': operation_id, 'digest': digest}
            self._generation += 1

            async def finish_stop():
                try:
                    no_session = self.session.snapshot().get('stop_required') is False
                    await self.session.stop()
                    result.update(state='completed', confirmation='none' if no_session else 'ack')
                    if not no_session and self.session.snapshot().get('control') == 'ready' and not self.session.snapshot().get('stop_failure'):
                        self._data['fault'] = None
                    if self._data['fault']:
                        result.update(state='failed', reason=self._data['fault'])
                except Exception as error:
                    snapshot = self.session.snapshot()
                    self._data['fault'] = (self._data['fault'] or
                        (snapshot.get('detail') if snapshot.get('control') == 'failed' else None) or
                        str(error) or type(error).__name__)
                    result.update(state='failed', reason=str(error) or type(error).__name__)
                try:
                    await self._persist()
                except Exception:
                    result['durability'] = 'unavailable'
                self._changed()
                return deepcopy(result)

            # Cleanup retains its durable outcome after caller cancellation.
            # Eager scheduling revokes native activity before another action runs.
            task = asyncio.create_task(finish_stop(), eager_start=True)
            self._track_background(task)
            return await asyncio.shield(task)
        if len(self._data['operations']) >= 10000:
            raise APIError('Operation history is full; export and maintain it before new activity')
        busy = self._ordinary_lock.locked() or self._replacements
        replacing = busy and policy['if_busy'] == 'replace'
        if busy and not replacing:
            result.update(state='failed' if policy['if_busy'] == 'error' else 'skipped',
                          reason='Another operation is in progress')
            self._data['operations'][operation_id] = result
            self._data['keys'][key] = {'id': operation_id, 'digest': digest}
            try:
                await self._record_admission(key)
            except Exception:
                result['durability'] = 'unavailable'
            return deepcopy(result)
        if replacing:
            # A newer replacement invalidates older continuations before
            # persistence yields; wire work still requires durable admission.
            self._generation += 1
            self._replacements += 1
        generation = self._generation
        locked = False
        try:
            if not replacing:
                await self._ordinary_lock.acquire()
                locked = True
            self._data['operations'][operation_id] = result
            self._data['keys'][key] = {'id': operation_id, 'digest': digest}
            try:
                await self._record_admission(key)
            except Exception:
                self._data['operations'].pop(operation_id, None)
                self._data['keys'].pop(key, None)
                raise APIError('Operation could not be recorded; no command was sent') from None
            if _accepted is not None and not _accepted.done():
                _accepted.set_result(deepcopy(result))
            try:
                if replacing and generation == self._generation and time.monotonic() - started <= policy['expires_in_ms'] / 1000:
                    cooldown = policy.get('cooldown_key')
                    if cooldown and self._data['cooldowns'].get(cooldown, 0) > time.time():
                        result.update(state='skipped', reason='Cooldown active')
                    else:
                        # STOP revokes the running protocol without waiting for its
                        # ordinary lock. Its native cleanup barrier remains intact.
                        await self.session.stop()
                        remaining = policy['expires_in_ms'] / 1000 - (time.monotonic() - started)
                        if remaining > 0:
                            try:
                                async with asyncio.timeout(remaining):
                                    await self._ordinary_lock.acquire()
                                    locked = True
                            except TimeoutError:
                                result.update(state='expired', reason='Start deadline elapsed')
                        else:
                            result.update(state='expired', reason='Start deadline elapsed')
                if generation != self._generation:
                    result.update(state='interrupted', reason='Canceled by STOP')
                elif time.monotonic() - started > policy['expires_in_ms'] / 1000:
                    result.update(state='expired', reason='Start deadline elapsed')
                elif result['state'] != 'accepted':
                    pass
                elif self._data['fault'] and not getattr(self.session, 'recoverable_stop', False) and not lifecycle:
                    raise APIError('Droid session failed; no new activity is allowed')
                elif action == 'connection.connect':
                    await self.session.connect()
                    self._data['fault'] = None
                    result.update(state='completed', confirmation='ack')
                elif action == 'connection.disconnect':
                    await self.session.disconnect()
                    result.update(state='completed', confirmation='notification')
                    self._data['fault'] = None
                else:
                    await self._effect(plan, policy, result, generation, started)
            except CommandCancelled:
                result.update(state='interrupted', reason='Canceled by STOP or session change')
            except asyncio.CancelledError:
                result.update(state='interrupted', reason='Operation canceled; action was not replayed')
                try:
                    await self._persist()
                except Exception:
                    result['durability'] = 'unavailable'
                raise
            except Exception as error:
                reason = str(error) or type(error).__name__
                result.update(state='failed', reason=reason)
                snapshot = self.session.snapshot()
                if snapshot.get('control') == 'failed':
                    self._data['fault'] = self._data['fault'] or snapshot.get('detail') or reason
            try:
                await self._persist()
            except Exception:
                result['durability'] = 'unavailable'
            self._changed()
            return deepcopy(result)
        finally:
            if locked:
                self._ordinary_lock.release()
            if replacing:
                self._replacements -= 1

    async def _effect(self, plan, policy, result, generation, started):
        cooldown = policy.get('cooldown_key')
        if cooldown and self._data['cooldowns'].get(cooldown, 0) > time.time():
            result.update(state='skipped', reason='Cooldown active')
            return
        if self.session.snapshot()['connection'] != 'connected':
            if policy['if_unavailable'] == 'connect':
                if not self.entry.data.get('automation_wake', False):
                    raise APIError('Automatic connection is disabled; use explicit Connect')
                await self.session.connect()
            elif policy['if_unavailable'] == 'error':
                raise APIError('Droid is disconnected')
            else:
                result.update(state='skipped', reason='Droid is disconnected')
                return
        if self.session.busy and not getattr(self.session, 'recoverable_stop', False):
            if policy['if_busy'] == 'replace':
                await self.session.stop()
            elif policy['if_busy'] == 'error':
                raise APIError('Droid is busy')
            else:
                result.update(state='skipped', reason='Droid is busy')
                return
        if generation != self._generation:
            result.update(state='interrupted', reason='Canceled by STOP')
            return
        if time.monotonic() - started > policy['expires_in_ms'] / 1000:
            result.update(state='expired', reason='Start deadline elapsed')
            return
        previous_cooldown = self._data['cooldowns'].get(cooldown)
        reserved = bool(cooldown and policy['cooldown_ms'])
        dispatched = False
        try:
            if reserved:
                self._data['cooldowns'][cooldown] = time.time() + policy['cooldown_ms'] / 1000
            result['state'] = 'running'
            # Resolved parameters and cooldown must be durable before the first effect write.
            await self._persist()
            if generation != self._generation:
                result.update(state='interrupted', reason='Canceled by STOP')
                return
            if time.monotonic() - started > policy['expires_in_ms'] / 1000:
                result.update(state='expired', reason='Start deadline elapsed')
                return
            # Once execution begins, a lost reply or cancellation can leave the
            # wire outcome uncertain. Retain its durable cooldown in that case.
            dispatched = True
            result.update(await self.session.execute_prepared(plan))
        finally:
            if reserved and not dispatched:
                if previous_cooldown is None:
                    self._data['cooldowns'].pop(cooldown, None)
                else:
                    self._data['cooldowns'][cooldown] = previous_cooldown

    async def async_close(self):
        self._closed = True
        self._generation += 1
        try:
            await self.session.close()
        except BaseException as error:
            self._data['fault'] = self._data['fault'] or str(error)
            try:
                await self._persist()
            except Exception:
                pass
            raise
        finally:
            self._owner_token = None
            owners = self.hass.data.get('mech_bluetooth_owners', {})
            if owners.get(self.address) is self:
                owners.pop(self.address, None)
            self._listeners.clear()
            if self._background:
                await asyncio.gather(*(asyncio.shield(task) for task in tuple(self._background)), return_exceptions=True)
