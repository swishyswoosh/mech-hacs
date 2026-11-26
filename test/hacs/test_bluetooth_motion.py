"""Exercise motion admission at the real session/GATT boundary."""
import asyncio
import unittest
from test_bluetooth_protocol import FakeGatt, p


class MotionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.gatt = FakeGatt()
        async def connector(callback):
            self.gatt.on_disconnect = callback
            return self.gatt
        self.session = p.DroidBluetoothSession('A', 'R2', connector, timeout=.08)
        await self.session.connect()

    async def asyncTearDown(self):
        await self.session.close()

    async def send(self, opened, action, parameters):
        return await self.session.motion.command('tab', opened['lease_id'], opened['token'], action, parameters)

    async def test_no_is_native_animation_and_stop_retains_gatt(self):
        opened = await self.session.motion.open('tab')
        result = await self.send(opened, 'animation', {'animation_id': 'animation:16'})
        self.assertEqual(result['confirmation'], 'ack')
        wire = self.gatt.commands[-1]
        self.assertEqual((wire['did'], wire['cid'], wire['data']), (23, 5, b'\x00\x10'))
        await self.session.stop()
        self.assertTrue(self.gatt.is_connected)
        with self.assertRaises(ValueError):
            await self.send(opened, 'dome', {'degrees': 20})

    async def test_challenge_is_single_use_and_old_packets_cannot_extend_watchdog(self):
        opened = await self.session.motion.open('tab')
        await self.send(opened, 'drive', {'left': 25, 'right': 25, 'flags': 0})
        with self.assertRaises(ValueError):
            await self.send(opened, 'drive', {'left': 50, 'right': 50, 'flags': 0})
        await asyncio.sleep(.28)
        self.assertFalse(self.session.motion.active)
        self.assertTrue(any(c['did']==22 and c['cid']==8 and c['data']==bytes(3) for c in self.gatt.commands))
        self.assertTrue(self.gatt.is_connected)

    async def test_expired_challenge_never_reaches_wire(self):
        opened = await self.session.motion.open('tab')
        before = len(self.gatt.commands)
        await asyncio.sleep(.26)
        with self.assertRaises(ValueError):
            await self.send(opened, 'dome', {'degrees': 10})
        self.assertFalse(any(c['did']==23 and c['cid']==15 for c in self.gatt.commands[before:]))

    async def test_wrong_owner_and_invalid_values_never_move(self):
        opened = await self.session.motion.open('tab')
        with self.assertRaises(ValueError):
            await self.session.motion.command('other', opened['lease_id'], opened['token'], 'dome', {'degrees': 10})
        with self.assertRaises(ValueError):
            await self.send(opened, 'drive', {'left': True, 'right': 0, 'flags': 0})
        with self.assertRaises(ValueError):
            await self.session.motion.open('other')

    async def test_release_fences_inflight_motion_reply(self):
        opened = await self.session.motion.open('tab')
        self.gatt.ignore.add((23,15))
        task = asyncio.create_task(self.send(opened, 'dome', {'degrees': 10}))
        await asyncio.sleep(.005)
        await self.session.motion.release('tab', opened['lease_id'])
        with self.assertRaises(p.CommandCancelled):
            await task
        self.assertTrue(self.gatt.is_connected)
        self.assertFalse(self.session.motion.active)

    async def test_late_timer_cannot_renew_an_already_expired_watchdog(self):
        now = [100.0]
        self.session.motion.clock = lambda: now[0]
        opened = await self.session.motion.open('tab')
        await self.send(opened, 'drive', {'left': 20, 'right': 20, 'flags': 0})
        now[0] = 100.20
        challenge = self.session.motion.challenge('tab', opened['lease_id'])
        now[0] = 100.26
        before = len(self.gatt.commands)
        with self.assertRaises(ValueError):
            await self.send({**opened, **challenge}, 'drive', {'left': 80, 'right': 80, 'flags': 0})
        self.assertFalse(any(c['did'] == 22 and c['cid'] == 8 and c['data'] == bytes([80,80,0]) for c in self.gatt.commands[before:]))

    async def test_watchdog_fences_native_work_before_async_stop_runs(self):
        opened = await self.session.motion.open('tab')
        await self.send(opened, 'drive', {'left': 20, 'right': 20, 'flags': 0})
        before = len(self.gatt.commands)
        self.session.motion._expire()
        with self.assertRaises(RuntimeError):
            await self.session.motion.open('other')
        await asyncio.sleep(.01)
        first = self.gatt.commands[before]
        self.assertEqual((first['did'], first['cid'], first['data']), (22, 8, bytes(3)))
        self.assertTrue(self.gatt.is_connected)

    async def test_ack_supplies_one_use_challenge_without_extending_current_deadline(self):
        now = [100.0]
        self.session.motion.clock = lambda: now[0]
        opened = await self.session.motion.open('tab')
        now[0] = 100.05
        result = await self.send(opened, 'drive', {'left': 20, 'right': 20, 'flags': 0})
        self.assertEqual(self.session.motion.deadline, 100.25)
        self.assertIn('token', result)
        now[0] = 100.20
        result2 = await self.send({**opened, 'token': result['token']}, 'drive', {'left': 30, 'right': 30, 'flags': 0})
        self.assertEqual(result2['confirmation'], 'ack')
        self.assertAlmostEqual(self.session.motion.deadline, 100.30)
        with self.assertRaises(ValueError):
            await self.send({**opened, 'token': result['token']}, 'drive', {'left': 40, 'right': 40, 'flags': 0})
        now[0] = 100.31
        before = len(self.gatt.commands)
        with self.assertRaises(ValueError):
            await self.send({**opened, 'token': result2['token']}, 'drive', {'left': 50, 'right': 50, 'flags': 0})
        self.assertFalse(any(c['did'] == 22 and c['cid'] == 8 and c['data'] == bytes([50,50,0]) for c in self.gatt.commands[before:]))
        self.assertTrue(self.gatt.is_connected)

    async def test_renew_response_supplies_next_challenge_but_cannot_extend_absolute_cap(self):
        now = [100.0]
        self.session.motion.clock = lambda: now[0]
        opened = await self.session.motion.open('tab')
        result = await self.send(opened, 'dome', {'degrees': 10})
        self.assertIn('token', result)
        self.session.motion.limit = 100.22
        now[0] = 100.10
        renewed = await self.send({**opened, 'token': result['token']}, 'renew', {})
        self.assertIn('token', renewed)
        now[0] = 100.23
        with self.assertRaises(ValueError):
            await self.send({**opened, 'token': renewed['token']}, 'renew', {})

    async def test_release_after_expiry_waits_for_scheduled_cleanup_before_claiming_completion(self):
        opened = await self.session.motion.open('tab')
        await self.send(opened, 'drive', {'left': 20, 'right': 20, 'flags': 0})
        before = len(self.gatt.commands)
        self.session.motion._expire()
        result = await self.session.motion.release('tab', opened['lease_id'])
        self.assertEqual(result['state'], 'completed')
        self.assertTrue(any(c['did'] == 22 and c['cid'] == 8 and c['data'] == bytes(3) for c in self.gatt.commands[before:]))
        self.assertEqual(self.session.snapshot()['control'], 'ready')
        self.assertTrue(self.gatt.is_connected)
