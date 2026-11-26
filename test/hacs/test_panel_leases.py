"""Panel leases retain the ordering of heartbeat, release and expiry intents."""
import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace
import pytest

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT))
from custom_components.mech.panel import PanelService

@pytest.fixture
def state():
    calls = []
    now = [10.0]
    class Client:
        stop_started = None
        finish_stop = None
        snapshot_started = None
        finish_snapshot = None
        async def snapshot(self, droid):
            if self.snapshot_started is not None:
                started, finish = self.snapshot_started, self.finish_snapshot
                self.snapshot_started = None
                started.set()
                await finish.wait()
            return {'droid_id': droid, 'name': 'R2', 'connection': 'connected', 'power': 'awake', 'control': 'ready'}
        async def operate(self, droid, action, parameters, policy=None, key=None):
            calls.append(action)
            if action == 'activity.stop' and self.finish_stop is not None:
                self.stop_started.set()
                await self.finish_stop.wait()
            return {'state': 'completed', 'operation_id': 'op', 'droid_id': droid}
    client = Client()
    entry = SimpleNamespace(entry_id='entry', data={'transport': 'bluetooth', 'droid_ids': ['r2']})
    coordinator = SimpleNamespace(entry=entry, client=client, assert_identity=lambda: None)
    hass = SimpleNamespace(data={'mech': {'entry': coordinator}}, async_create_task=asyncio.create_task)
    service = PanelService(hass, clock=lambda: now[0])
    return service, client, calls, now, entry

BODY = {'client_id': 'tab', 'droid_id': 'r2', 'visible': True}
async def heartbeat(service):
    return await service.request('owner', 'POST', 'ui/heartbeat', BODY, None)

@pytest.mark.parametrize('release_path,visible', [('ui/release', True), ('ui/heartbeat', False)])
async def test_pending_heartbeat_cannot_restore_a_later_released_lease(state, release_path, visible):
    service, client, calls, _, _ = state
    client.stop_started, client.finish_stop = asyncio.Event(), asyncio.Event()
    stop = asyncio.create_task(service.stop('r2'))
    await client.stop_started.wait()
    old = asyncio.create_task(heartbeat(service))
    await asyncio.sleep(0)
    released = asyncio.create_task(service.request('owner', 'POST', release_path, {**BODY, 'visible': visible}, None))
    await asyncio.sleep(0)
    client.finish_stop.set()
    await asyncio.gather(stop, released)
    await asyncio.gather(old, return_exceptions=True)
    assert not service.leases, 'old heartbeat must not restore released visibility'
    with pytest.raises(ValueError, match='lease'):
        await service.request('owner', 'POST', 'droids/r2/operations', {'client_id': 'tab', 'action': 'sound.play', 'parameters': {}}, 'old')
    assert calls == ['activity.stop']
    await heartbeat(service)
    assert (await service.request('owner', 'POST', 'droids/r2/operations', {'client_id': 'tab', 'action': 'sound.play', 'parameters': {}}, 'new'))['state'] == 'completed'

async def test_expiry_fences_a_heartbeat_already_waiting_for_its_snapshot(state):
    service, client, calls, now, _ = state
    await heartbeat(service)
    started, finish = asyncio.Event(), asyncio.Event()
    client.snapshot_started, client.finish_snapshot = started, finish
    old = asyncio.create_task(heartbeat(service))
    await started.wait()
    now[0] = 14.0
    await service.async_expire()
    finish.set()
    await asyncio.gather(old, return_exceptions=True)
    assert not service.leases
    assert calls == ['activity.stop']
    await heartbeat(service)
    assert ('owner', 'r2', 'tab') in service.leases

async def test_entry_unload_fences_pending_heartbeat_without_an_existing_lease(state):
    service, client, _, _, entry = state
    client.stop_started, client.finish_stop = asyncio.Event(), asyncio.Event()
    stop = asyncio.create_task(service.stop('r2'))
    await client.stop_started.wait()
    old = asyncio.create_task(heartbeat(service))
    await asyncio.sleep(0)
    unloading = asyncio.create_task(service.unload_entry(entry))
    await asyncio.sleep(0)
    client.finish_stop.set()
    await asyncio.gather(stop, unloading)
    await asyncio.gather(old, return_exceptions=True)
    assert not service.leases

