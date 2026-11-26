"""Authenticated cockpit routes reach real encoded commands, never raw API input."""
import asyncio
from types import SimpleNamespace
import pytest
from test_bluetooth_protocol import FakeGatt, p
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parents[2]))
from custom_components.mech.panel import PanelService

@pytest.fixture
async def live_panel():
    gatt = FakeGatt()
    async def connector(callback):
        gatt.on_disconnect = callback
        return gatt
    session = p.DroidBluetoothSession('A', 'R2', connector, timeout=.08)
    await session.connect()
    class Client:
        async def snapshot(self, droid):
            return {'name':'R2','droid_id':droid, **session.snapshot()}
        async def operate(self, *args):
            await session.stop()
            return {'state':'completed'}
    client = Client()
    client.session = session
    entry = SimpleNamespace(entry_id='entry', data={'transport':'bluetooth','droid_ids':['r2']})
    coordinator = SimpleNamespace(entry=entry, client=client, assert_identity=lambda:None)
    hass = SimpleNamespace(data={'mech':{'entry':coordinator}}, async_create_task=asyncio.create_task)
    panel = PanelService(hass)
    await panel.request('admin','POST','ui/heartbeat',{'client_id':'tab','droid_id':'r2','visible':True},None)
    yield panel, session, gatt
    await session.close()

async def test_cockpit_animation_reaches_firmware_and_focus_release_keeps_connection(live_panel):
    panel, session, gatt = live_panel
    state = await panel.snapshot('r2')
    assert state['capabilities']['motion'] is True
    opened = await panel.request('admin','POST','droids/r2/motion/open',{'client_id':'tab'},None)
    result = await panel.request('admin','POST','droids/r2/motion/command',{
        'client_id':'tab',**opened,'action':'animation','parameters':{'animation_id':'animation:16'}},None)
    assert result['confirmation'] == 'ack'
    assert gatt.commands[-1]['data'] == b'\x00\x10'
    await panel.request('admin','POST','ui/release',{'client_id':'tab','droid_id':'r2'},None)
    assert gatt.is_connected
    assert not session.motion.active
    with pytest.raises(ValueError):
        await panel.request('admin','POST','droids/r2/motion/open',{'client_id':'tab'},None)

async def test_other_user_cannot_borrow_visible_lease(live_panel):
    panel, session, gatt = live_panel
    with pytest.raises(ValueError):
        await panel.request('other','POST','droids/r2/motion/open',{'client_id':'tab'},None)
    assert not session.motion.active

async def test_sensor_snapshot_supplies_both_readouts_and_heading(live_panel):
    panel, session, _ = live_panel
    session.telemetry._sensors['values'] = {'attitude.yaw': 12.5, 'rawGyroscope.x': -.1}
    snapshot = (await panel.snapshot('r2'))['session']
    assert snapshot['sensors']['values']['rawGyroscope.x'] == -.1
    assert snapshot['telemetry']['sensors']['values']['attitude.yaw'] == 12.5
