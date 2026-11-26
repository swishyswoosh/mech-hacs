"""A failed joystick exchange must not turn acknowledged cleanup into a dead end."""
import asyncio
from types import SimpleNamespace

import pytest

from test_bluetooth_client import Storage, D
from test_bluetooth_protocol import FakeGatt
from custom_components.mech.bluetooth_client import BluetoothClient
from custom_components.mech.bluetooth_protocol import DroidBluetoothSession
from custom_components.mech.panel import PanelService


@pytest.fixture
async def controller():
    gatt = FakeGatt()
    store = Storage()
    hass = SimpleNamespace(data={}, async_create_task=asyncio.create_task)
    entry = SimpleNamespace(entry_id='recovery', data={
        'transport': 'bluetooth', 'address': 'AA:BB:CC:DD:EE:FF',
        'instance_id': 'ha-bluetooth:AA:BB:CC:DD:EE:FF', 'droid_ids': [D], 'name': 'R2'})
    async def connector(callback):
        gatt.on_disconnect = callback
        return gatt
    def factory(address, name, unused_connector, on_change):
        return DroidBluetoothSession(address, name, connector, on_change, timeout=.05)
    client = BluetoothClient(hass, entry, session_factory=factory, store=store)
    await client.async_initialize()
    await client.operate(D, 'connection.connect', {})
    hass.data['mech'] = {'recovery': SimpleNamespace(entry=entry, client=client, assert_identity=lambda: None)}
    panel = PanelService(hass)
    yield panel, client, gatt, store
    gatt.ignore.clear()
    gatt.errors.clear()
    await client.session.close()


async def heartbeat(panel):
    return await panel.request('owner', 'POST', 'ui/heartbeat', {'client_id': 'tab', 'droid_id': D, 'visible': True}, None)


async def test_timed_out_joystick_can_stop_then_take_a_fresh_gesture(controller):
    panel, client, gatt, store = controller
    await heartbeat(panel)
    opened = await panel.request('owner', 'POST', f'droids/{D}/motion/open', {'client_id': 'tab'}, None)
    gatt.ignore.add((22, 8))
    with pytest.raises(TimeoutError):
        await panel.request('owner', 'POST', f'droids/{D}/motion/command', {
            'client_id': 'tab', **opened, 'action': 'drive', 'parameters': {'left': 20, 'right': 20, 'flags': 0}}, None)
    # Let the scheduled safety cleanup reach its failed response deadline.
    if client.session.motion._cleanup:
        await asyncio.gather(client.session.motion._cleanup, return_exceptions=True)
    with pytest.raises(ValueError):
        await panel.stop(D)
    assert gatt.is_connected

    gatt.ignore.clear()
    result = await panel.stop(D)
    assert result['state'] == 'completed'
    assert (await panel.snapshot(D))['session']['state'] == 'ready'
    assert store.data['fault'] is None
    # A delayed release from the failed gesture cannot resurrect its old error.
    await client.session.motion.release(('owner', 'tab'), opened['lease_id'])
    await heartbeat(panel)
    fresh = await panel.request('owner', 'POST', f'droids/{D}/motion/open', {'client_id': 'tab'}, None)
    assert fresh['lease_id'] != opened['lease_id']
    result = await panel.request('owner', 'POST', f'droids/{D}/motion/command', {
        'client_id': 'tab', **fresh, 'action': 'drive', 'parameters': {'left': 10, 'right': 10, 'flags': 0}}, None)
    assert result['confirmation'] == 'ack'
    assert gatt.disconnect_count == 0


async def test_disconnect_after_fault_confirms_stop_and_sleep(controller):
    panel, client, gatt, store = controller
    gatt.ignore.add((22, 7))
    with pytest.raises(ValueError):
        await panel.stop(D)
    gatt.ignore.clear()
    result = await client.operate(D, 'connection.disconnect', {})
    assert result['state'] == 'completed'
    assert result['confirmation'] == 'notification'
    assert not gatt.is_connected
    assert store.data['fault'] is None


