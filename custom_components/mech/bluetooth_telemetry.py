"""Demand-driven cockpit telemetry, sharing the session's single reply slot.

Wire layouts match core/cockpitTelemetry.ts, sensors.ts and service.ts. Optional
observation never wakes a droid, reconnects it, or waits ahead of motion/STOP.
"""
from __future__ import annotations

import asyncio
import math
import struct
import time

FIELDS = ('attitude.pitch', 'attitude.roll', 'attitude.yaw',
          'accelerometer.x', 'accelerometer.y', 'accelerometer.z',
          'rawGyroscope.x', 'rawGyroscope.y', 'rawGyroscope.z', 'processorTemperature')
MASK = 0x7FC01
QUERIES = ((24, 9, 5), (24, 8, 10), (23, 20, 5), (23, 22, 5), (19, 3, 60), (17, 14, 60))


def _reply(packet, did, cid, length):
    if (packet.get('did'), packet.get('cid')) != (did, cid) or not packet.get('flags', 0) & 1 or packet.get('error') or len(packet.get('data', b'')) != length:
        raise ValueError('Sensor readback identity/status/length mismatch')
    return packet['data']


def decode_reading(packet):
    """Decode signed wheel counters, ADCs, positions, voltage and CPU readback."""
    key = packet.get('did'), packet.get('cid')
    formats = {(24, 9): ('>hh', ('encoder.0', 'encoder.1')),
               (24, 8): ('>HH', ('shoulder.adc', 'dome.adc')),
               (23, 20): ('>f', ('dome.degrees',)),
               (23, 22): ('>f', ('stance.position',)),
               (19, 3): ('>H', ('battery.volts',)),
               (17, 14): ('>i', ('processor.celsius',))}
    if key not in formats:
        raise ValueError('Unsupported cockpit readback')
    fmt, names = formats[key]
    values = struct.unpack(fmt, _reply(packet, *key, struct.calcsize(fmt)))
    if not all(math.isfinite(value) for value in values):
        raise ValueError('Sensor reading must be finite')
    result = dict(zip(names, values))
    if key == (19, 3):
        result['battery.volts'] /= 100
    return result


