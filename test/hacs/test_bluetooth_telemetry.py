"""Cockpit telemetry through the real session and a wire-level GATT boundary."""
import asyncio
import importlib
import struct
import unittest

from test_bluetooth_protocol import FakeGatt, p

try:
    telemetry = importlib.import_module(p.__package__ + '.bluetooth_telemetry')
except ModuleNotFoundError:
    telemetry = None


class SensorGatt(FakeGatt):
    def __init__(self):
        super().__init__()
        self.stream = (0, 0, 0)
        self.extended = 0
        self.readbacks = {(24, 9): struct.pack('>hh', -123, 456),
                          (24, 8): struct.pack('>HH', 1200, 3400),
                          (23, 20): struct.pack('>f', -45.5),
                          (23, 22): struct.pack('>f', 338.5),
                          (17, 14): struct.pack('>i', 37)}

    async def write_gatt_char(self, uuid, data, response):
        if uuid != p.API:
            return await super().write_gatt_char(uuid, data, response)
        self.writes.append((uuid, bytes(data), response))
        for packet in self.decoder.push(data):
            self.commands.append(packet)
            key = packet['did'], packet['cid']
            if key in self.ignore or not packet['flags'] & 2:
                continue
            if key == (24, 0):
                self.stream = struct.unpack('>HBI', packet['data'])
            if key == (24, 12):
                self.extended, = struct.unpack('>I', packet['data'])
            payload = {(24, 1): struct.pack('>HBI', *self.stream),
                       (24, 13): struct.pack('>I', self.extended),
                       (17, 0): self.firmware, (19, 3): b'\x01\xa4', (19, 4): b'\x03',
                       **self.readbacks}.get(key, b'')
            self.notify(p.encode_packet(*key, payload, packet['seq'], flags=1,
                                        error=self.errors.get(key, 0)))


class TelemetryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertIsNotNone(telemetry, 'HA cockpit telemetry implementation is missing')
        self.gatt = SensorGatt()
        async def connector(disconnected):
            self.gatt.on_disconnect = disconnected
            return self.gatt
        self.session = p.DroidBluetoothSession('address', 'R2', connector, timeout=.05)
        await self.session.connect()
        self.reader = self.session.telemetry
        self.reader.set_demand(True)
        # Exercise explicit ticks without wall-clock sleeps; scheduler is independently tested.
        self.reader._timer.cancel()
        self.reader._timer = None
        self.gatt.commands.clear()

    async def asyncTearDown(self):
        if hasattr(self, 'reader'):
            self.reader.invalidate(disconnected=True)
            self.session._cancel_maintenance()
            await asyncio.sleep(0)

    async def test_verified_schema_decodes_real_wire_order_and_readbacks(self):
        await self.reader.refresh()
        self.assertEqual(self.gatt.stream, (1000, 0, 0x7fc01))
        wire = p.encode_packet(24, 2, struct.pack('>10f', 1, 2, 3, 4, 5, 6, 7, 8, 9, 30), 0, flags=0)
        self.gatt.notify(wire)
        snapshot = self.session.snapshot()
        self.assertEqual(snapshot['sensors']['values'], {
            'attitude.pitch': 1, 'attitude.roll': 2, 'attitude.yaw': 3,
            'accelerometer.x': 4, 'accelerometer.y': 5, 'accelerometer.z': 6,
            'rawGyroscope.x': 7, 'rawGyroscope.y': 8, 'rawGyroscope.z': 9,
            'processorTemperature': 30})
        for _ in range(5):
            await self.reader.refresh()
        readings = self.reader.snapshot()['cockpitReadings']
        self.assertEqual({k: v['value'] for k, v in readings.items()}, {
            'encoder.0': -123, 'encoder.1': 456, 'shoulder.adc': 1200, 'dome.adc': 3400,
            'dome.degrees': -45.5, 'stance.position': 338.5, 'battery.volts': 4.2,
            'processor.celsius': 37})

    async def test_malformed_stream_and_nonfinite_positions_do_not_publish_values(self):
        await self.reader.refresh()
        for payload in [b'\x00' * 12, struct.pack('>10f', *([float('nan')] * 10))]:
            self.reader.accept({'did': 24, 'cid': 2, 'flags': 0, 'data': payload})
        self.assertEqual(self.reader.snapshot()['sensors']['invalid'], 2)
        self.assertEqual(self.reader.snapshot()['sensors']['values'], {})
        self.gatt.readbacks[(23, 20)] = struct.pack('>f', float('inf'))
        await self.reader.refresh()
        await self.reader.refresh()
        self.assertNotIn('dome.degrees', self.reader.snapshot()['cockpitReadings'])

    async def test_custom_stream_is_preserved_and_not_decoded(self):
        self.gatt.stream = (100, 0, 1)
        await self.reader.refresh()
        self.assertEqual(self.gatt.stream, (100, 0, 1))
        self.assertFalse(any(c['did'] == 24 and c['cid'] in (0, 12) for c in self.gatt.commands))
        self.reader.accept({'did': 24, 'cid': 2, 'flags': 0, 'data': b'\x00' * 40})
        self.assertEqual(self.reader.snapshot()['sensors']['values'], {})

    async def test_stop_preempts_unanswered_telemetry_without_pending_reply_collision(self):
        await self.reader.refresh()
        self.gatt.ignore.add((24, 8))
        read = asyncio.create_task(self.reader.refresh())
        for _ in range(10):
            await asyncio.sleep(0)
            if self.session._pending:
                break
        pending_sequence = self.session._pending[2]
        await self.session.stop()
        await asyncio.gather(read, return_exceptions=True)
        self.assertIn(pending_sequence, self.session._retired)
        self.assertEqual(self.session.snapshot()['control'], 'ready')
        self.assertIsNone(self.session._pending)
        self.assertTrue(self.gatt.is_connected)

    async def test_motion_priority_skips_poll_and_consumes_existing_stream(self):
        await self.reader.refresh()
        self.gatt.commands.clear()
        self.session._count = 1
        await self.reader.refresh()
        self.assertEqual(self.gatt.commands, [])
        self.reader.accept({'did': 24, 'cid': 2, 'flags': 0, 'data': struct.pack('>10f', *range(10))})
        self.assertEqual(self.reader.snapshot()['sensors']['values']['accelerometer.x'], 3)
        self.session._count = 0

    async def test_no_demand_stops_owned_stream_and_disconnect_discards_late_samples(self):
        await self.reader.refresh()
        self.reader.set_demand(False)
        self.reader._timer.cancel()
        self.reader._timer = None
        await self.reader.refresh()
        self.assertEqual(self.gatt.stream[0], 0)
        self.session._on_disconnect()
        self.gatt.commands.clear()
        self.reader.accept({'did': 24, 'cid': 2, 'flags': 0, 'data': b'\x00' * 40})
        await self.reader.refresh()
        self.assertEqual(self.gatt.commands, [])
        self.assertEqual(self.reader.snapshot()['sensors']['values'], {})

    async def test_demand_timer_never_polls_faster_than_one_hertz(self):
        self.reader.set_demand(True)
        await asyncio.sleep(.02)
        first = len(self.gatt.commands)
        self.assertGreater(first, 0)
        await asyncio.sleep(.1)
        self.assertEqual(len(self.gatt.commands), first)
        await asyncio.sleep(.95)
        self.assertEqual(len(self.gatt.commands), first + 1)

    async def test_audio_playback_does_not_permanently_starve_readbacks(self):
        await self.reader.refresh()
        self.session._activity = 'audio'
        await self.reader.refresh()
        self.assertIn('dome.adc', self.reader.snapshot()['cockpitReadings'])
        self.assertEqual(self.reader.snapshot()['cockpitReadings']['dome.adc']['value'], 3400)

    async def test_readback_mismatch_never_enables_sensor_decoder(self):
        self.gatt.readbacks[(24, 1)] = struct.pack('>HBI', 0, 0, 0)
        await self.reader.refresh()
        self.gatt.notify(p.encode_packet(24, 2, b'\x00' * 40, 0, flags=0))
        self.assertEqual(self.session.snapshot()['sensors']['values'], {})
        self.assertIn('readback mismatch', self.session.snapshot()['cockpitTelemetryStatus'])

    async def test_motion_open_preempts_query_and_stream_samples_continue_during_drive(self):
        await self.reader.refresh()
        self.gatt.ignore.add((24, 8))
        query = asyncio.create_task(self.reader.refresh())
        for _ in range(10):
            await asyncio.sleep(0)
            if self.session._pending:
                break
        self.assertIsNotNone(self.session._pending)
        opened = await self.session.motion.open('cockpit')
        await asyncio.gather(query, return_exceptions=True)
        result = await self.session.motion.command('cockpit', opened['lease_id'], opened['token'],
                                                    'drive', {'left': 25, 'right': 25, 'flags': 0})
        self.assertEqual(result['confirmation'], 'ack')
        count = len(self.gatt.commands)
        await self.reader.refresh()
        self.assertEqual(len(self.gatt.commands), count)
        self.gatt.notify(p.encode_packet(24, 2, struct.pack('>10f', *range(10)), 0, flags=0))
        self.assertEqual(self.session.snapshot()['sensors']['values']['rawGyroscope.z'], 8)
        await self.session.motion.release('cockpit', opened['lease_id'])
        self.assertTrue(self.gatt.is_connected)

    async def test_unload_cancels_offline_observation_timer_without_connecting(self):
        offline = p.DroidBluetoothSession('offline', 'R2', self.session.connector)
        offline.telemetry.set_demand(True)
        timer = offline.telemetry._timer
        await offline.close()
        await asyncio.sleep(0)
        self.assertTrue(timer.done())
        self.assertIsNone(offline.client)

    async def test_pending_schema_read_keeps_cockpit_controls_available_for_preemption(self):
        self.gatt.ignore.add((24, 1))
        query = asyncio.create_task(self.reader.refresh())
        try:
            for _ in range(10):
                await asyncio.sleep(0)
                if self.session._pending:
                    break
            self.assertIsNotNone(self.session._pending)
            snapshot = self.session.snapshot()
            self.assertFalse(snapshot['cockpitTelemetryBusy'])
            self.assertEqual(snapshot['control'], 'ready')
            await self.session.stop()
            self.assertTrue(self.gatt.is_connected)
        finally:
            query.cancel()
            await asyncio.gather(query, return_exceptions=True)

    async def test_offline_demand_never_connects_or_wakes(self):
        self.reader.invalidate(disconnected=True)
        self.session._state['connection'] = 'disconnected'
        self.gatt.commands.clear()
        self.reader.set_demand(True)
        await asyncio.sleep(.01)
        self.assertEqual(self.gatt.commands, [])