async def test_non_drive_stop_rejection_does_not_prevent_wheel_zero(controller):
    panel, client, gatt, _ = controller
    gatt.errors[(23, 13)] = 7
    before = len(gatt.commands)
    with pytest.raises(ValueError):
        await panel.stop(D)
    assert any((c['did'], c['cid'], c['data']) == (22, 7, bytes(4)) and c['flags'] & 2
               for c in gatt.commands[before:])
    assert gatt.is_connected
    assert not client.session.snapshot()['drive_stop_unconfirmed']
    await heartbeat(panel)
    opened = await panel.request('owner', 'POST', f'droids/{D}/motion/open', {'client_id': 'tab'}, None)
    result = await panel.request('owner', 'POST', f'droids/{D}/motion/command', {
        'client_id': 'tab', **opened, 'action': 'drive', 'parameters': {'left': 10, 'right': 10, 'flags': 0}}, None)
    assert result['confirmation'] == 'ack'


async def test_unconfirmed_wheel_stop_blocks_only_new_wheel_demand(controller):
    panel, client, gatt, _ = controller
    gatt.ignore.add((22, 7))
    with pytest.raises(ValueError):
        await panel.stop(D)
    await heartbeat(panel)
    opened = await panel.request('owner', 'POST', f'droids/{D}/motion/open', {'client_id': 'tab'}, None)
    before = len(gatt.commands)
    with pytest.raises(RuntimeError, match='[Ww]heel.*[Ss]top|[Dd]rive.*[Ss]top'):
        await panel.request('owner', 'POST', f'droids/{D}/motion/command', {
            'client_id': 'tab', **opened, 'action': 'drive', 'parameters': {'left': 10, 'right': 10, 'flags': 0}}, None)
    assert not any(c['did'] == 22 and any(c['data']) for c in gatt.commands[before:])
    result = await panel.request('owner', 'POST', f'droids/{D}/motion/command', {
        'client_id': 'tab', **opened, 'action': 'dome', 'parameters': {'degrees': 10}}, None)
    assert result['confirmation'] == 'ack'
    with pytest.raises(TimeoutError):
        await client.session.motion.release(('owner', 'tab'), opened['lease_id'])
    result = await client.operate(D, 'sound.play', {'sound_id': 'sound:23'})
    assert result['state'] == 'dispatched'
    assert client.session.snapshot()['drive_stop_unconfirmed']
    assert gatt.is_connected


async def test_low_battery_exception_does_not_hide_a_separate_wheel_rejection(controller):
    _, client, gatt, _ = controller
    gatt.errors.update({(23, 13): 4, (22, 7): 7})
    result = await client.operate(D, 'connection.disconnect', {})
    assert result['state'] == 'failed'
    assert not any(c['did'] == 19 and c['cid'] == 1 for c in gatt.commands)
    assert gatt.is_connected


async def test_saved_failure_allows_explicit_connect_only_after_new_cleanup(controller):
    _, client, _, store = controller
    store.data['fault'] = 'Earlier wheel stop was unconfirmed'
    new_gatt = FakeGatt()
    def factory(address, name, unused_connector, on_change):
        async def connector(callback):
            new_gatt.on_disconnect = callback
            return new_gatt
        return DroidBluetoothSession(address, name, connector, on_change, timeout=.05)
    restored = BluetoothClient(client.hass, client.entry, session_factory=factory, store=store)
    await restored.async_initialize()
    assert not new_gatt.commands
    assert (await restored.snapshot(D))['control'] == 'failed'
    restored.hass.data['mech']['recovery'].client = restored
    panel = PanelService(restored.hass)
    panel.failed.add(D)
    try:
        await heartbeat(panel)
        result = await panel.request('owner', 'POST', f'droids/{D}/operations', {
            'client_id': 'tab', 'action': 'connection.connect', 'parameters': {}}, 'recovery-connect')
        if result['state'] == 'accepted':
            while result['state'] == 'accepted':
                await asyncio.sleep(.001)
                result = await panel.request('owner', 'GET', f"operations/{result['operation_id']}", None, None)
        assert result['state'] == 'completed'
        assert (await panel.snapshot(D))['session']['state'] == 'ready'
        assert store.data['fault'] is None
        assert any(c['did'] == 22 and c['cid'] == 7 and not any(c['data']) for c in new_gatt.commands)
    finally:
        await restored.session.close()