async def test_canceling_one_heartbeat_waiter_does_not_revoke_another_visible_waiter(state):
    service, client, _, _, _ = state
    client.stop_started, client.finish_stop = asyncio.Event(), asyncio.Event()
    stop = asyncio.create_task(service.stop('r2'))
    await client.stop_started.wait()
    first = asyncio.create_task(heartbeat(service))
    second = asyncio.create_task(heartbeat(service))
    await asyncio.sleep(0)
    first.cancel()
    await asyncio.gather(first, return_exceptions=True)
    client.finish_stop.set()
    await asyncio.gather(stop, second)
    assert ('owner', 'r2', 'tab') in service.leases

async def test_unloading_rejects_new_heartbeats_through_client_disposal(state):
    service, client, _, _, entry = state
    client.stop_started, client.finish_stop = asyncio.Event(), asyncio.Event()
    stop = asyncio.create_task(service.stop('r2'))
    await client.stop_started.wait()
    unloading = asyncio.create_task(service.unload_entry(entry))
    await asyncio.sleep(0)
    with pytest.raises(ValueError, match='unloading'):
        await heartbeat(service)
    client.finish_stop.set()
    await asyncio.gather(stop, unloading)
    with pytest.raises(ValueError, match='unloading'):
        await heartbeat(service)
    assert not service.leases and not service._lease_intents
    service.hass.data['mech'].pop(entry.entry_id)
    service.finish_unload_entry(entry)
    with pytest.raises(ValueError, match='configured'):
        await heartbeat(service)

async def test_expiry_uses_one_time_snapshot_for_revocation_and_stop(state):
    service, _, calls, _, _ = state
    await heartbeat(service)
    ticks = iter([13.49, 13.51, 13.52])
    service.clock = lambda: next(ticks)
    await service.async_expire()
    assert service.leases or calls == ['activity.stop'], 'revocation must never omit STOP at a deadline boundary'

async def test_light_frames_require_visible_lease_and_do_not_use_durable_operations(state):
    service, client, calls, now, _ = state
    async def frame(droid, rgb):
        calls.append(('frame', rgb))
        return {'state': 'dispatched'}
    client.light_frame = frame
    client.light_frame_generation = 1
    body = {'client_id': 'tab', 'token': 'old', 'rgb': [255, 0, 0, 255, 0, 0]}
    async def send():
        return await service.request('owner', 'POST', 'droids/r2/lights/frame', body, None)
    with pytest.raises(ValueError, match='lease'):
        await send()
    await heartbeat(service)
    body['token'] = (await service.request('owner', 'POST', 'droids/r2/lights/open', {'client_id': 'tab'}, None))['token']
    assert (await send())['state'] == 'dispatched'
    service.failed.add('r2')
    with pytest.raises(ValueError):
        await send()
    service.failed.clear()
    now[0] = 14
    with pytest.raises(ValueError):
        await send()
    assert calls == [('frame', body['rgb'])]


async def test_delayed_frame_cannot_cross_release_refocus_or_connection_generation(state):
    service, client, calls, now, _ = state
    async def frame(droid, rgb):
        calls.append('frame')
        return {'state': 'dispatched'}
    client.light_frame = frame
    client.light_frame_generation = 1
    await heartbeat(service)
    opened = await service.request('owner','POST','droids/r2/lights/open',{'client_id':'tab'},None)
    body = {'client_id':'tab','token':opened['token'],'rgb':[255,0,0]*2}
    await service.request('owner','POST','ui/release',BODY,None)
    await heartbeat(service)
    with pytest.raises(ValueError, match='revoked'):
        await service.request('owner','POST','droids/r2/lights/frame',body,None)
    opened = await service.request('owner','POST','droids/r2/lights/open',{'client_id':'tab'},None)
    body['token'] = opened['token']
    client.light_frame_generation = 2
    with pytest.raises(ValueError, match='revoked'):
        await service.request('owner','POST','droids/r2/lights/frame',body,None)
    assert calls == ['activity.stop']
