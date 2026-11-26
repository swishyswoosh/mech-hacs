"""Operation policies through the production client/session and native wire boundary."""
import asyncio
import copy
import json
from types import SimpleNamespace

import pytest

from test_bluetooth_client import D, Storage
from test_bluetooth_protocol import FakeGatt
from custom_components.mech.api import APIError
from custom_components.mech.bluetooth_client import BluetoothClient
from custom_components.mech import bluetooth_client as client_module
from custom_components.mech import bluetooth_protocol as protocol


class GatedGatt(FakeGatt):
    """Hold one matching STOP reply while preserving all native session logic."""
    def __init__(self):
        super().__init__()
        self.hold_stop = False
        self.held_reply = None
        self.stop_waiting = asyncio.Event()

    def notify(self, frame):
        packet = protocol.PacketDecoder().push(frame)[0]
        if self.hold_stop and (packet['did'], packet['cid']) == (26, 10):
            self.held_reply = frame
            self.stop_waiting.set()
        else:
            super().notify(frame)

    def release_stop(self):
        self.hold_stop = False
        if self.held_reply is not None:
            super().notify(self.held_reply)
            self.held_reply = None


async def wait_until(predicate):
    async with asyncio.timeout(1):
        while not predicate():
            await asyncio.sleep(0)


def effects(gatt):
    return [p for p in gatt.commands if (p['did'], p['cid']) in {(26, 7), (26, 14)}]


@pytest.fixture
async def native():
    clients = []

    async def make(storage=None):
        gatt = GatedGatt()
        async def connect(callback):
            gatt.on_disconnect = callback
            return gatt
        def session_factory(address, name, _connect, **kwargs):
            return protocol.DroidBluetoothSession(address, name, connect, timeout=0.5, **kwargs)
        hass = SimpleNamespace(data={}, async_create_task=asyncio.create_task)
        entry = SimpleNamespace(entry_id='entry', data={
            'address': 'AA:BB:CC:DD:EE:FF', 'name': 'R2',
            'instance_id': 'ha-bluetooth:AA:BB:CC:DD:EE:FF', 'droid_ids': [D]})
        client = BluetoothClient(hass, entry, session_factory=session_factory, store=storage or Storage())
        await client.async_initialize()
        await client.operate(D, 'connection.connect', {}, key='connect')
        await client.operate(D, 'activity.stop', {}, key='initial-stop')
        gatt.commands.clear()
        clients.append((client, gatt))
        return client, gatt

    yield make
    for client, gatt in clients:
        gatt.release_stop()
        await client.async_close()


async def long_protocol(client, gatt):
    recipe = {'version': 1, 'name': 'Long', 'frames': [
        {'atMs': 0, 'controls': [1] * 8, 'transitionMs': 65535}]}
    await client.save_preferences(D, 0, {'device.light-recipe.v1': json.dumps(recipe)})
    accepted = await client.submit(D, 'protocol.run', {'protocol_id': 'protocol-device-lights'}, key='long')
    await wait_until(lambda: client.session._activity == 'device-lights')
    assert any((p['did'], p['cid']) == (23, 26) and len(p['data']) > 6 for p in gatt.commands)
    return accepted


async def test_replace_cancels_running_protocol_and_waits_for_matching_stop(native):
    client, gatt = await native()
    old = await long_protocol(client, gatt)
    gatt.hold_stop = True
    replacement = asyncio.create_task(client.operate(
        D, 'sound.play', {'sound_id': 'sound:23'}, {'if_busy': 'replace'}, key='replace'))
    try:
        await asyncio.wait_for(gatt.stop_waiting.wait(), 1)
        assert not replacement.done()
        assert effects(gatt) == []
        assert (await client.operation(old['operation_id']))['state'] == 'interrupted'
    finally:
        gatt.release_stop()
    result = await replacement
    assert result['state'] == 'dispatched'
    assert [(p['did'], p['cid']) for p in effects(gatt)] == [(26, 7)]
    before = copy.deepcopy(gatt.commands)
    assert await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, {'if_busy': 'replace'}, key='replace') == result
    assert gatt.commands == before
    assert gatt.is_connected


@pytest.mark.parametrize(('busy_policy', 'state'), [('error', 'failed'), ('skip', 'skipped')])
async def test_busy_error_and_skip_are_durable_without_stop_or_queue(native, busy_policy, state):
    client, gatt = await native()
    old = await long_protocol(client, gatt)
    before = copy.deepcopy(gatt.commands)
    policy = {'if_busy': busy_policy}
    result = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='busy')
    assert result['state'] == state
    assert gatt.commands == before
    assert (await client.operation(old['operation_id']))['state'] == 'running'
    await client.operate(D, 'activity.stop', {}, key='stop-old')
    assert await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='busy') == result
    assert effects(gatt) == []
    assert client._store.data['operations'][result['operation_id']]['state'] == state


