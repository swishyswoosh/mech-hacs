"""Reproduce the HA startup failure when R2 reports a stance transition."""
import asyncio
import copy
import time
import unittest

from test_bluetooth_protocol import FakeGatt, p


class TransitionGatt(FakeGatt):
    def __init__(self, replies=(8, 0)):
        super().__init__()
        self.replies = iter(replies)
        self.last_reply = 0
        self.stop_attempts = []
        self.hold_reply_after_transition = False

    async def write_gatt_char(self, uuid, data, response):
        if uuid == p.API:
            for packet in p.PacketDecoder().push(data):
                if (packet['did'], packet['cid']) == (22, 7) and packet['flags'] & 2:
                    self.stop_attempts.append(packet)
                    self.last_reply = next(self.replies, self.last_reply)
                    self.errors[(22, 7)] = self.last_reply
                    if self.hold_reply_after_transition and len(self.stop_attempts) > 1:
                        self.ignore.add((22, 7))
        await super().write_gatt_char(uuid, data, response)


class StartupStopTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.gatt = TransitionGatt()

        async def connector(callback):
            self.gatt.on_disconnect = callback
            return self.gatt

        self.session = p.DroidBluetoothSession(
            'AA:BB:CC:DD:EE:FF', 'R2', connector, timeout=0.3,
        )

    async def asyncTearDown(self):
        await self.session.close()

    async def test_connect_waits_for_ack_after_zero_speed_stance_transition(self):
        await self.session.connect()
        self.assertEqual(self.session.snapshot()['control'], 'ready')
        self.assertTrue(self.gatt.is_connected)
        self.assertEqual(len(self.gatt.stop_attempts), 2)
        self.assertEqual([packet['data'] for packet in self.gatt.stop_attempts], [b'\0' * 4] * 2)
        self.assertNotEqual(self.gatt.stop_attempts[0]['seq'], self.gatt.stop_attempts[1]['seq'])
        self.assertEqual(sum((packet['did'], packet['cid']) == (19, 13) for packet in self.gatt.commands), 1)
        self.assertEqual((self.gatt.commands[-1]['did'], self.gatt.commands[-1]['cid']), (26, 10))

    async def test_transition_without_ack_stays_failed_within_original_deadline(self):
        self.gatt.replies = iter((8,))
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(self.session.connect(), 0.8)
        self.assertLess(time.monotonic() - started, 0.6)
        self.assertGreater(len(self.gatt.stop_attempts), 1)
        self.assertEqual(self.session.snapshot()['control'], 'failed')
        self.assertIsNone(self.session._connecting)
        self.assertFalse(self.gatt.is_connected)

    async def test_missing_reply_after_transition_does_not_get_a_fresh_deadline(self):
        self.gatt.hold_reply_after_transition = True
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(self.session.connect(), 0.8)
        self.assertLess(time.monotonic() - started, 0.46)
        self.assertEqual(len(self.gatt.stop_attempts), 2)
        self.assertEqual(self.session.snapshot()['control'], 'failed')

    async def test_other_drive_rejection_is_not_retried(self):
        self.gatt.replies = iter((4, 0))
        with self.assertRaises(p.DroidResponseError):
            await self.session.connect()
        self.assertEqual(len(self.gatt.stop_attempts), 1)
        self.assertEqual(self.session.snapshot()['control'], 'failed')

    async def test_nonzero_drive_is_never_replayed_by_cleanup(self):
        self.session._safety_commands = lambda: [(22, 7, b'\x01\0\0\0')]
        with self.assertRaises(p.DroidResponseError):
            await self.session.connect()
        self.assertEqual(len(self.gatt.stop_attempts), 1)
        self.assertEqual(self.session.snapshot()['control'], 'failed')

    async def test_exhausted_startup_retry_is_durably_blocked_before_background_save(self):
        from test_bluetooth_client import APIError, D, Storage, make

        storage = Storage()
        client = make(storage)
        await client.async_initialize()
        client.session = self.session
        self.session.on_change = client._changed
        self.gatt.replies = iter((8,))
        result = await client.operate(D, 'connection.connect', {}, key='startup')
        durable = copy.deepcopy(storage.data)
        self.assertEqual(result['state'], 'failed')
        self.assertTrue(result['reason'], 'The failed Connect needs a useful cause')
        self.assertTrue(durable['fault'], 'The fault must be durable before the call returns')

        restored_storage = Storage()
        restored_storage.data = durable
        restarted = make(restored_storage)
        await restarted.async_initialize()
        self.assertEqual((await restarted.snapshot(D))['control'], 'failed')
        self.assertEqual(restarted.session.calls, [])
        await client.async_close()
