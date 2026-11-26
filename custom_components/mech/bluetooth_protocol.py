"""Native Sphero API-v2 transport; no discovery, reconnect or action replay."""
from __future__ import annotations


def encode_packet(did: int, cid: int, data: bytes, seq: int, flags: int = 0x0a,
                  error: int = 0, target: int | None = None, source: int | None = None) -> bytes:
    body = bytes([flags] + ([target] if flags & 16 else []) + ([source] if flags & 32 else [])
                 + [did, cid, seq] + ([error] if flags & 1 else [])) + bytes(data)
    body += bytes([(~sum(body)) & 255])
    escaped = {0x8d: b'\xab\x05', 0xd8: b'\xab\x50', 0xab: b'\xab\x23'}
    return b'\x8d' + b''.join(escaped.get(value, bytes([value])) for value in body) + b'\xd8'


class PacketDecoder:
    """Decode arbitrary notification fragments, dropping corrupt frames."""
    def __init__(self):
        self.reset()

    def reset(self):
        self.body = bytearray()
        self.active = self.escaped = False

    def push(self, data: bytes) -> list[dict]:
        packets = []
        for value in data:
            if value == 0x8d:
                self.reset()
                self.active = True
                continue
            if not self.active:
                continue
            if value == 0xd8:
                if not self.escaped:
                    packet = self._finish()
                    if packet is not None:
                        packets.append(packet)
                self.reset()
                continue
            if self.escaped:
                value = {5: 0x8d, 80: 0xd8, 35: 0xab}.get(value)
                if value is None:
                    self.reset()
                    continue
                self.escaped = False
            elif value == 0xab:
                self.escaped = True
                continue
            self.body.append(value)
            if len(self.body) > 65536:
                self.reset()
        return packets

    def _finish(self):
        body = self.body
        if len(body) < 5 or sum(body) & 255 != 255:
            return None
        flags, index = body[0], 1
        packet = {'flags': flags}
        for bit, name in [(16, 'target'), (32, 'source')]:
            if flags & bit:
                if index >= len(body):
                    return None
                packet[name] = body[index]
                index += 1
        if len(body) < index + 4 + bool(flags & 1):
            return None
        packet.update(did=body[index], cid=body[index + 1], seq=body[index + 2])
        index += 3
        if flags & 1:
            packet['error'] = body[index]
            index += 1
        packet['data'] = bytes(body[index:-1])
        return packet

from .bluetooth_catalog import DATA, PreparedAction, catalog, prepare
from .bluetooth_motion import MotionLease
from .bluetooth_telemetry import CockpitTelemetry

import asyncio
from typing import Callable

API = '00010002-574f-4f20-5370-6865726f2121'
INFORMATION = '00020004-574f-4f20-5370-6865726f2121'
INITIALIZATION = '00020005-574f-4f20-5370-6865726f2121'
CONTROL = '00020002-574f-4f20-5370-6865726f2121'


class CommandCancelled(RuntimeError):
    """An explicit STOP, sleep, or transport change revoked this command."""


class DroidResponseError(RuntimeError):
    def __init__(self, packet):
        self.packet = packet
        super().__init__(f"Droid error {packet['error']} ({packet['did']}/{packet['cid']})")


def _command(value):
    return value['did'], value['cid'], bytes(value['data'])