async def test_expiry_during_cooldown_save_releases_unused_hour_reservation(native, monkeypatch):
    client, gatt = await native()
    now = [client_module.time.monotonic()]
    # Isolate the admission clock; freezing Python's time module also freezes
    # asyncio's STOP/watchdog timers and can strand fixture cleanup.
    monkeypatch.setattr(client_module, 'time', SimpleNamespace(
        monotonic=lambda: now[0], time=client_module.time.time))
    save = client._store.async_save
    slow = True
    async def slow_save(value):
        nonlocal slow
        if slow and any(op['state'] == 'running' for op in value['operations'].values()):
            now[0] += 1
            slow = False
        await save(value)
    client._store.async_save = slow_save
    policy = {'expires_in_ms': 100, 'cooldown_key': 'doorbell', 'cooldown_ms': 3600000}
    expired = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='expired')
    assert expired['state'] == 'expired'
    assert effects(gatt) == []
    result = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='fresh')
    assert result['state'] == 'dispatched'
    assert len(effects(gatt)) == 1
    assert await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='expired') == expired


async def test_newer_replace_wins_and_skip_during_stop_never_queues(native):
    client, gatt = await native()
    await long_protocol(client, gatt)
    gatt.hold_stop = True
    first = asyncio.create_task(client.operate(
        D, 'sound.play', {'sound_id': 'sound:23'}, {'if_busy': 'replace'}, key='older'))
    await asyncio.wait_for(gatt.stop_waiting.wait(), 1)
    second = await client.submit(
        D, 'lights.apply', {'preset_id': 'preset-off'}, {'if_busy': 'replace'}, key='newer')
    skipped = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, key='skip')
    assert skipped['state'] == 'skipped'
    assert effects(gatt) == []
    gatt.release_stop()
    assert (await first)['state'] == 'interrupted'
    await asyncio.gather(*client._background)
    assert (await client.operation(second['operation_id']))['state'] == 'dispatched'
    assert [(p['did'], p['cid']) for p in effects(gatt)] == [(26, 14)]
    assert await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, key='skip') == skipped


async def test_explicit_stop_supersedes_replacement_waiting_for_cleanup(native):
    client, gatt = await native()
    await long_protocol(client, gatt)
    gatt.hold_stop = True
    replacement = asyncio.create_task(client.operate(
        D, 'sound.play', {'sound_id': 'sound:23'}, {'if_busy': 'replace'}, key='replace'))
    await asyncio.wait_for(gatt.stop_waiting.wait(), 1)
    stopped = asyncio.create_task(client.operate(D, 'activity.stop', {}, key='explicit-stop'))
    await wait_until(lambda: any(op['action'] == 'activity.stop' and op['state'] == 'accepted'
                                 for op in client._data['operations'].values()))
    gatt.release_stop()
    assert (await stopped)['state'] == 'completed'
    assert (await replacement)['state'] == 'interrupted'
    assert effects(gatt) == []
    assert gatt.is_connected


async def test_unsaved_replacement_does_not_stop_running_protocol(native):
    client, gatt = await native()
    old = await long_protocol(client, gatt)
    before = copy.deepcopy(gatt.commands)
    client._store.fail = True
    with pytest.raises(APIError, match='no command was sent'):
        await client.operate(D, 'sound.play', {'sound_id': 'sound:23'},
                             {'if_busy': 'replace'}, key='unsaved')
    assert gatt.commands == before
    assert (await client.operation(old['operation_id']))['state'] == 'running'
    client._store.fail = False


async def test_replacement_expired_during_admission_does_not_stop_protocol(native, monkeypatch):
    client, gatt = await native()
    old = await long_protocol(client, gatt)
    before = copy.deepcopy(gatt.commands)
    now = [client_module.time.monotonic()]
    monkeypatch.setattr(client_module, 'time', SimpleNamespace(
        monotonic=lambda: now[0], time=client_module.time.time))
    save = client._store.async_save
    async def slow_save(value):
        if any(op['action'] == 'sound.play' and op['state'] == 'accepted' for op in value['operations'].values()):
            now[0] += 1
        await save(value)
    client._store.async_save = slow_save
    policy = {'if_busy': 'replace', 'expires_in_ms': 100}
    result = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='expired')
    assert result['state'] == 'expired'
    assert (await client.operation(old['operation_id']))['state'] == 'running'
    assert gatt.commands == before


