"""Native operation policy/durability tests; protocol and radio boundary injected."""
import asyncio
import copy
import sys
from pathlib import Path
from types import SimpleNamespace
import pytest
ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT))
from custom_components.mech.bluetooth_client import BluetoothClient
from custom_components.mech.api import APIError

class Storage:
    def __init__(self): self.data=None;self.fail=False
    async def async_load(self): return copy.deepcopy(self.data)
    async def async_save(self,value):
        if self.fail: raise OSError('disk failed')
        self.data=copy.deepcopy(value)
class Session:
    def __init__(self,*args,**kwargs): self.calls=[];self.connected=False;self.busy=False;self.failed=False
    def snapshot(self): return {'connection':'connected' if self.connected else 'disconnected','power':'awake' if self.connected else 'unknown','control':'failed' if self.failed else 'ready','battery_voltage':None,'detail':''}
    async def connect(self): self.calls.append('connect');self.connected=True
    async def disconnect(self): self.calls.append('disconnect');self.connected=False
    async def stop(self):
        self.calls.append('stop')
        if self.failed: raise RuntimeError('STOP unconfirmed')
    async def close(self): self.calls.append('close')
    async def execute_prepared(self,plan): self.calls.append(copy.deepcopy(plan.parameters));return {'state':'dispatched','confirmation':'ack'}

def make(storage=None):
    hass=SimpleNamespace(data={},async_create_task=asyncio.create_task)
    entry=SimpleNamespace(entry_id='entry',data={'address':'AA:BB:CC:DD:EE:FF','name':'R2','instance_id':'ha-bluetooth:AA:BB:CC:DD:EE:FF','droid_ids':['r2-aabbccddeeff']})
    return BluetoothClient(hass,entry,session_factory=Session,store=storage or Storage())
D='r2-aabbccddeeff'

async def test_setup_reads_and_catalogs_do_not_connect():
    client=make();await client.async_initialize();await client.validate();await client.droids();await client.snapshot(D);await client.catalog(D,'sounds')
    assert client.session.calls==[]
    result=await client.operate(D,'sound.play',{'sound_id':'sound:23'},key='first')
    assert result['state']=='skipped'
    assert client.session.calls==[]

async def test_durable_idempotency_no_replay_and_payload_conflict():
    storage=Storage();client=make(storage);await client.async_initialize()
    await client.operate(D,'connection.connect',{},key='connect')
    result=await client.operate(D,'lights.apply',{'preset_id':'preset-idle'},key='light')
    assert result['state']=='dispatched'
    before=copy.deepcopy(client.session.calls)
    assert await client.operate(D,'lights.apply',{'preset_id':'preset-idle'},key='light')==result
    assert client.session.calls==before
    with pytest.raises(APIError):await client.operate(D,'lights.apply',{'preset_id':'preset-off'},key='light')
    restarted=make(storage);await restarted.async_initialize()
    assert await restarted.operate(D,'lights.apply',{'preset_id':'preset-idle'},key='light')==result
    assert restarted.session.calls==[]

async def test_persistence_failure_prevents_effect_but_not_stop():
    storage=Storage();client=make(storage);await client.async_initialize();client.session.connected=True;storage.fail=True
    with pytest.raises(APIError):await client.operate(D,'lights.apply',{'preset_id':'preset-idle'},key='light')
    assert client.session.calls==[]
    result=await client.operate(D,'activity.stop',{},key='stop')
    assert 'stop' in client.session.calls
    assert result['state']=='completed'
    assert result.get('durability')=='unavailable'

async def test_failed_stop_is_persistent_and_cannot_be_cleared_by_preferences():
    storage=Storage();client=make(storage);await client.async_initialize();client.session.failed=True
    result=await client.operate(D,'activity.stop',{},key='stop')
    assert result['state']=='failed'
    restarted=make(storage);await restarted.async_initialize()
    assert (await restarted.snapshot(D))['control']=='failed'
    await restarted.save_preferences(D,0,{'theme':'light'})
    assert (await restarted.snapshot(D))['control']=='failed'

async def test_preferences_revision_conflict_preserves_neighboring_values():
    client=make();await client.async_initialize()
    saved=await client.save_preferences(D,0,{'theme':'dark','name':'R2'})
    assert saved['revision']==1
    with pytest.raises(APIError):await client.save_preferences(D,0,{'theme':'light'})
    assert (await client.preferences(D))['values']=={'theme':'dark','name':'R2'}
    with pytest.raises(APIError):await client.save_preferences(D,1,{'service.runtime.fault.x':''})