class DroidBluetoothSession:
    """One explicit HA-owned Bleak session with response-confirmed safety cleanup.

    The connector must return an already-connected client and install its supplied
    disconnect callback. Construction and reads never access Bluetooth. STOP fences
    intent before waiting for the current GATT transaction; motion has its own lease.
    """
    def __init__(self, address: str, name: str, connector, on_change: Callable | None = None,
                 *, timeout: float = 5.0, sleep_timeout: float = 15.0, connect_timeout: float = 20.0):
        self.address, self.name, self.connector = address, name, connector
        self.on_change = on_change
        self.timeout, self.sleep_timeout = timeout, sleep_timeout
        self.connect_timeout = connect_timeout
        self.client = None
        self._connection_token = None
        self._state = dict(connection='disconnected', power='unknown', control='blocked',
                           battery_voltage=None, detail='Disconnected. Connect explicitly to wake this droid.')
        self._fault = None
        self._stop_failure = None
        self._drive_stop_unconfirmed = False
        self._sleep_after_failure = False
        self._generation = 0
        self._sequence = 1
        self._retired = set()
        self._decoder = PacketDecoder()
        self._pending = None
        self._writes = asyncio.Lock()
        self._operations = asyncio.Lock()
        self._revoked = asyncio.Event()
        self._sleep_event = asyncio.Event()
        self._stop_task = None
        self._transport_close = None
        self._connecting = None
        self._maintenance_task = None
        self.maintenance_interval = 30.0
        self._closed = False
        self._activity = None
        self._unknown_sources = True
        self._ram_touched = False
        self._firmware_verified = False
        self._count = 0
        self._stop_required = False
        self.motion = MotionLease(self)
        self._drive_mode = 'heading'
        self.telemetry = CockpitTelemetry(self)

    @property
    def can_sleep_after_failure(self):
        return bool(self._sleep_after_failure and self.client and self.client.is_connected)

    @property
    def recoverable_stop(self):
        return bool(self._stop_failure and self.client and self.client.is_connected and
                    self._state['power'] == 'awake' and self._state['control'] == 'failed' and not self._closed)

    @property
    def busy(self):
        return bool(self._count or self._stop_task or self._activity or self.motion.active or
                    self._state['connection'] == 'connected' and self._unknown_sources)

    def snapshot(self):
        return {**self._state, **self.telemetry.snapshot(),
                'stop_required': self._stop_required or self._state['connection'] != 'disconnected',
                'drive_stop_unconfirmed': self._drive_stop_unconfirmed,
                **({'control': 'ready', 'detail': self._stop_failure, 'stop_failure': self._stop_failure}
                   if self.recoverable_stop else {'control': 'failed', 'detail': self._fault} if self._fault else {})}

    def _publish(self, **values):
        self._state.update(values)
        if self.on_change:
            self.on_change()

    def _fail(self, message):
        # Only acknowledged cleanup or sleep can resolve an uncertain outcome.
        self._fault = self._fault or str(message)
        self._publish(control='failed', detail=self._fault)

    def _check(self, generation):
        if generation != self._generation or self._closed:
            raise CommandCancelled('Command canceled by STOP or connection change')

    def _ready(self):
        if self._fault and not self.recoverable_stop:
            raise RuntimeError(self._fault)
        if self._closed or self._state['connection'] != 'connected' or self._state['power'] != 'awake' or self._state['control'] != 'ready' and not self.recoverable_stop:
            raise RuntimeError('Droid is not ready')

    @property
    def control_generation(self):
        return self._generation

    def _revoke(self, message):
        self.motion.revoke()
        self.telemetry.invalidate()
        self._generation += 1
        self._revoked.set()
        self._revoked = asyncio.Event()
        if self._pending:
            did, cid, seq, future = self._pending
            self._retired.add(seq)
            self._pending = None
            if not future.done():
                future.set_exception(CommandCancelled(message))
        return self._generation

    def _next_sequence(self):
        for _ in range(254):
            value = self._sequence
            self._sequence = value % 254 + 1
            if value not in self._retired:
                return value
        raise RuntimeError('Reconnect required: response sequences exhausted')

    async def _bounded(self, work):
        async with asyncio.timeout(self.timeout):
            return await work

    async def _write(self, frame, generation):
        # STOP does not wait for an unanswered normal API command, but cannot
        # interrupt a GATT transaction already submitted to the proxy.
        async with self._writes:
            for offset in range(0, len(frame), 20):
                self._check(generation)
                if not self.client or not self.client.is_connected:
                    raise RuntimeError('Bluetooth disconnected')
                await self._bounded(self.client.write_gatt_char(API, frame[offset:offset + 20], response=True))

    async def _exchange(self, command, generation, seq=None):
        self._check(generation)
        did, cid, data = command
        seq = self._next_sequence() if seq is None else seq
        future = asyncio.get_running_loop().create_future()
        self._pending = (did, cid, seq, future)
        try:
            async with asyncio.timeout(self.timeout):
                await self._write(encode_packet(did, cid, data, seq), generation)
                packet = await future
                self._check(generation)
                return packet
        except DroidResponseError:
            # A checksum-valid reply matching DID, CID and sequence completed
            # this exchange, even when its negative result is optional to STOP.
            raise
        except BaseException:
            self._retired.add(seq)
            raise
        finally:
            if self._pending and self._pending[3] is future:
                self._pending = None
            if not future.done():
                future.cancel()
            elif not future.cancelled():
                # A disconnect may reject while an in-flight write also fails.
                future.exception()

    def _receive(self, sender, data):
        for packet in self._decoder.push(bytes(data)):
            if self._state['connection'] == 'disconnected':
                continue
            self.telemetry.accept(packet)
            pending = self._pending
            if packet['flags'] & 1:
                if pending and (packet['did'], packet['cid'], packet['seq']) == pending[:3]:
                    self._pending = None
                    future = pending[3]
                    if not future.done():
                        if packet.get('error'):
                            future.set_exception(DroidResponseError(packet))
                        else:
                            future.set_result(packet)
                            if (packet['did'], packet['cid']) == (19, 3) and len(packet['data']) == 2:
                                volts = int.from_bytes(packet['data'], 'big') / 100
                                if volts > 0:
                                    self._publish(battery_voltage=volts)
                continue
            if packet['did'] == 19 and packet['cid'] == 26 and not packet['data']:
                self._stop_required = False
                self._fault = self._stop_failure = None
                self._drive_stop_unconfirmed = False
                self._cancel_maintenance()
                self._sleep_event.set()
                self._revoke('Droid did sleep')
                self._activity = None
                self._publish(power='asleep', control='blocked', detail='Normal sleep completion notification received.')
                self._start_transport_close()
            elif packet['did'] == 19 and packet['cid'] == 25 and not packet['data']:
                # Inactivity warning is not sleep completion. Preserve Bluetooth
                # while stopping firmware sources; never replay on later packets.
                self._publish(power='sleep-pending', control='blocked', detail='Droid will sleep; stopping local activity.')
                task = asyncio.create_task(self.stop())
                task.add_done_callback(self._observe_background)
            elif packet['did'] == 19 and packet['cid'] == 6 and len(packet['data']) == 1:
                self._publish(battery_state=packet['data'][0])

    @staticmethod
    def _observe_background(task):
        if not task.cancelled():
            task.exception()

    def _cancel_maintenance(self):
        task, self._maintenance_task = self._maintenance_task, None
        if task and task is not asyncio.current_task():
            task.cancel()

    async def _maintain_connection(self):
        # Match SessionState's 30-second empty ping. It maintains only an
        # explicitly opened, healthy session and cannot wake or rearm anything.
        while not self._closed and not self._fault:
            await asyncio.sleep(self.maintenance_interval)
            if self._count or self._stop_task or self.motion.active or self._operations.locked():
                continue
            if self._state['connection'] != 'connected' or self._state['power'] != 'awake' or self._state['control'] != 'ready':
                return
            generation = self._generation
            try:
                async with self._operations:
                    self._check(generation)
                    await self._exchange((16, 0, b''), generation)
            except CommandCancelled:
                continue
            except asyncio.CancelledError:
                raise
            except Exception as error:
                self._fail(f'Connection keepalive failed: {error}')
                try:
                    await self.stop()
                except Exception:
                    return
                # Confirmed cleanup restores an idle connection, not motion.
                # This task is still running, so stop() cannot replace it.
                continue

    def _on_disconnect(self, *_):
        self._cancel_maintenance()
        self._revoke('Bluetooth disconnected')
        self._decoder.reset()
        self.telemetry.invalidate(disconnected=True)
        self._activity = None
        self._firmware_verified = False
        self._publish(connection='disconnected', power='asleep' if self._sleep_event.is_set() else 'unknown',
                      control='blocked', battery_voltage=None,
                      detail='Droid asleep.' if self._sleep_event.is_set() else 'Bluetooth disconnected. Physical state unconfirmed; no activity resumes.')

    def _start_transport_close(self):
        if self._transport_close is None:
            client = self.client
            async def close_transport():
                if client and client.is_connected:
                    await self._bounded(client.disconnect())
                if self.client is client:
                    self._on_disconnect()
            self._transport_close = asyncio.create_task(close_transport())
            self._transport_close.add_done_callback(self._observe_background)
        return self._transport_close

    async def connect(self):
        if self._closed or self._fault and self.client and self.client.is_connected:
            raise RuntimeError(self._fault or 'Session closed')
        if self._state['connection'] == 'connected' and self._state['control'] == 'ready':
            return
        if self._connecting or self._count or self._stop_task:
            raise RuntimeError('Connection transition already in progress')
        self._connecting = asyncio.current_task()
        self._count += 1
        generation = self._generation
        self._publish(connection='connecting', control='blocked', power='unknown', battery_voltage=None, detail='Connecting explicitly through Home Assistant Bluetooth.')
        token = self._connection_token = object()
        wake_started = False
        def disconnected(*args):
            if self._connection_token is token:
                self._on_disconnect(*args)
        def received(sender, data):
            if self._connection_token is token:
                self._receive(sender, data)
        try:
            async with asyncio.timeout(self.connect_timeout):
                client = await self.connector(disconnected)
            self.client = client
            self._transport_close = None
            self._check(generation)
            self._decoder.reset()
            self._sequence, self._retired = 1, set()
            self._sleep_event.clear()
            self._firmware_verified = self._ram_touched = False
            self._unknown_sources = True
            await self._bounded(client.write_gatt_char(INITIALIZATION, b'usetheforce...band', response=True))
            self._check(generation)
            await self._bounded(client.start_notify(CONTROL, lambda *_: None))
            self._check(generation)
            info = bytes(await self._bounded(client.read_gatt_char(INFORMATION)))
            self._check(generation)
            if len(info) >= 8 and (info[6] == 1 or (info[6] == 0 and info[3] == 1)):
                raise RuntimeError('Droid application is corrupt; initialization stopped')
            running = len(info) >= 8 and (info[4] if info[6] == 0 else info[7]) == 2
            if not running:
                await self._bounded(client.write_gatt_char(CONTROL, b'\x1e', response=True))
                raise RuntimeError('Application restart requested. Explicit reconnect is required; no wake or action replay.')
            await self._bounded(client.start_notify(API, received))
            await asyncio.sleep(0.1)
            self._check(generation)
            wake_started = True
            self._stop_required = True
            await self._exchange((19, 13, b''), generation, seq=0)
            warnings = []
            for command in [(17, 0, b''), (17, 3, b''), (19, 3, b''), (19, 4, b'')]:
                try:
                    packet = await self._exchange(command, generation)
                    if command[:2] == (17, 0):
                        self._firmware_verified = packet['data'] == bytes([0, 7, 0, 0, 0, 101])
                except DroidResponseError as error:
                    if error.packet['error'] not in (1, 2, 3):
                        raise
                    warnings.append(str(error))
            self._check(generation)
            try:
                await self._confirmed_cleanup(generation)
            except DroidResponseError as error:
                if (error.packet['did'], error.packet['cid'], error.packet['error']) == (23, 13, 4):
                    self._sleep_after_failure = True
                    self._publish(connection='connected', power='awake')
                raise
            self._fault = self._stop_failure = None
            self._publish(connection='connected', power='awake', control='ready',
                          detail='Wake and compatibility checks completed. Controls ready.' + (' Optional checks: ' + '; '.join(warnings) if warnings else ''))
            self._maintenance_task = asyncio.create_task(self._maintain_connection())
            self._maintenance_task.add_done_callback(self._observe_background)
        except BaseException as error:
            if wake_started:
                self._fail(f'Connection failed after wake started: {error}')
            else:
                # Availability and application-start failures precede any wake
                # intent. They can be retried only by a later explicit Connect.
                self._publish(control='blocked', detail=f'Connection unavailable before wake: {error}')
            if self.client and self.client.is_connected and not self.can_sleep_after_failure:
                await self._start_transport_close()
            elif not self.client or not self.client.is_connected:
                self._publish(connection='disconnected')
            raise
        finally:
            self._connecting = None
            self._count -= 1
            self._publish()

    async def _pause(self, seconds, generation):
        self._check(generation)
        event = self._revoked
        try:
            await asyncio.wait_for(event.wait(), seconds)
        except TimeoutError:
            self._check(generation)
            return
        raise CommandCancelled('Local schedule canceled by STOP or connection change')

    def _safety_commands(self):
        commands = ([_command(DATA['cancel_lights']), _command(DATA['release_lights'])] if self._ram_touched else [])
        stops = [_command(value) for value in DATA['stop_plan']]
        if self._drive_mode == 'tank':
            stops = [(22, 8, bytes(3)) if item[:2] == (22, 7) else item for item in stops]
        return commands + stops

    async def _stop_exchange(self, command, generation):
        did, cid, data = command
        zero_drive = (did, cid, len(data)) in {(22, 1, 4), (22, 7, 4), (22, 8, 3)} and not any(data)
        # Firmware can report 8 while changing stance. Retry only zero output,
        # requiring its ACK within one original deadline, including every write.
        last_error = None
        try:
            async with asyncio.timeout(self.timeout):
                while True:
                    try:
                        return await self._exchange(command, generation)
                    except DroidResponseError as error:
                        if not zero_drive or error.packet['error'] != 8:
                            raise
                        last_error = error
                        await self._pause(0.1, generation)
        except TimeoutError as error:
            if not zero_drive:
                raise
            detail = f'Zero-speed STOP {did}/{cid} was not acknowledged within {self.timeout:g}s'
            if last_error is not None:
                detail += f' after {last_error}'
            raise TimeoutError(detail) from error

    async def _confirmed_cleanup(self, generation):
        release = self._ram_touched
        failures = []
        commands = self._safety_commands()
        drive_pending = {c[:2] for c in commands if c[0] == 22 or c[0] == 23 and c[1] in (10, 43, 45, 47)}
        self._drive_stop_unconfirmed = bool(drive_pending)
        for command in commands:
            try:
                await self._stop_exchange(command, generation)
            except DroidResponseError as error:
                # Only a matching bad-CID on these optional disabled behaviors
                # establishes absence. Mandatory stops and ambiguous errors fail.
                if not (error.packet['error'] == 2 and command[0] == 23 and command[1] in (10, 45, 47) and command[2] == b'\x00'):
                    failures.append(error)
                    continue
            drive_pending.discard(command[:2])
            self._drive_stop_unconfirmed = bool(drive_pending)
        self._check(generation)
        if failures:
            # The low-battery sleep exception applies only to leg hold alone.
            raise next((e for e in failures if (e.packet['did'], e.packet['cid'], e.packet['error']) != (23, 13, 4)), failures[0])
        if release:
            await self._pause(1.6, generation)
        self._ram_touched = False
        self._unknown_sources = False
        self._activity = None

    async def stop(self):
        if self._closed:
            raise RuntimeError('Session closed')
        if not self.snapshot()['stop_required'] and not self._fault:
            # No session was opened, or sleep was confirmed and transport closed.
            # A genuine transport loss retains stop_required and fails closed.
            self._revoke('Offline control released')
            return
        if self._stop_task:
            return await asyncio.shield(self._stop_task)
        # Synchronous revocation occurs before any await or lock acquisition.
        generation = self._revoke('Command canceled by STOP')
        self._drive_stop_unconfirmed = True
        async def run():
            self._publish(control='blocked', detail='STOP requested; waiting for matching cleanup replies.')
            try:
                if self._connecting:
                    await self._connecting
                    return
                if not self.client or not self.client.is_connected:
                    raise RuntimeError('No connection. STOP delivery cannot be confirmed')
                immediate = self._safety_commands()
                if self._drive_mode == 'tank':
                    immediate = [(22, 8, bytes(3))] + [c for c in immediate if c[:2] != (22, 8)]
                for command in immediate:
                    await self._write(encode_packet(*command, 255, flags=8), generation)
                await self._confirmed_cleanup(generation)
                self._check(generation)
                self._fault = None
                self._stop_failure = None
                self.motion._cleanup = None
                self._sleep_after_failure = False
                self._publish(control='ready' if self._state['power'] == 'awake' else 'blocked', detail='STOP cleanup acknowledged. Motion remains disarmed.')
                if self._state['power'] == 'awake' and (self._maintenance_task is None or self._maintenance_task.done()):
                    self._maintenance_task = asyncio.create_task(self._maintain_connection())
                    self._maintenance_task.add_done_callback(self._observe_background)
            except BaseException as error:
                if generation != self._generation:
                    raise
                low_battery = isinstance(error, DroidResponseError) and (error.packet['did'], error.packet['cid'], error.packet['error']) == (23, 13, 4)
                self._sleep_after_failure = bool(low_battery and (not self._fault or self._sleep_after_failure))
                self._stop_failure = f'STOP unconfirmed: {error or type(error).__name__}'
                self._fail(f'STOP failed or unconfirmed: {error}')
                raise
        task = self._stop_task = asyncio.create_task(run())
        def finished(completed):
            self._observe_background(completed)
            if self._stop_task is completed:
                self._stop_task = None
                self._publish()
        task.add_done_callback(finished)
        return await asyncio.shield(task)

    async def execute(self, action, parameters, preferences=None):
        return await self.execute_prepared(prepare(action, parameters, preferences))

    async def execute_prepared(self, plan: PreparedAction):
        self.telemetry.interrupt()
        self._ready()
        if self._stop_task or self.motion.active:
            raise RuntimeError('STOP or manual motion is in progress')
        generation = self._generation
        self._count += 1
        try:
            async with self._operations:
                self._check(generation)
                self._ready()
                if not self.recoverable_stop and (self._unknown_sources or plan.action == 'protocol.run' or (self._ram_touched and plan.action == 'lights.apply')):
                    await self._confirmed_cleanup(generation)
                if plan.action == 'protocol.run':
                    if not self._firmware_verified:
                        packet = await self._exchange((17, 0, b''), generation)
                        if packet['data'] != bytes([0, 7, 0, 0, 0, 101]):
                            raise ValueError('Device-RAM lights require verified Nordic 7.0.101 firmware')
                        self._firmware_verified = True
                    self._ram_touched = True
                packet = await self._exchange(plan.command, generation)
                if plan.action == 'sound.play':
                    self._activity = 'audio'
                if plan.action == 'protocol.run':
                    self._activity = 'device-lights'
                    await self._pause(plan.duration_ms / 1000 + 0.1, generation)
                    await self._exchange(_command(DATA['cancel_lights']), generation)
                    await self._exchange(_command(DATA['release_lights']), generation)
                    await self._pause(1.6, generation)
                    self._ram_touched = False
                    self._activity = None
                    evidence = {'cleanup_acknowledged': True, 'physical_completion': False}
                else:
                    evidence = {'did': packet['did'], 'cid': packet['cid'], 'sequence': packet['seq']}
                return {'state': 'dispatched', 'confirmation': 'ack', 'evidence': evidence}
        except CommandCancelled:
            raise
        except (ValueError, DroidResponseError):
            # Matching rejection is evidence of rejection, never execution.
            self._unknown_sources = True
            raise
        except BaseException as error:
            self._fail(f'Command outcome unconfirmed: {error}')
            raise
        finally:
            self._count -= 1
            self._publish()

    async def disconnect(self):
        if self._closed or not self.client or not self.client.is_connected:
            raise RuntimeError('No connection. Sleep cannot be confirmed')
        self._count += 1
        try:
            try:
                await self.stop()
            except DroidResponseError as error:
                # Audited low-battery exception: leg hold can be rejected while
                # normal power-down remains necessary. Keep the failure latched.
                if (error.packet['did'], error.packet['cid'], error.packet['error']) != (23, 13, 4):
                    raise
            generation = self._generation
            self._sleep_event.clear()
            self._publish(power='sleep-requested', control='blocked', detail='Waiting for normal did-sleep notification.')
            try:
                await self._exchange((19, 1, b''), generation)
            except Exception:
                if not self._sleep_event.is_set():
                    raise
            await asyncio.wait_for(self._sleep_event.wait(), self.sleep_timeout)
            await self._start_transport_close()
            return {'state': 'completed', 'confirmation': 'notification', 'evidence': {'did': 19, 'cid': 26}}
        except BaseException as error:
            self._sleep_after_failure = False
            self._fail(f'Sleep failed or unconfirmed: {error}. Physical state remains unconfirmed.')
            raise
        finally:
            self._count -= 1

    async def close(self):
        """Explicit HA unload: bounded cleanup and closure, never claim sleep."""
        if self._closed:
            return
        self._cancel_maintenance()
        try:
            try:
                if self._connecting or (self.client and self.client.is_connected):
                    await self.stop()
            finally:
                # Unload releases GATT even when cleanup failed; propagate the
                # failure so the HA facade can persist it before disposal.
                if self.client:
                    await self._start_transport_close()
        finally:
            self._revoke('Session closed')
            self._closed = True
            self.telemetry.invalidate(disconnected=True)
            self._publish(connection='disconnected', control='blocked')
