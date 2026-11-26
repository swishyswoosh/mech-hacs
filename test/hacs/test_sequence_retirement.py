"""Sequence reuse after matched replies, with ambiguous exchanges fenced off."""
import asyncio
import unittest

from test_bluetooth_protocol import FakeGatt, p


class SequenceRetirementTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.gatt = FakeGatt()

        async def connector(callback):
            self.gatt.on_disconnect = callback
            return self.gatt

        self.session = p.DroidBluetoothSession('AA', 'R2', connector, timeout=0.05)

    async def asyncTearDown(self):
        self.gatt.ignore.clear()
        self.gatt.errors.clear()
        await self.session.close()

    async def pending(self, did, cid):
        for _ in range(100):
            await asyncio.sleep(0)
            pending = self.session._pending
            if pending and pending[:2] == (did, cid):
                return pending[2]
        self.fail(f'No pending exchange for {did}/{cid}')

    async def test_optional_bad_cid_replies_allow_300_successful_stops(self):
        self.gatt.errors.update({(23, cid): 2 for cid in (10, 45, 47)})
        await self.session.connect()
        for completed in range(300):
            try:
                await self.session.stop()
            except RuntimeError as error:
                self.fail(f'STOP {completed + 1} failed: {error}')
            self.assertEqual(self.session.snapshot()['control'], 'ready')
        self.assertTrue(self.gatt.is_connected)
        self.assertFalse(self.session.busy)
        result = await self.session.execute('lights.apply', {'preset_id': 'preset-off'})
        self.assertEqual(result['confirmation'], 'ack')

    async def test_malformed_or_unmatched_negative_replies_do_not_complete_stop(self):
        await self.session.connect()
        self.gatt.ignore.add((23, 10))
        stopping = asyncio.create_task(self.session.stop())
        seq = await self.pending(23, 10)
        # This frame has the right identity but an invalid checksum.
        corrupt = bytearray(p.encode_packet(23, 10, b'', seq, flags=1, error=2))
        corrupt[-2] ^= 1
        frames = [
            bytes(corrupt),
            p.encode_packet(22, 10, b'', seq, flags=1, error=2),
            p.encode_packet(23, 45, b'', seq, flags=1, error=2),
            p.encode_packet(23, 10, b'', seq % 254 + 1, flags=1, error=2),
            p.encode_packet(23, 10, b'\x02', seq, flags=0),
        ]
        for frame in frames:
            self.gatt.notify(frame)
            await asyncio.sleep(0)
            self.assertFalse(stopping.done())
            self.assertEqual(self.session.snapshot()['control'], 'blocked')
        self.gatt.ignore.clear()
        self.gatt.notify(p.encode_packet(23, 10, b'', seq, flags=1, error=2))
        await stopping
        self.assertEqual(self.session.snapshot()['control'], 'ready')

    async def test_canceled_sequence_is_not_reused_or_completed_by_late_error(self):
        await self.session.connect()
        self.gatt.ignore.add((26, 14))
        action = asyncio.create_task(self.session.execute('lights.apply', {'preset_id': 'preset-off'}))
        canceled_seq = await self.pending(26, 14)
        await self.session.stop()
        with self.assertRaises(p.CommandCancelled):
            await action
        self.gatt.ignore.clear()
        for _ in range(300):
            result = await self.session.execute('lights.apply', {'preset_id': 'preset-off'})
            self.assertNotEqual(result['evidence']['sequence'], canceled_seq)
        self.gatt.ignore.add((26, 14))
        action = asyncio.create_task(self.session.execute('lights.apply', {'preset_id': 'preset-off'}))
        active_seq = await self.pending(26, 14)
        self.gatt.notify(p.encode_packet(26, 14, b'', canceled_seq, flags=1, error=2))
        await asyncio.sleep(0)
        self.assertFalse(action.done())
        self.gatt.notify(p.encode_packet(26, 14, b'', active_seq, flags=1))
        self.assertEqual((await action)['confirmation'], 'ack')
        self.assertEqual(self.session.snapshot()['control'], 'ready')

    async def test_timed_out_sequence_stays_fenced_after_confirmed_stop_recovery(self):
        await self.session.connect()
        self.gatt.ignore.add((23, 10))
        stopping = asyncio.create_task(self.session.stop())
        timed_out_seq = await self.pending(23, 10)
        with self.assertRaises(TimeoutError):
            await stopping
        self.gatt.ignore.clear()
        start = len(self.gatt.commands)
        for _ in range(100):
            await self.session.stop()
        requested = [c['seq'] for c in self.gatt.commands[start:] if c['flags'] & 2]
        self.assertGreater(len(requested), 254)
        self.assertNotIn(timed_out_seq, requested)
        self.assertEqual(self.session.snapshot()['control'], 'ready')
        self.gatt.ignore.add((23, 10))
        stopping = asyncio.create_task(self.session.stop())
        active_seq = await self.pending(23, 10)
        self.gatt.notify(p.encode_packet(23, 10, b'', timed_out_seq, flags=1, error=2))
        await asyncio.sleep(0)
        self.assertFalse(stopping.done())
        self.gatt.ignore.clear()
        self.gatt.notify(p.encode_packet(23, 10, b'', active_seq, flags=1, error=2))
        await stopping
        self.assertEqual(self.session.snapshot()['control'], 'ready')
        self.assertTrue(self.gatt.is_connected)