async def test_protocol_runs_the_chosen_recipe_instead_of_another_clients_saved_recipe():
    import json

    client = make()
    client.session.connected = True
    chosen = {'version': 1, 'name': 'Chosen lights', 'frames': [
        {'atMs': 0, 'transitionMs': 80, 'controls': [1, 2, 3, 4, 5, 6, 7, 8]},
    ]}
    other = {**chosen, 'name': 'Other lights', 'frames': [
        {'atMs': 0, 'transitionMs': 80, 'controls': [99] * 8},
    ]}
    await client.save_preferences(D, 0, {'device.light-recipe.v1': json.dumps(other)})
    result = await client.operate(D, 'protocol.run', {'protocol_id': 'protocol-device-lights', 'recipe': chosen})
    assert result['state'] == 'dispatched'
    assert client.session.calls == [{'protocol_id': 'protocol-device-lights', 'resolved_recipe': chosen}]
    assert json.loads((await client.preferences(D))['values']['device.light-recipe.v1']) == other


@pytest.mark.parametrize('extra', [{'audio': 1609}, {'type': 'drive', 'speed': 1}])
async def test_inline_protocol_keeps_the_light_only_validation_boundary(extra):
    client = make()
    mixed = {'version': 1, 'name': 'Mixed', 'frames': [
        {'atMs': 0, 'transitionMs': 80, 'controls': [1, 2, 3, 4, 5, 6, 7, 8], **extra},
    ]}
    with pytest.raises(ValueError):
        await client.operate(D, 'protocol.run', {'protocol_id': 'protocol-device-lights', 'recipe': mixed})
    assert client.session.calls == []

async def test_motion_and_cross_droid_requests_fail_without_radio():
    client=make();await client.async_initialize()
    for action,params in [('animation.play',{'animation_id':'animation:1'}),('drive',{})]:
        with pytest.raises((APIError,ValueError)):await client.operate(D,action,params)
    with pytest.raises(APIError):await client.snapshot('other')
    assert client.session.calls==[]

async def test_connect_uses_ha_remote_device_and_wrapper_without_private_scan(monkeypatch):
    from custom_components.mech import bluetooth_client as module
    from habluetooth import HaBleakClientWrapper
    remote=SimpleNamespace(address='AA:BB:CC:DD:EE:FF',details={'source':'pi-proxy'})
    native=SimpleNamespace()
    calls=[]
    def resolve(hass,address,*,connectable):
        calls.append(('resolve',address,connectable));return remote
    async def establish(client_class,device,name,**kwargs):
        assert issubclass(client_class,HaBleakClientWrapper)
        assert device is remote
        assert kwargs['max_attempts']==1
        calls.append(('connect',name));return native
    monkeypatch.setattr(module.bluetooth,'async_ble_device_from_address',resolve)
    monkeypatch.setattr(module,'establish_connection',establish)
    client=make();await client.async_initialize()
    assert await client._connect(lambda:None) is native
    assert calls==[('resolve','AA:BB:CC:DD:EE:FF',True),('connect','R2')]


async def test_old_disconnect_callback_cannot_release_reconnected_owner(monkeypatch):
    from custom_components.mech import bluetooth_client as module

    callbacks = []
    remote = SimpleNamespace(address='AA:BB:CC:DD:EE:FF')
    monkeypatch.setattr(module.bluetooth, 'async_ble_device_from_address', lambda *args, **kwargs: remote)

    async def establish(*args, **kwargs):
        callbacks.append(kwargs['disconnected_callback'])
        return SimpleNamespace()

    monkeypatch.setattr(module, 'establish_connection', establish)
    client = make()
    disconnected = []
    await client._connect(lambda: disconnected.append('old'))
    callbacks[0](None)
    await client._connect(lambda: disconnected.append('current'))
    callbacks[0](None)
    competitor = make()
    competitor.hass = client.hass
    with pytest.raises(APIError, match='session owner'):
        await competitor._connect(lambda: None)
    assert disconnected == ['old']
    callbacks[1](None)
    assert disconnected == ['old', 'current']
    assert await competitor._connect(lambda: None) is not None


