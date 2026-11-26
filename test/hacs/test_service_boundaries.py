"""HA service boundaries using localhost HTTP and encoded fake GATT only."""
import asyncio
import sys
from pathlib import Path
from types import MappingProxyType, SimpleNamespace

import aiohttp
from aiohttp import web
import pytest
from homeassistant.auth import auth_manager_from_config
from homeassistant.auth.const import GROUP_ID_ADMIN, GROUP_ID_READ_ONLY, GROUP_ID_USER
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import HomeAssistantError, Unauthorized, UnknownUser
from homeassistant.helpers import area_registry, device_registry, entity_registry, floor_registry
from homeassistant.helpers.update_coordinator import UpdateFailed

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT))
from custom_components.mech.api import MechClient, UnavailableError
from custom_components.mech.bluetooth_client import BluetoothClient
from custom_components.mech.bluetooth_protocol import DroidBluetoothSession
from custom_components.mech.button import MechButton
from custom_components.mech.coordinator import MechCoordinator
from custom_components.mech.services import async_setup_services
from test_bluetooth_client import Storage
from test_operation_policies import GatedGatt


class Client:
    def __init__(self):
        self.calls = []
        self.instance = "service"
        self.snapshot_id = "r2"
        self.failure = None

    async def validate(self):
        return {"instance_id": self.instance}

    async def snapshot(self, droid):
        if self.failure == "snapshot":
            raise UnavailableError("Snapshot unavailable")
        return {"droid_id": self.snapshot_id, "name": "R2"}

    async def catalog(self, droid, kind):
        if self.failure == "catalog":
            raise UnavailableError("Catalog unavailable")
        return {"items": [{"id": "item", "name": "Item", "available": True,
                           "effects": ["audio"]}]}

    async def operation(self, operation_id):
        return {"operation_id": operation_id, "droid_id": "r2", "state": "completed"}

    async def operate(self, droid, command, parameters, policy, key):
        self.calls.append(command)
        return {"droid_id": droid, "state": "completed"}


@pytest.fixture
async def boundary(tmp_path):
    hass = HomeAssistant(str(tmp_path))
    device_registry.async_setup(hass)
    for registry in (entity_registry, area_registry, floor_registry):
        registry.async_get(hass)
    hass.auth = await auth_manager_from_config(hass, [], [])
    entry = ConfigEntry(version=2, minor_version=1, source="user", options={},
                        discovery_keys=MappingProxyType({}), subentries_data=None,
                        domain="mech", unique_id="service", title="Mech",
                        data={"transport": "api", "instance_id": "service", "droid_ids": ["r2"]})
    client = Client()
    coordinator = MechCoordinator(hass, entry, client)
    coordinator.async_set_updated_data(await coordinator._async_update_data())
    hass.data["mech"] = {entry.entry_id: coordinator}
    async_setup_services(hass)
    yield hass, coordinator, client
    await coordinator.async_shutdown()
    await hass.async_stop(force=True)


@pytest.mark.parametrize("group", [GROUP_ID_READ_ONLY, GROUP_ID_USER])
@pytest.mark.parametrize("action,extra", [
    ("connect", {}), ("disconnect", {}), ("stop", {}),
    ("play_sound", {"sound_id": "item"}),
    ("apply_lights", {"preset_id": "item"}),
    ("run_protocol", {"protocol_id": "item"}),
])
async def test_non_admin_cannot_dispatch_control(boundary, group, action, extra):
    hass, _, client = boundary
    await hass.auth.async_create_user("Owner", group_ids=[GROUP_ID_ADMIN])
    user = await hass.auth.async_create_user("User", group_ids=[group])
    with pytest.raises(Unauthorized):
        await hass.services.async_call("mech", action, {"droid_id": "r2", **extra},
                                       blocking=True, context=Context(user_id=user.id))
    assert client.calls == []


async def test_unknown_user_cannot_dispatch_control(boundary):
    hass, _, client = boundary
    with pytest.raises(UnknownUser):
        await hass.services.async_call("mech", "disconnect", {"droid_id": "r2"},
                                       blocking=True, context=Context(user_id="deleted"))
    assert client.calls == []


async def test_admin_automation_and_read_only_queries_remain_available(boundary):
    hass, _, client = boundary
    admin = await hass.auth.async_create_user("Owner", group_ids=[GROUP_ID_ADMIN])
    reader = await hass.auth.async_create_user("Reader", group_ids=[GROUP_ID_READ_ONLY])
    for context in (Context(user_id=admin.id), Context()):
        for action in ("connect", "stop", "disconnect"):
            await hass.services.async_call("mech", action, {"droid_id": "r2"},
                                           blocking=True, context=context)
    assert client.calls == ["connection.connect", "activity.stop", "connection.disconnect"] * 2
    for action, extra in (("list_catalog", {"kind": "sounds"}),
                          ("get_operation", {"operation_id": "known"})):
        result = await hass.services.async_call("mech", action, {"droid_id": "r2", **extra},
                                                blocking=True, return_response=True,
                                                context=Context(user_id=reader.id))
        assert result
    assert len(client.calls) == 6


