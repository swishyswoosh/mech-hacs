"""Native API-v2 behavioral tests; the sole double is the GATT transport."""
import asyncio
import importlib
from pathlib import Path
import sys
import types
import unittest

BASE = Path(__file__).parents[2]
ROOT = (BASE) / 'custom_components/mech'
pkg = types.ModuleType('mech_protocol_test')
pkg.__path__ = [str(ROOT)]
sys.modules[pkg.__name__] = pkg
p = importlib.import_module(pkg.__name__ + '.bluetooth_protocol') if (ROOT / 'bluetooth_protocol.py').exists() else None

class CodecTests(unittest.TestCase):
    def test_wake_wire_checksum_and_escaped_payload(self):
        self.assertIsNotNone(p, 'Native Home Assistant Bluetooth protocol is missing')
        self.assertEqual(p.encode_packet(19, 13, b'', 0), bytes.fromhex('8d 0a 13 0d 00 d5 d8'))
        frame = p.encode_packet(26, 7, bytes([141, 216, 171]), 1)
        self.assertEqual(frame, bytes.fromhex('8d 0a 1a 07 01 ab 05 ab 50 ab 23 c3 d8'))
        decoder = p.PacketDecoder()
        self.assertEqual(decoder.push(frame[:5]), [])
        result = decoder.push(frame[5:])
        self.assertEqual(result[0]['data'], bytes([141, 216, 171]))
        self.assertEqual(decoder.push(bytes.fromhex('8d 0a 13 0d 00 d4 d8')), [])


class CatalogTests(unittest.TestCase):
    def test_catalog_admission_resolves_sectors_and_native_led_order(self):
        self.assertTrue(hasattr(p, 'prepare'), 'Native semantic action admission is missing')
        sounds = p.catalog('sounds')['items']
        first = sounds[0]
        plan = p.prepare('sound.play', {'sound_id': first['id']})
        self.assertEqual(plan.command, (26, 7, first['sector'].to_bytes(2, 'big') + b'\x00'))
        light = p.prepare('lights.apply', {'settings': {'readouts': 33, 'rear_dome_red': 22}})
        self.assertEqual(light.command, (26, 14, bytes([0, 24, 33, 22])))
        for action, parameters in [('sound.play', {'sound_id': 'unknown'}), ('animation.play', {'animation_id': 'animation:1'}), ('lights.apply', {'settings': {'projector': True}}), ('lights.apply', {'settings': {}}), ('lights.apply', {'settings': {'wheel': 255}})]:
            with self.assertRaises(ValueError): p.prepare(action, parameters)
        self.assertTrue(all(not item['available'] for item in p.catalog('animations')['items']))

    def test_prepared_recipe_is_detached_and_validated_before_connect(self):
        self.assertTrue(hasattr(p, 'prepare'), 'Native semantic action admission is missing')
        import json
        recipe = {'version': 1, 'name': 'Saved', 'frames': [{'atMs': 0, 'controls': [1]*8, 'transitionMs': 80}]}
        preferences = {'device.light-recipe.v1': json.dumps(recipe)}
        plan = p.prepare('protocol.run', {'protocol_id': 'protocol-device-lights'}, preferences)
        preferences.clear()
        changed = plan.parameters
        changed['resolved_recipe']['frames'][0]['controls'][0] = 200
        self.assertEqual(plan.parameters['resolved_recipe']['frames'][0]['controls'][0], 1)
        self.assertEqual(plan.command, (23, 26, bytes([0,0,255,0,0,15,1,1,1,1,1,1,1,1,0,80,254])))
        self.assertEqual(plan.duration_ms, 80)
        recipe['frames'][0]['drive'] = 20
        with self.assertRaises(ValueError): p.prepare('protocol.run', {'protocol_id': 'protocol-device-lights'}, {'device.light-recipe.v1': json.dumps(recipe)})