async def test_connect_completion_cannot_reclaim_ownership_lost_during_establishment(monkeypatch):
    from custom_components.mech import bluetooth_client as module

    client = make()
    competitor = make()
    competitor.hass = client.hass
    remote = SimpleNamespace(address=client.address)
    monkeypatch.setattr(module.bluetooth, 'async_ble_device_from_address', lambda *args, **kwargs: remote)
    calls = 0

    async def establish(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            kwargs['disconnected_callback'](None)
            with pytest.raises(APIError, match='session owner'):
                await competitor._connect(lambda: None)
        return SimpleNamespace()

    monkeypatch.setattr(module, 'establish_connection', establish)
    with pytest.raises(APIError, match='lost'):
        await client._connect(lambda: None)
    assert client.address not in client.hass.data['mech_bluetooth_owners']
    assert await competitor._connect(lambda: None) is not None


async def test_canceled_preference_save_settles_before_another_revision_can_write():
    written = asyncio.Event()
    finish = asyncio.Event()

    class PendingStorage(Storage):
        async def async_save(self, value):
            await super().async_save(value)
            written.set()
            await finish.wait()

    storage = PendingStorage()
    client = make(storage)
    first = asyncio.create_task(client.save_preferences(D, 0, {'name': 'Saved name'}))
    await written.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    second = asyncio.create_task(client.save_preferences(D, 0, {'name': 'Obsolete revision'}))
    await asyncio.sleep(0)
    finish.set()
    with pytest.raises(APIError, match='changed'):
        await second
    assert await client.preferences(D) == {'revision': 1, 'values': {'name': 'Saved name'}}
    assert storage.data['preferences'] == await client.preferences(D)


async def test_unload_waits_for_canceled_preference_save_and_rejects_new_saves():
    entered = asyncio.Event()
    finish = asyncio.Event()

    class PendingStorage(Storage):
        async def async_save(self, value):
            entered.set()
            await finish.wait()
            await super().async_save(value)

    storage = PendingStorage()
    client = make(storage)
    save = asyncio.create_task(client.save_preferences(D, 0, {'theme': 'light'}))
    await entered.wait()
    save.cancel()
    with pytest.raises(asyncio.CancelledError):
        await save
    close = asyncio.create_task(client.async_close())
    await asyncio.sleep(0)
    try:
        assert not close.done()
        with pytest.raises(APIError, match='unloading'):
            await client.save_preferences(D, 0, {'theme': 'dark'})
    finally:
        finish.set()
        await close
    restarted = make(storage)
    await restarted.async_initialize()
    assert await restarted.preferences(D) == {'revision': 1, 'values': {'theme': 'light'}}


async def test_canceling_unload_does_not_cancel_the_preference_commit():
    written = asyncio.Event()
    finish = asyncio.Event()

    class PendingStorage(Storage):
        async def async_save(self, value):
            await super().async_save(value)
            written.set()
            await finish.wait()

    storage = PendingStorage()
    client = make(storage)
    save = asyncio.create_task(client.save_preferences(D, 0, {'name': 'Retained save'}))
    await written.wait()
    save.cancel()
    with pytest.raises(asyncio.CancelledError):
        await save
    close = asyncio.create_task(client.async_close())
    await asyncio.sleep(0)
    close.cancel()
    with pytest.raises(asyncio.CancelledError):
        await close
    finish.set()
    await client.async_close()
    assert await client.preferences(D) == {'revision': 1, 'values': {'name': 'Retained save'}}
    assert storage.data['preferences'] == await client.preferences(D)

async def test_spontaneous_failure_persists_before_reload():
    storage=Storage();client=make(storage);await client.async_initialize()
    client.session.failed=True;client._changed()
    await asyncio.sleep(0);await asyncio.sleep(0)
    restarted=make(storage);await restarted.async_initialize()
    assert (await restarted.snapshot(D))['control']=='failed'

async def test_busy_skip_is_durable_and_cannot_run_on_retry():
    storage=Storage();client=make(storage);await client.async_initialize();client.session.connected=True
    async with client._ordinary_lock:
        skipped=await client.operate(D,'sound.play',{'sound_id':'sound:23'},key='busy')
    assert skipped['state']=='skipped'
    restarted=make(storage);await restarted.async_initialize();restarted.session.connected=True
    assert await restarted.operate(D,'sound.play',{'sound_id':'sound:23'},key='busy')==skipped
    assert restarted.session.calls==[]

async def test_expiry_during_final_save_does_not_dispatch(monkeypatch):
    from custom_components.mech import bluetooth_client as module
    now=[100.0];monkeypatch.setattr(module.time,'monotonic',lambda:now[0])
    class SlowStorage(Storage):
        async def async_save(self,value):
            if any(op['state']=='running' for op in value['operations'].values()):now[0]+=1
            await super().async_save(value)
    client=make(SlowStorage());await client.async_initialize();client.session.connected=True
    result=await client.operate(D,'sound.play',{'sound_id':'sound:23'},{'expires_in_ms':100})
    assert result['state']=='expired'
    assert client.session.calls==[]

async def test_corrupt_nested_storage_fails_closed_without_overwrite():
    storage=Storage();client=make(storage)
    storage.data=copy.deepcopy(client._data);storage.data['keys']={'bad':{'id':'missing','digest':'x'}}
    original=copy.deepcopy(storage.data)
    with pytest.raises(APIError,match='invalid'):await client.async_initialize()
    assert storage.data==original
    assert client.session.calls==[]

async def test_rate_limit_never_blocks_stop(monkeypatch):
    from custom_components.mech import bluetooth_client as module
    monkeypatch.setattr(module.time,'monotonic',lambda:100.0)
    client=make();await client.async_initialize()
    for index in range(20):
        await client.operate(D,'sound.play',{'sound_id':'sound:23'},key=f'sound-{index}')
    with pytest.raises(APIError,match='Rate limit'):
        await client.operate(D,'sound.play',{'sound_id':'sound:23'},key='excess')
    assert (await client.operate(D,'activity.stop',{},key='stop'))['state']=='completed'
    assert client.session.calls==['stop']

async def test_submission_returns_durable_id_before_long_protocol_finishes():
    import json
    storage=Storage();client=make(storage);await client.async_initialize();client.session.connected=True
    recipe={'version':1,'name':'Long','frames':[{'atMs':0,'controls':[1]*8,'transitionMs':65535}]}
    await client.save_preferences(D,0,{'device.light-recipe.v1':json.dumps(recipe)})
    finished=asyncio.Event();started=asyncio.Event()
    async def execute(plan):
        assert plan.duration_ms==65535
        started.set();await finished.wait()
        return {'state':'completed','confirmation':'ack'}
    client.session.execute_prepared=execute
    accepted=await asyncio.wait_for(client.submit(D,'protocol.run',{'protocol_id':'protocol-device-lights'},key='long'),0.5)
    assert accepted['state']=='accepted'
    assert accepted['operation_id'] in storage.data['operations']
    await started.wait()
    assert (await client.operation(accepted['operation_id']))['state']=='running'
    finished.set()
    await asyncio.gather(*client._background)
    assert (await client.operation(accepted['operation_id']))['state']=='completed'

async def test_duplicate_waits_for_original_durable_admission():
    gate=asyncio.Event();entered=asyncio.Event()
    class PausedStorage(Storage):
        async def async_save(self,value):
            entered.set();await gate.wait();await super().async_save(value)
    storage=PausedStorage();client=make(storage);await client.async_initialize()
    first=asyncio.create_task(client.submit(D,'sound.play',{'sound_id':'sound:23'},key='same'))
    await entered.wait()
    retry=asyncio.create_task(client.submit(D,'sound.play',{'sound_id':'sound:23'},key='same'))
    for _ in range(5):await asyncio.sleep(0)
    assert not retry.done()
    gate.set()
    original,repeated=await asyncio.gather(first,retry)
    assert original['operation_id']==repeated['operation_id']
    assert original['operation_id'] in storage.data['operations']

async def test_revoked_action_is_interrupted_without_inventing_a_safety_fault():
    from custom_components.mech.bluetooth_protocol import CommandCancelled
    client=make();await client.async_initialize();client.session.connected=True
    async def revoked(plan):raise CommandCancelled('STOP')
    client.session.execute_prepared=revoked
    result=await client.operate(D,'sound.play',{'sound_id':'sound:23'})
    assert result['state']=='interrupted'
    assert (await client.snapshot(D))['control']=='ready'

async def test_empty_explicit_key_and_nonobject_policy_are_not_defaulted():
    client=make();await client.async_initialize()
    with pytest.raises(APIError):await client.operate(D,'sound.play',{'sound_id':'sound:23'},key='')
    with pytest.raises(APIError):await client.operate(D,'sound.play',{'sound_id':'sound:23'},policy=[])
    assert client.session.calls==[]

async def test_transient_dome_frames_do_not_persist_or_enqueue():
    client = make()
    client.session.connected = True
    await client.light_frame(D, [255, 128, 0, 0, 128, 255])
    assert client.session.calls == [{'resolved_settings': {'front_dome_red': 255, 'front_dome_green': 128, 'front_dome_blue': 0, 'rear_dome_red': 0, 'rear_dome_green': 128, 'rear_dome_blue': 255}}]
    assert client._data['operations'] == {} and client._store.data is None
    await client._ordinary_lock.acquire()
    try:
        with pytest.raises(APIError, match='busy'):
            await client.light_frame(D, [0] * 6)
    finally:
        client._ordinary_lock.release()
    client._data['fault'] = 'STOP failed'
    with pytest.raises(APIError, match='failed'):
        await client.light_frame(D, [0] * 6)
    assert len(client.session.calls) == 1

@pytest.mark.parametrize('rgb', [[0]*5, [0]*7, [True]*6, [-1]*6, [256]*6, [0.5]*6])
async def test_transient_frames_validate_exact_rgb_bytes(rgb):
    client = make()
    client.session.connected = True
    with pytest.raises((APIError, ValueError)):
        await client.light_frame(D, rgb)
    assert not client.session.calls