async def test_replacement_expired_during_native_cleanup_is_not_replayed(native):
    client, gatt = await native()
    await long_protocol(client, gatt)
    policy = {'if_busy': 'replace', 'expires_in_ms': 100, 'cooldown_key': 'alert', 'cooldown_ms': 3600000}
    result = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='expired')
    assert result['state'] == 'expired'
    assert effects(gatt) == []
    assert 'alert' not in client._store.data['cooldowns']
    assert await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='expired') == result
    fresh = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='fresh')
    assert fresh['state'] == 'dispatched'
    assert len(effects(gatt)) == 1


async def test_failed_cooldown_save_releases_unsent_reservation(native):
    client, gatt = await native()
    save = client._store.async_save
    fail = True
    async def fail_running_once(value):
        nonlocal fail
        if fail and any(op['state'] == 'running' for op in value['operations'].values()):
            fail = False
            raise OSError('disk failed')
        await save(value)
    client._store.async_save = fail_running_once
    policy = {'cooldown_key': 'alert', 'cooldown_ms': 3600000}
    failed = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='failed')
    assert failed['state'] == 'failed'
    assert effects(gatt) == []
    assert 'alert' not in client._store.data['cooldowns']
    assert (await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='fresh'))['state'] == 'dispatched'


@pytest.mark.parametrize('cancel', ['stop', 'task'])
async def test_cancellation_during_final_save_releases_unsent_cooldown(native, cancel):
    client, gatt = await native()
    entered, release = asyncio.Event(), asyncio.Event()
    save = client._store.async_save
    pause = True
    async def pause_running_once(value):
        nonlocal pause
        if pause and any(op['state'] == 'running' for op in value['operations'].values()):
            pause = False
            entered.set()
            await release.wait()
        await save(value)
    client._store.async_save = pause_running_once
    policy = {'cooldown_key': 'alert', 'cooldown_ms': 3600000}
    effect = asyncio.create_task(client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='canceled'))
    await entered.wait()
    if cancel == 'task':
        effect.cancel()
        with pytest.raises(asyncio.CancelledError):
            await effect
    else:
        gatt.hold_stop = True
        stopped = asyncio.create_task(client.operate(D, 'activity.stop', {}, key='priority-stop'))
        await asyncio.wait_for(gatt.stop_waiting.wait(), 1)
        # STOP reached GATT while the ordinary effect still owns the storage lock.
        assert not effect.done()
        release.set()
        assert (await effect)['state'] == 'interrupted'
        gatt.release_stop()
        assert (await stopped)['state'] == 'completed'
    assert effects(gatt) == []
    assert 'alert' not in client._store.data['cooldowns']
    assert next(op for op in client._store.data['operations'].values()
                if op['action'] == 'sound.play')['state'] == 'interrupted'
    assert (await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='fresh'))['state'] == 'dispatched'


@pytest.mark.parametrize('uncertain', [False, True])
async def test_dispatched_or_uncertain_effect_retains_durable_cooldown(native, uncertain):
    client, gatt = await native()
    if uncertain:
        gatt.ignore.add((26, 7))
    policy = {'cooldown_key': 'alert', 'cooldown_ms': 3600000}
    result = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='first')
    assert result['state'] == ('failed' if uncertain else 'dispatched')
    assert len(effects(gatt)) == 1
    assert 'alert' in client._store.data['cooldowns']
    # A new client has the same durable policy state without replaying the effect.
    restarted = BluetoothClient(client.hass, client.entry, store=client._store)
    await restarted.async_initialize()
    assert await restarted.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='first') == result
    if uncertain:
        with pytest.raises(APIError, match='failed'):
            await restarted.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='fresh')
    else:
        skipped = await restarted.operate(D, 'sound.play', {'sound_id': 'sound:23'}, policy, key='fresh')
        assert skipped['state'] == 'skipped' and skipped['reason'] == 'Cooldown active'
    assert len(effects(gatt)) == 1