class CockpitTelemetry:
    """One aggregated UI demand; the caller expires inactive panel leases."""
    def __init__(self, session):
        self.session = session
        self._demand = False
        self._timer = self._inflight = None
        self._verified = self._owned = self._attempted = False
        self._busy = False
        self._status = None
        self._index = 0
        self._due = {}
        self._unsupported = set()
        self._readings = {}
        self._sensors = dict(status='not streaming', values={}, invalid=0,
                             intervalMs=1000, schemaEpoch=0)

    def snapshot(self):
        return dict(sensors={**self._sensors, 'values': dict(self._sensors['values'])},
                    cockpitReadings={key: dict(value) for key, value in self._readings.items()},
                    # Optional HA reads are preemptible; setup must never disable
                    # the cockpit controls that can preempt their pending reply.
                    cockpitTelemetryStatus=self._status, cockpitTelemetryBusy=False)

    def _publish(self):
        self.session._publish()

    def set_demand(self, active):
        self._demand = bool(active)
        if (self._demand or self._owned) and (self._timer is None or self._timer.done()):
            self._timer = asyncio.create_task(self._run())
            self._timer.add_done_callback(self.session._observe_background)
        if not active:
            self.interrupt()

    def interrupt(self):
        """User commands preempt an optional outstanding response before locking."""
        if self._inflight and self._inflight is not asyncio.current_task():
            self._inflight.cancel()

    def invalidate(self, *, disconnected=False):
        self.interrupt()
        if disconnected:
            if self._timer:
                self._timer.cancel()
                self._timer = None
            self._verified = self._owned = self._attempted = False
            self._due.clear()
            self._unsupported.clear()
            self._index = 0
            self._readings = {}
            self._sensors = dict(status='stale · disconnected', values={}, invalid=0,
                                 intervalMs=1000, schemaEpoch=self._sensors['schemaEpoch'])
            self._status = None
            self._busy = False

    async def _run(self):
        while not self.session._closed and (self._demand or self._owned):
            task = asyncio.create_task(self.refresh())
            try:
                await task
            except asyncio.CancelledError:
                if asyncio.current_task().cancelling():
                    raise
            await asyncio.sleep(1)

    def _idle(self):
        s = self.session
        return (not s._closed and not s._fault and s.client is not None and s.client.is_connected
                and s._state['connection'] == 'connected' and s._state['power'] == 'awake'
                and s._state['control'] == 'ready' and not s._count and not s._stop_task
                and s._activity in (None, 'audio') and not s._unknown_sources
                and not getattr(getattr(s, 'motion', None), 'active', False))

    async def refresh(self):
        s = self.session
        if self._inflight or not self._idle() or s._operations.locked() or not (self._demand or self._owned):
            return
        self._inflight = asyncio.current_task()
        generation = s._generation
        try:
            async with s._operations:
                async def execute(command):
                    s._check(generation)
                    if not self._idle():
                        raise asyncio.CancelledError()
                    packet = await s._exchange(command, generation)
                    s._check(generation)
                    if not self._idle():
                        raise asyncio.CancelledError()
                    return packet
                if not self._demand:
                    if self._owned:
                        self._verified = False
                        await execute((24, 0, struct.pack('>HBI', 0, 0, MASK)))
                        reply = await execute((24, 1, b''))
                        interval, count, mask = struct.unpack('>HBI', _reply(reply, 24, 1, 7))
                        if interval != 0:
                            raise ValueError('Sensor stream did not stop')
                        self._owned = self._attempted = False
                        self._sensors['status'] = 'stopped · no sensor consumers'
                    return
                if not self._attempted:
                    self._busy = True
                    self._publish()
                    try:
                        await self._install(execute)
                    except asyncio.CancelledError:
                        raise
                    except Exception as error:
                        self._attempted = True
                        self._status = str(error)
                    finally:
                        self._busy = False
                now = time.monotonic()
                index = next((i for offset in range(len(QUERIES))
                              if (i := (self._index + offset) % len(QUERIES)) not in self._unsupported
                              and now >= self._due.get(i, 0)), None)
                if index is None:
                    return
                self._index = (index + 1) % len(QUERIES)
                did, cid, interval = QUERIES[index]
                self._due[index] = now + interval
                try:
                    values = decode_reading(await execute((did, cid, b'')))
                    at = time.time() * 1000
                    self._readings.update({name: dict(value=value, at=at) for name, value in values.items()})
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    packet = getattr(error, 'packet', {})
                    if packet.get('error') in (1, 2, 3):
                        self._unsupported.add(index)
                    self._status = f'Sensor readback unavailable: {error}'
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._status = f'Sensor observation unavailable: {error}'
        finally:
            self._inflight = None
            self._busy = False
            self._publish()

    async def _install(self, execute):
        standard = await execute((24, 1, b''))
        interval, count, mask = struct.unpack('>HBI', _reply(standard, 24, 1, 7))
        extended = await execute((24, 13, b''))
        ext, = struct.unpack('>I', _reply(extended, 24, 13, 4))
        if ext != 0 or mask not in (0x70000, MASK) and not (mask == 0 and interval == 0):
            raise ValueError('Existing custom sensor stream retained')
        self._verified = False
        self._sensors['status'] = 'stale · configuring cockpit telemetry'
        self._owned = True
        await execute((24, 0, struct.pack('>HBI', 0, 0, mask)))
        stopped = await execute((24, 1, b''))
        if struct.unpack('>HBI', _reply(stopped, 24, 1, 7))[0] != 0:
            raise ValueError('Sensor stream did not stop')
        await execute((24, 12, struct.pack('>I', 0)))
        extended = await execute((24, 13, b''))
        if _reply(extended, 24, 13, 4) != b'\x00' * 4:
            raise ValueError('Extended sensor mask readback mismatch')
        await execute((24, 0, struct.pack('>HBI', 1000, 0, MASK)))
        active = await execute((24, 1, b''))
        if struct.unpack('>HBI', _reply(active, 24, 1, 7)) != (1000, 0, MASK):
            raise ValueError('Active sensor mask/interval readback mismatch')
        self._verified = self._attempted = True
        self._status = None
        self._sensors = dict(status='streaming · awaiting sample', values={}, invalid=0,
                             intervalMs=1000, requestedIntervalMs=1000, adapted=False,
                             schemaEpoch=self._sensors['schemaEpoch'] + 1,
                             standardMask=MASK, extendedMask=0, fieldNames=list(FIELDS))

    def accept(self, packet):
        if not self._verified or not self._demand or packet.get('flags', 0) & 1 or (packet.get('did'), packet.get('cid')) != (24, 2):
            return False
        try:
            values = struct.unpack('>10f', packet.get('data', b''))
            if not all(math.isfinite(value) for value in values):
                raise ValueError('Non-finite sensor sample')
            self._sensors.update(status='streaming', values=dict(zip(FIELDS, values)), sampleAt=time.time() * 1000)
        except (ValueError, struct.error):
            self._sensors['invalid'] += 1
        self._publish()
        return True