async def test_button_cannot_drop_non_admin_context(boundary):
    hass, coordinator, client = boundary
    await hass.auth.async_create_user("Owner", group_ids=[GROUP_ID_ADMIN])
    reader = await hass.auth.async_create_user("Reader", group_ids=[GROUP_ID_READ_ONLY])
    button = MechButton(coordinator, "r2", "disconnect")
    button.hass = hass
    button.async_set_context(Context(user_id=reader.id))
    with pytest.raises(Unauthorized):
        await button.async_press()
    assert client.calls == []


async def test_snapshot_mismatch_latches_until_complete_refresh(boundary):
    hass, coordinator, client = boundary
    client.snapshot_id = "other-droid"
    with pytest.raises(UpdateFailed, match="identity"):
        await coordinator._async_update_data()
    for failure in (None, "snapshot", "catalog"):
        if failure:
            client.snapshot_id = "r2"
            client.failure = failure
            with pytest.raises(UpdateFailed):
                await coordinator._async_update_data()
        with pytest.raises(HomeAssistantError, match="identity"):
            await hass.services.async_call("mech", "disconnect", {"droid_id": "r2"}, blocking=True)
    assert client.calls == []
    client.failure = None
    await coordinator._async_update_data()
    await hass.services.async_call("mech", "disconnect", {"droid_id": "r2"}, blocking=True)
    assert client.calls == ["connection.disconnect"]


@pytest.mark.parametrize("failure", ["snapshot", "catalog"])
async def test_transient_outage_preserves_connect_and_stop(boundary, failure):
    hass, coordinator, client = boundary
    client.failure = failure
    with pytest.raises(UpdateFailed):
        await coordinator._async_update_data()
    for action in ("connect", "stop"):
        await hass.services.async_call("mech", action, {"droid_id": "r2"}, blocking=True)
    assert client.calls == ["connection.connect", "activity.stop"]


async def test_empty_idempotency_key_cannot_dispatch_legacy_service_operation(boundary, aiohttp_server):
    hass, coordinator, _ = boundary
    dispatched = []

    async def operate(request):
        dispatched.append(request.headers.get("Idempotency-Key"))
        return web.json_response({"operation_id": "remote", "droid_id": "r2", "state": "completed"})

    app = web.Application()
    app.router.add_post("/api/v1/droids/r2/operations", operate)
    server = await aiohttp_server(app)
    async with aiohttp.ClientSession() as session:
        coordinator.client = MechClient(session, str(server.make_url("")), "test-token")
        for _ in range(2):
            with pytest.raises(HomeAssistantError, match="Idempotency key"):
                await hass.services.async_call("mech", "connect", {
                    "droid_id": "r2", "idempotency_key": "",
                }, blocking=True)
        assert dispatched == []
        await hass.services.async_call("mech", "connect", {
            "droid_id": "r2", "idempotency_key": "valid-key",
        }, blocking=True)
        assert dispatched == ["valid-key"]


@pytest.mark.parametrize("failed", [False, True])
async def test_canceled_stop_service_settles_native_operation(boundary, failed):
    hass, coordinator, _ = boundary
    gatt = GatedGatt()
    storage = Storage()

    async def connect(callback):
        gatt.on_disconnect = callback
        return gatt

    def session_factory(address, name, _connect, **kwargs):
        return DroidBluetoothSession(address, name, connect, timeout=0.5, **kwargs)

    entry = SimpleNamespace(entry_id=coordinator.entry.entry_id, data={
        **coordinator.entry.data, "address": "AA:BB:CC:DD:EE:FF",
    })
    client = BluetoothClient(hass, entry, session_factory=session_factory, store=storage)
    await client.async_initialize()
    coordinator.client = client
    try:
        await hass.services.async_call("mech", "connect", {
            "droid_id": "r2", "wait": "terminal",
        }, blocking=True)
        gatt.hold_stop = True
        stopped = asyncio.create_task(hass.services.async_call("mech", "stop", {
            "droid_id": "r2", "idempotency_key": "canceled-stop",
        }, blocking=True))
        await asyncio.wait_for(gatt.stop_waiting.wait(), 1)
        stopped.cancel()
        with pytest.raises(asyncio.CancelledError):
            await stopped
        if failed:
            # A missing held acknowledgment must settle as failed at the same deadline.
            with pytest.raises(TimeoutError):
                await client.session.stop()
        else:
            gatt.release_stop()
            await client.session.stop()
        if client._background:
            await asyncio.gather(*client._background)
        before = list(gatt.commands)
        result = await hass.services.async_call("mech", "stop", {
            "droid_id": "r2", "idempotency_key": "canceled-stop",
        }, blocking=True, return_response=True)
        assert result["state"] == ("failed" if failed else "completed")
        assert gatt.commands == before
        assert gatt.is_connected
        assert storage.data["operations"][result["operation_id"]]["state"] == result["state"]
        queried = await hass.services.async_call("mech", "get_operation", {
            "droid_id": "r2", "operation_id": result["operation_id"],
        }, blocking=True, return_response=True)
        assert queried == result
        restored = BluetoothClient(hass, entry, session_factory=session_factory, store=storage)
        await restored.async_initialize()
        assert await restored.operate("r2", "activity.stop", {}, key="canceled-stop") == result
        assert gatt.commands == before
        if failed:
            assert storage.data["fault"]
            assert (await restored.snapshot("r2"))["control"] == "failed"
    finally:
        gatt.release_stop()
        await client.async_close()