async def test_priority_stop_fences_replacement_while_admission_is_blocked(native):
    client, gatt = await native()
    await long_protocol(client, gatt)
    entered, release = asyncio.Event(), asyncio.Event()
    save = client._store.async_save
    pause = True
    async def paused_admission(value):
        nonlocal pause
        if pause and any(op['action'] == 'sound.play' and op['state'] == 'accepted'
                         for op in value['operations'].values()):
            pause = False
            entered.set()
            await release.wait()
        await save(value)
    client._store.async_save = paused_admission
    replacement = asyncio.create_task(client.operate(
        D, 'sound.play', {'sound_id': 'sound:23'}, {'if_busy': 'replace'}, key='replace'))
    await entered.wait()
    gatt.hold_stop = True
    stopped = asyncio.create_task(client.operate(D, 'activity.stop', {}, key='priority-stop'))
    await asyncio.wait_for(gatt.stop_waiting.wait(), 1)
    assert not replacement.done()
    assert effects(gatt) == []
    release.set()
    assert (await replacement)['state'] == 'interrupted'
    gatt.release_stop()
    assert (await stopped)['state'] == 'completed'
    assert effects(gatt) == []


async def test_canceling_replace_waiter_keeps_stop_barrier_and_does_not_replay(native):
    client, gatt = await native()
    await long_protocol(client, gatt)
    gatt.hold_stop = True
    replacement = asyncio.create_task(client.operate(
        D, 'sound.play', {'sound_id': 'sound:23'}, {'if_busy': 'replace'}, key='replace'))
    await asyncio.wait_for(gatt.stop_waiting.wait(), 1)
    replacement.cancel()
    with pytest.raises(asyncio.CancelledError):
        await replacement
    canceled = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'},
                                    {'if_busy': 'replace'}, key='replace')
    assert canceled['state'] == 'interrupted'
    assert effects(gatt) == []
    assert client.session.snapshot()['control'] == 'blocked'
    gatt.release_stop()
    assert (await client.operate(D, 'activity.stop', {}, key='finish-stop'))['state'] == 'completed'
    assert effects(gatt) == []


async def test_failed_replace_stop_latches_failure_without_dispatch(native):
    client, gatt = await native()
    await long_protocol(client, gatt)
    gatt.errors[(23, 13)] = 1
    try:
        result = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'},
                                      {'if_busy': 'replace'}, key='replace')
        assert result['state'] == 'failed'
        assert (await client.snapshot(D))['stop_failure']
        assert (await client.snapshot(D))['control'] == 'ready'
        assert client._store.data['fault']
        assert effects(gatt) == []
        fresh = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'}, key='fresh')
        assert fresh['state'] == 'dispatched'
    finally:
        gatt.errors.clear()


@pytest.mark.parametrize('action', ['sound.play', 'activity.stop'])
async def test_empty_timeout_message_does_not_erase_durable_native_fault(native, action):
    client, gatt = await native()
    gatt.ignore.add((26, 7) if action == 'sound.play' else (23, 13))
    try:
        params = {'sound_id': 'sound:23'} if action == 'sound.play' else {}
        result = await client.operate(D, action, params, key='timeout')
        assert result['state'] == 'failed'
        assert client._store.data['fault']
        restarted = BluetoothClient(client.hass, client.entry, store=client._store)
        await restarted.async_initialize()
        assert (await restarted.snapshot(D))['control'] == 'failed'
        with pytest.raises(APIError, match='failed'):
            await restarted.operate(D, 'sound.play', {'sound_id': 'sound:23'}, key='fresh')
        assert await restarted.operate(D, action, params, key='timeout') == result
    finally:
        gatt.ignore.clear()


@pytest.mark.parametrize('failed', [False, True])
async def test_unload_settles_stop_after_its_caller_is_canceled(native, failed):
    client, gatt = await native()
    gatt.hold_stop = True
    stopped = asyncio.create_task(client.operate(D, 'activity.stop', {}, key='canceled-stop'))
    await asyncio.wait_for(gatt.stop_waiting.wait(), 1)
    stopped.cancel()
    with pytest.raises(asyncio.CancelledError):
        await stopped
    closing = asyncio.create_task(client.async_close())
    await asyncio.sleep(0)
    assert not closing.done()
    assert gatt.is_connected
    if failed:
        with pytest.raises(TimeoutError):
            await closing
    else:
        gatt.release_stop()
        await closing
    assert not gatt.is_connected
    before = copy.deepcopy(gatt.commands)
    restored = BluetoothClient(client.hass, client.entry, store=client._store)
    await restored.async_initialize()
    result = await restored.operate(D, 'activity.stop', {}, key='canceled-stop')
    assert result['state'] == ('failed' if failed else 'completed')
    assert gatt.commands == before
    assert client._store.data['operations'][result['operation_id']]['state'] == result['state']
    if failed:
        assert (await restored.snapshot(D))['control'] == 'failed'