class FakeGatt:
    """Firmware boundary double: receives encoded writes and returns wire replies."""
    def __init__(self):
        self.is_connected = True
        self.callbacks, self.writes, self.commands = {}, [], []
        self.decoder = p.PacketDecoder()
        self.errors, self.ignore = {}, set()
        self.info = bytes([0,0,0,0,2,0,0,0])
        self.disconnect_count = 0
        self.firmware = bytes([0,7,0,0,0,101])
        self.did_sleep = True
        self.on_disconnect = lambda *_: None

    async def start_notify(self, uuid, callback): self.callbacks[uuid] = callback
    async def read_gatt_char(self, uuid): return self.info
    async def write_gatt_char(self, uuid, data, response):
        self.writes.append((uuid, bytes(data), response))
        if uuid != p.API: return
        assert len(data) <= 20
        for packet in self.decoder.push(data):
            self.commands.append(packet)
            key = (packet['did'], packet['cid'])
            if not packet['flags'] & 2 or key in self.ignore: continue
            payload = {(17,0): self.firmware, (19,3): bytes([1,164]), (19,4): bytes([3])}.get(key, b'')
            error = self.errors.get(key, 0)
            self.notify(p.encode_packet(*key, payload, packet['seq'], flags=1, error=error))
            if key == (19,1) and self.did_sleep and not error:
                self.notify(p.encode_packet(19,26,b'',0,flags=0))
    def notify(self, frame):
        self.callbacks[p.API](None, frame[:3])
        self.callbacks[p.API](None, frame[3:])
    async def disconnect(self):
        self.is_connected = False
        self.disconnect_count += 1
        self.on_disconnect(self)


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.assertTrue(hasattr(p, 'DroidBluetoothSession'), 'Native Bluetooth session is missing')
        self.gatt = FakeGatt()
        self.opens = 0
        async def connector(callback):
            self.opens += 1
            self.gatt.on_disconnect = callback
            return self.gatt
        self.session = p.DroidBluetoothSession('AA:BB:CC:DD:EE:FF', 'R2', connector, timeout=0.05, sleep_timeout=0.05)
    async def asyncTearDown(self):
        if hasattr(self, 'session'): await self.session.close()

    async def test_offline_stop_is_harmless_only_before_ownership_or_after_confirmed_sleep(self):
        await self.session.stop()
        self.assertEqual(self.opens, 0)
        self.assertNotEqual(self.session.snapshot()['control'], 'failed')
        await self.session.connect()
        await self.session.disconnect()
        count = len(self.gatt.commands)
        await self.session.stop()
        self.assertEqual(len(self.gatt.commands), count)
        self.assertFalse(self.session.snapshot()['stop_required'])

    async def test_idle_catalog_never_connects_and_initialization_requires_wake_ack(self):
        self.session.snapshot(); p.catalog('sounds')
        self.assertEqual(self.opens, 0)
        await self.session.connect()
        self.assertEqual(self.gatt.writes[0], (p.INITIALIZATION,b'usetheforce...band',True))
        self.assertEqual([(x['did'],x['cid'],x['seq']) for x in self.gatt.commands[:5]], [(19,13,0),(17,0,1),(17,3,2),(19,3,3),(19,4,4)])
        self.assertEqual(self.session.snapshot()['battery_voltage'], 4.2)
        self.assertEqual(self.session.snapshot()['power'], 'awake')
        self.assertEqual(self.opens, 1)

    async def test_sound_uses_catalog_sector_and_ack_does_not_claim_completion(self):
        await self.session.connect()
        item = p.catalog('sounds')['items'][0]
        result = await self.session.execute('sound.play', {'sound_id':item['id']})
        self.assertEqual(result['state'], 'dispatched')
        self.assertEqual(result['confirmation'], 'ack')
        self.assertEqual(self.gatt.commands[-1]['data'], item['sector'].to_bytes(2,'big') + b'\x00')
        self.assertTrue(self.session.busy)
        await self.session.stop()
        self.assertFalse(self.session.busy)
        self.assertTrue(self.gatt.is_connected)

    async def test_stop_preempts_unacknowledged_command_and_never_replays_it(self):
        await self.session.connect()
        await self.session.stop()
        self.gatt.ignore.add((26,14))
        task = asyncio.create_task(self.session.execute('lights.apply', {'preset_id':'preset-idle'}))
        for _ in range(20):
            await asyncio.sleep(0)
            if any(c['did']==26 and c['cid']==14 for c in self.gatt.commands): break
        await self.session.stop()
        with self.assertRaises(p.CommandCancelled): await task
        self.assertEqual(sum(c['did']==26 and c['cid']==14 for c in self.gatt.commands), 1)
        self.assertEqual(self.session.snapshot()['control'], 'ready')
        self.assertEqual(self.opens, 1)

    async def test_wrong_sequence_and_nonresponse_never_ack_but_confirmed_stop_recovers(self):
        await self.session.connect()
        await self.session.stop()
        self.gatt.ignore.add((26,14))
        task = asyncio.create_task(self.session.execute('lights.apply', {'preset_id':'preset-off'}))
        for _ in range(20):
            await asyncio.sleep(0)
            if self.gatt.commands[-1]['cid']==14: break
        command = self.gatt.commands[-1]
        self.gatt.notify(p.encode_packet(26,14,b'',command['seq']+1,flags=1))
        self.gatt.notify(p.encode_packet(26,14,b'',command['seq'],flags=0))
        with self.assertRaises(TimeoutError): await task
        self.assertEqual(self.session.snapshot()['control'], 'failed')
        await self.session.stop()
        self.assertEqual(self.session.snapshot()['control'], 'ready')
        await self.session.connect()
        self.assertEqual(self.opens, 1)

    async def test_sleep_requires_did_sleep_and_closes_only_after_notification(self):
        await self.session.connect()
        self.gatt.did_sleep = False
        task = asyncio.create_task(self.session.disconnect())
        for _ in range(40):
            await asyncio.sleep(0)
            if self.gatt.commands[-1]['cid']==1: break
        self.assertTrue(self.gatt.is_connected)
        self.assertFalse(task.done())
        self.gatt.notify(p.encode_packet(19,26,b'',0,flags=0))
        await task
        self.assertEqual(self.session.snapshot()['power'], 'asleep')
        self.assertFalse(self.gatt.is_connected)

    async def test_unconfirmed_sleep_retains_transport_and_failure(self):
        await self.session.connect()
        self.gatt.did_sleep = False
        with self.assertRaises(TimeoutError): await self.session.disconnect()
        self.assertTrue(self.gatt.is_connected)
        self.assertEqual(self.session.snapshot()['control'], 'failed')
        self.assertNotEqual(self.session.snapshot()['power'], 'asleep')

    async def test_low_battery_leg_hold_rejection_still_allows_explicit_sleep(self):
        await self.session.connect()
        self.gatt.errors[(23,13)] = 4
        await self.session.disconnect()
        self.assertEqual(self.session.snapshot()['power'], 'asleep')
        self.assertEqual(self.session.snapshot()['control'], 'blocked')
        self.assertEqual(self.gatt.commands[-1]['did'], 19)
        self.assertEqual(self.gatt.commands[-1]['cid'], 1)

    async def test_optional_mode_bad_cid_can_be_skipped_but_not_mandatory_stop(self):
        await self.session.connect()
        for cid in (10,45,47): self.gatt.errors[(23,cid)] = 2
        await self.session.stop()
        self.assertEqual(self.session.snapshot()['control'], 'ready')
        self.gatt.errors[(23,41)] = 2
        with self.assertRaises(p.DroidResponseError): await self.session.stop()
        self.assertEqual(self.session.snapshot()['control'], 'ready')
        self.assertIn('23/41', self.session.snapshot()['stop_failure'])
        self.assertFalse(self.session.snapshot()['drive_stop_unconfirmed'])
        self.gatt.errors.clear()

    async def test_transport_loss_invalidates_state_and_never_reconnects(self):
        self.assertFalse(self.session.snapshot()['stop_required'])
        await self.session.connect()
        self.assertTrue(self.session.snapshot()['stop_required'])
        self.gatt.is_connected = False
        self.gatt.on_disconnect(self.gatt)
        self.assertEqual(self.session.snapshot()['connection'], 'disconnected')
        self.assertEqual(self.session.snapshot()['power'], 'unknown')
        self.assertTrue(self.session.snapshot()['stop_required'])
        self.assertEqual(self.opens, 1)

    async def test_restart_gate_does_not_wake_or_automatically_reconnect(self):
        self.gatt.info = b''
        with self.assertRaises(RuntimeError): await self.session.connect()
        self.assertEqual(self.gatt.commands, [])
        self.assertIn((p.CONTROL, b'\x1e', True), self.gatt.writes)
        self.assertEqual(self.opens, 1)

    async def test_unavailable_retry_after_restart_gate_returns_to_disconnected(self):
        self.gatt.info = b''
        with self.assertRaises(RuntimeError): await self.session.connect()
        async def unavailable(callback): raise RuntimeError('Proxy unavailable')
        self.session.connector = unavailable
        with self.assertRaisesRegex(RuntimeError, 'Proxy unavailable'): await self.session.connect()
        self.assertEqual(self.session.snapshot()['connection'], 'disconnected')
        self.assertNotEqual(self.session.snapshot()['control'], 'failed')

class ProtocolEdgeTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = SessionTests.asyncSetUp
    asyncTearDown = SessionTests.asyncTearDown
    async def test_recipe_fragmentation_cleanup_and_stop_cancellation(self):
        import json
        await self.session.connect()
        recipe = {'version':1, 'name':'Short', 'frames':[{'atMs':0,'controls':[141]*8,'transitionMs':80}]}
        plan = p.prepare('protocol.run', {'protocol_id':'protocol-device-lights'}, {'device.light-recipe.v1':json.dumps(recipe)})
        task = asyncio.create_task(self.session.execute_prepared(plan))
        for _ in range(60):
            await asyncio.sleep(0)
            if any(c['cid']==26 and c['did']==23 for c in self.gatt.commands): break
        self.assertTrue(self.session.busy)
        await self.session.stop()
        with self.assertRaises(p.CommandCancelled): await task
        schedules = [c for c in self.gatt.commands if c['did']==23 and c['cid']==26]
        self.assertEqual(schedules[0]['data'], bytes([0,0,255,0,0,15,141,141,141,141,141,141,141,141,0,80,254]))
        self.assertTrue(all(c['data']==bytes([0,0,255,0,0,254]) for c in schedules[1:]))
        self.assertFalse(self.session.busy)
        self.assertTrue(self.gatt.is_connected)
        self.assertTrue(all(len(data)<=20 for uuid,data,_ in self.gatt.writes if uuid==p.API))

    async def test_stop_during_initialization_closes_late_client_without_wake(self):
        gate = asyncio.Event()
        async def connector(callback):
            self.gatt.on_disconnect = callback
            await gate.wait()
            return self.gatt
        self.session.connector = connector
        connecting = asyncio.create_task(self.session.connect())
        await asyncio.sleep(0)
        stopping = asyncio.create_task(self.session.stop())
        await asyncio.sleep(0)
        gate.set()
        with self.assertRaises(p.CommandCancelled): await connecting
        with self.assertRaises(p.CommandCancelled): await stopping
        self.assertEqual(self.gatt.commands, [])
        self.assertFalse(self.gatt.is_connected)

    async def test_did_sleep_before_ack_is_completion_but_reply_is_not_event(self):
        await self.session.connect()
        self.gatt.did_sleep = False
        self.gatt.ignore.add((19,1))
        task = asyncio.create_task(self.session.disconnect())
        for _ in range(60):
            await asyncio.sleep(0)
            if self.gatt.commands[-1]['cid']==1: break
        self.gatt.notify(p.encode_packet(19,26,b'',0,flags=1))
        self.assertFalse(self.session._sleep_event.is_set())
        self.assertTrue(self.gatt.is_connected)
        self.gatt.notify(p.encode_packet(19,26,b'',0,flags=0))
        result = await task
        self.assertEqual(result['confirmation'], 'notification')
        self.assertFalse(self.gatt.is_connected)

    async def test_will_sleep_stops_sources_but_retains_link_until_did_sleep(self):
        await self.session.connect()
        self.gatt.notify(p.encode_packet(19,25,b'',0,flags=0))
        for _ in range(60): await asyncio.sleep(0)
        self.assertTrue(self.gatt.is_connected)
        self.assertEqual(self.session.snapshot()['power'], 'sleep-pending')
        self.assertEqual(self.session.snapshot()['control'], 'blocked')
        self.assertTrue(any(c['seq']==255 for c in self.gatt.commands))
        with self.assertRaises(RuntimeError): await self.session.execute('lights.apply', {'preset_id':'preset-off'})

    async def test_unload_reports_failed_cleanup_to_caller(self):
        await self.session.connect()
        self.gatt.errors[(23,41)] = 2
        with self.assertRaises(p.DroidResponseError): await self.session.close()
        self.assertFalse(self.gatt.is_connected)
        self.assertEqual(self.session.snapshot()['control'], 'failed')

    async def test_old_transport_callbacks_cannot_revoke_reconnected_session(self):
        await self.session.connect()
        old_disconnect = self.gatt.on_disconnect
        old_notify = self.gatt.callbacks[p.API]
        await self.session.disconnect()
        self.gatt = FakeGatt()
        await self.session.connect()
        old_disconnect(None)
        old_notify(None, p.encode_packet(19,26,b'',0,flags=0))
        self.assertEqual(self.session.snapshot()['connection'], 'connected')
        self.assertEqual(self.session.snapshot()['power'], 'awake')

    async def test_static_lights_do_not_interrupt_audio_playback(self):
        await self.session.connect()
        item = p.catalog('sounds')['items'][0]
        await self.session.execute('sound.play', {'sound_id':item['id']})
        start = len(self.gatt.commands)
        await self.session.execute('lights.apply', {'preset_id':'preset-off'})
        self.assertEqual([(c['did'],c['cid']) for c in self.gatt.commands[start:]], [(26,14)])
        self.assertTrue(self.session.busy)

    async def test_successful_connect_establishes_acknowledged_idle_baseline(self):
        await self.session.connect()
        self.assertFalse(self.session.busy)
        self.assertEqual([(c['did'],c['cid']) for c in self.gatt.commands[-8:]], [(23,43),(23,41),(23,10),(23,47),(23,45),(23,13),(22,7),(26,10)])

    async def test_low_battery_connect_failure_retains_only_explicit_sleep_path(self):
        self.gatt.errors[(23,13)] = 4
        with self.assertRaises(p.DroidResponseError): await self.session.connect()
        self.assertTrue(self.gatt.is_connected)
        self.assertTrue(self.session.can_sleep_after_failure)
        self.assertEqual(self.session.snapshot()['control'], 'failed')
        with self.assertRaises(RuntimeError): await self.session.execute('lights.apply', {'preset_id':'preset-off'})
        await self.session.disconnect()
        self.assertEqual(self.session.snapshot()['power'], 'asleep')
        self.assertEqual(self.session.snapshot()['control'], 'blocked')

    async def test_cancelled_stop_waiter_does_not_leave_permanent_busy_flag(self):
        await self.session.connect()
        original = self.gatt.write_gatt_char
        gate = asyncio.Event()
        async def delayed(uuid, data, response):
            if data[1:2] == b'\x08': await gate.wait()
            return await original(uuid,data,response)
        self.gatt.write_gatt_char = delayed
        stopping = asyncio.create_task(self.session.stop())
        for _ in range(5): await asyncio.sleep(0)
        stopping.cancel()
        with self.assertRaises(asyncio.CancelledError): await stopping
        gate.set()
        for _ in range(80): await asyncio.sleep(0)
        self.assertFalse(self.session.busy)
        await self.session.execute('lights.apply', {'preset_id':'preset-off'})

    async def test_connection_setup_budget_is_separate_from_command_deadline(self):
        old = self.session.connector
        async def delayed(callback):
            await asyncio.sleep(0.06)
            return await old(callback)
        self.session.connector = delayed
        await self.session.connect()
        self.assertEqual(self.session.snapshot()['connection'], 'connected')

    async def test_light_recipe_returns_only_ack_evidence_after_cleanup(self):
        import json
        await self.session.connect()
        recipe = {'version':1,'name':'Short','frames':[{'atMs':0,'controls':[0]*8,'transitionMs':80}]}
        plan = p.prepare('protocol.run', {'protocol_id':'protocol-device-lights'}, {'device.light-recipe.v1':json.dumps(recipe)})
        result = await self.session.execute_prepared(plan)
        self.assertEqual(result, {'state':'dispatched','confirmation':'ack','evidence':{'cleanup_acknowledged':True,'physical_completion':False}})
        self.assertEqual([(c['did'],c['cid'],c['data']) for c in self.gatt.commands[-2:]], [(23,26,bytes([0,0,255,0,0,254])),(23,40,b'')])
        self.assertFalse(self.session.busy)

    async def test_unsupported_firmware_never_sends_inline_schedule(self):
        self.gatt.firmware = bytes([0,7,0,0,0,102])
        await self.session.connect()
        with self.assertRaisesRegex(ValueError, '7.0.101'):
            await self.session.execute('protocol.run', {'protocol_id':'protocol-device-lights'})
        self.assertFalse(any(c['did']==23 and c['cid']==26 for c in self.gatt.commands))

    async def test_idle_keepalive_only_runs_on_explicit_ready_connection(self):
        self.session.maintenance_interval = 0.01
        await asyncio.sleep(0.025)
        self.assertEqual(self.opens, 0)
        await self.session.connect()
        await asyncio.sleep(0.025)
        self.assertTrue(any(c['did']==16 and c['cid']==0 for c in self.gatt.commands))
        await self.session.disconnect()
        count = len(self.gatt.commands)
        await asyncio.sleep(0.025)
        self.assertEqual(len(self.gatt.commands), count)
        self.assertEqual(self.opens, 1)
        self.assertEqual(self.session.snapshot()['power'], 'asleep')

    async def test_keepalive_failure_attempts_confirmed_cleanup_without_reconnect(self):
        self.session.maintenance_interval = 0.01
        await self.session.connect()
        self.gatt.ignore.add((16,0))
        while not any(c['did']==16 and c['cid']==0 for c in self.gatt.commands):
            await asyncio.sleep(0.001)
        self.gatt.ignore.clear()
        await asyncio.sleep(0.1)
        self.assertEqual(self.session.snapshot()['control'], 'ready')
        self.assertGreaterEqual(sum(c['did']==16 and c['cid']==0 for c in self.gatt.commands), 2)
        self.assertTrue(any(c['seq']==255 for c in self.gatt.commands))
        self.assertEqual(self.opens, 1)
        self.assertFalse(self.session.motion.active)
        self.assertFalse(self.session._maintenance_task.done())

    async def test_low_battery_standalone_stop_preserves_explicit_sleep_exception(self):
        await self.session.connect()
        self.gatt.errors[(23,13)] = 4
        with self.assertRaises(p.DroidResponseError): await self.session.stop()
        self.assertTrue(self.session.can_sleep_after_failure)
        await self.session.disconnect()
        self.assertEqual(self.session.snapshot()['power'], 'asleep')
        self.assertEqual(self.session.snapshot()['control'], 'blocked')

    async def test_disconnect_retries_cleanup_after_other_stop_failures(self):
        await self.session.connect()
        self.gatt.errors[(23,41)] = 4
        with self.assertRaises(p.DroidResponseError): await self.session.stop()
        self.assertFalse(self.session.can_sleep_after_failure)
        self.gatt.errors.clear()
        self.gatt.errors[(23,13)] = 4
        with self.assertRaises(p.DroidResponseError): await self.session.stop()
        self.assertFalse(self.session.can_sleep_after_failure)
        await self.session.disconnect()
        self.assertEqual(self.session.snapshot()['power'], 'asleep')
        self.gatt.errors.clear()

    async def test_unavailable_before_wake_allows_only_explicit_connect_retry(self):
        original = self.session.connector
        async def unavailable(callback): raise RuntimeError('No connectable HA device')
        self.session.connector = unavailable
        with self.assertRaisesRegex(RuntimeError, 'No connectable'): await self.session.connect()
        self.assertNotEqual(self.session.snapshot()['control'], 'failed')
        self.assertEqual(self.opens, 0)
        self.session.connector = original
        await self.session.connect()
        self.assertEqual(self.opens, 1)
        self.assertEqual(self.session.snapshot()['control'], 'ready')

    async def test_application_restart_gate_allows_explicit_fresh_connection(self):
        self.gatt.info = b''
        with self.assertRaisesRegex(RuntimeError, 'restart'): await self.session.connect()
        self.assertEqual(self.gatt.commands, [])
        self.assertNotEqual(self.session.snapshot()['control'], 'failed')
        self.gatt = FakeGatt()
        await self.session.connect()
        self.assertEqual(self.session.snapshot()['control'], 'ready')
        self.assertEqual(self.opens, 2)
