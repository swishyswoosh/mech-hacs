"""Authenticated HA adapter for the shared controller; no HTTP token bridge."""
import asyncio
from copy import deepcopy
from datetime import timedelta
from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
import time
from uuid import uuid4

import voluptuous as vol
from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.helpers.event import async_track_time_interval

from .api import APIError
from .bluetooth_catalog import DATA
from .bluetooth_client import PreferenceConflict
from .const import DOMAIN

PANEL_DATA = "mech_panel"
LEASE_SECONDS = 3.5


@dataclass
class _LeaseIntent:
    waiters: int = 0
    light_token: str | None = None
    light_generation: object = None


class PanelService:
    def __init__(self, hass, *, clock=time.monotonic):
        self.hass, self.clock = hass, clock
        self.leases = {}
        self._lease_intents = {}
        self._unloading_entries = set()
        self.stopping = {}
        self.failed = set()
        self._connections = {}
        self._epoch = 0
        self._telemetry_leases = set()

    def entries(self):
        return [c for c in self.hass.data.get(DOMAIN, {}).values()
                if c.entry.data.get("transport") == "bluetooth"]

    def coordinator(self, droid):
        found = [c for c in self.entries() if droid in c.entry.data["droid_ids"]]
        if len(found) != 1:
            raise ValueError("Choose one configured Home Assistant Bluetooth droid")
        if found[0].entry.entry_id in self._unloading_entries:
            raise ValueError("Droid integration is unloading")
        found[0].assert_identity()
        return found[0]

    async def snapshot(self, droid):
        client = self.coordinator(droid).client
        value = await client.snapshot(droid)
        session = deepcopy(DATA["session_defaults"])
        connected = value.get("connection") == "connected"
        previous = self._connections.get(droid)
        if previous is None or previous[0] is not client or (connected and not previous[1]):
            self._epoch += 1
            epoch = self._epoch
        else:
            epoch = previous[2]
        self._connections[droid] = (client, connected, epoch)
        failed = value.get("control") == "failed" or droid in self.failed and not value.get("stop_failure")
        ready = connected and value.get("power") == "awake" and value.get("control") == "ready"
        state = "failed" if failed else "ready" if ready else "connecting" if connected or value.get("connection") == "connecting" else "disconnected"
        session.update(state=state, detail=value.get("detail") or ("Connected through Home Assistant Bluetooth" if ready else state.capitalize()))
        if value.get("stop_failure"):
            session["stopFailure"] = value["stop_failure"]
        session["connection"].update(state=value.get("connection", "disconnected"), droidName=value["name"], droidId=droid, epoch=epoch)
        session["safety"].update(state="ready-disarmed" if ready and not failed else state, canControl=ready and not failed, motionArmed=False, wheelsValidated=False)
        voltage = value.get("battery_voltage")
        if connected and isinstance(voltage, (int, float)):
            raw = round(voltage * 100)
            session["battery"] = f"Battery voltage response: {raw >> 8:02x} {raw & 255:02x} (cached)"
        for field in ("sensors", "cockpitReadings", "cockpitTelemetryStatus", "cockpitTelemetryBusy"):
            if field in value:
                session[field] = value[field]
        if "sensors" in value:
            session["telemetry"]["sensors"] = deepcopy(value["sensors"])
        native = getattr(client, "session", None)
        motion = getattr(native, "motion", None)
        transition = getattr(motion, "transition_owner", None)
        return {**value, "session": session,
                "motion": {"client_id": transition[1], "transitioning": True} if isinstance(transition, tuple) else {"transitioning": False},
                "capabilities": {
            "motion": hasattr(native, "motion"), "driveStopUnconfirmed": value.get("drive_stop_unconfirmed", False), "telemetry": hasattr(native, "telemetry"),
            "lightFrames": hasattr(client, "light_frame")}}

    async def stop(self, droid):
        previous = self.stopping.get(droid)
        if previous is not None:
            if not previous.done():
                return await asyncio.shield(previous)
            self.stopping.pop(droid, None)

        client = self.coordinator(droid).client

        async def perform():
            try:
                state = await client.snapshot(droid)
                # Opening an idle panel never acquires a device session. There
                # is nothing to stop before Connect or after confirmed sleep.
                # Actual transport loss/failure is reported as failed and must
                # remain blocked; do not erase that uncertainty here.
                if state.get("connection") == "disconnected" and state.get("stop_required") is False and state.get("control") != "failed" and droid not in self.failed:
                    return {"state": "completed", "confirmation": "none", "reason": "No active Bluetooth session"}
                result = await client.operate(droid, "activity.stop", {})
                if result.get("state") not in {"completed", "dispatched"}:
                    raise ValueError(result.get("reason") or "STOP failed; Bluetooth retained and controls remain blocked")
                self.failed.discard(droid)
                return result
            except Exception:
                if (await client.snapshot(droid)).get("control") == "failed":
                    self.failed.add(droid)
                else:
                    self.failed.discard(droid)
                raise

        task = self.hass.async_create_task(perform())
        self.stopping[droid] = task
        def finished(completed):
            if self.stopping.get(droid) is completed:
                self.stopping.pop(droid, None)
            if not completed.cancelled():
                completed.exception()  # Retrieve failure even after a WS caller disappears.
        task.add_done_callback(finished)
        return await asyncio.shield(task)

    async def async_expire(self, _now=None):
        now = self.clock()
        expired_leases = [key for key, deadline in tuple(self.leases.items()) if deadline <= now]
        expired = {key[1] for key in expired_leases}
        for key in expired_leases:
            self._revoke_lease(key)
        # A vanished controller loses its lease even when another is visible.
        # Concurrent STOPs share a barrier; failures stay latched in cached state.
        await asyncio.gather(*(self.stop(droid) for droid in expired), return_exceptions=True)

    async def unload_entry(self, entry):
        self._unloading_entries.add(entry.entry_id)
        droids = set(entry.data["droid_ids"])
        for droid in droids:
            self._connections.pop(droid, None)
        for key in set(self.leases) | set(self._lease_intents):
            if key[1] in droids:
                self._revoke_lease(key)
        await asyncio.gather(*(asyncio.shield(task) for droid, task in tuple(self.stopping.items()) if droid in droids), return_exceptions=True)

    def finish_unload_entry(self, entry):
        self._unloading_entries.discard(entry.entry_id)

    def _revoke_lease(self, lease):
        self.leases.pop(lease, None)
        self._lease_intents.pop(lease, None)
        self._telemetry_leases.discard(lease)
        self._update_telemetry(lease[1])

    def _update_telemetry(self, droid):
        try:
            native = getattr(self.coordinator(droid).client, "session", None)
        except ValueError:
            return
        if native is not None and hasattr(native, "telemetry"):
            native.telemetry.set_demand(any(key[1] == droid and self.leases.get(key, 0) > self.clock() for key in self._telemetry_leases))

    async def _heartbeat(self, lease, coordinator):
        droid = lease[1]
        deadline = self.leases.get(lease)
        expired = deadline is not None and deadline <= self.clock()
        if expired:
            self._revoke_lease(lease)
        if lease not in self._lease_intents and len(self._lease_intents) >= 1000:
            raise ValueError("Controller lease limit reached")
        intent = self._lease_intents.setdefault(lease, _LeaseIntent())
        intent.waiters += 1
        try:
            if expired:
                await self.stop(droid)
            if droid in self.stopping:
                await asyncio.shield(self.stopping[droid])
            if self._lease_intents.get(lease) is not intent:
                raise ValueError("Controller lease was revoked; send a fresh visible heartbeat")
            state = await coordinator.client.snapshot(droid)
            # Visibility does not authorize motion. Keep the lease available for
            # an explicit Connect recovery; command routes enforce readiness.
            # Release, expiry and unload also fence requests awaiting the snapshot.
            if self._lease_intents.get(lease) is not intent:
                raise ValueError("Controller lease was revoked; send a fresh visible heartbeat")
            if len(self.leases) >= 1000 and lease not in self.leases:
                raise ValueError("Controller lease limit reached")
            self.leases[lease] = self.clock() + LEASE_SECONDS
            return {"lease_ms": 3500, "motion": False}
        finally:
            intent.waiters -= 1
            if not intent.waiters and lease not in self.leases and self._lease_intents.get(lease) is intent:
                self._lease_intents.pop(lease, None)

    async def _motion_request(self, user, droid, operation, body, client):
        if not isinstance(body, dict):
            raise ValueError("Invalid motion request")
        allowed = {"open": {"client_id"}, "challenge": {"client_id", "lease_id"},
                   "release": {"client_id", "lease_id"},
                   "command": {"client_id", "lease_id", "token", "action", "parameters"}}
        if operation not in allowed or set(body) != allowed[operation]:
            raise ValueError("Invalid motion request fields")
        client_id = body.get("client_id")
        if not isinstance(client_id, str) or not 1 <= len(client_id) <= 128:
            raise ValueError("Invalid controller client")
        lease = (user, droid, client_id)
        native = getattr(client, "session", None)
        if native is None or not hasattr(native, "motion"):
            raise ValueError("Motion transport is unavailable")
        owner = (user, client_id)
        if operation == "release":
            return await native.motion.release(owner, body["lease_id"])
        intent = self._lease_intents.get(lease)
        if self.leases.get(lease, 0) <= self.clock() or droid in self.stopping or droid in self.failed:
            raise ValueError("Visible controller lease required after successful STOP")
        state = await client.snapshot(droid)
        if state.get("control") != "ready":
            raise ValueError("Droid controls are not ready")
        if self._lease_intents.get(lease) is not intent or self.leases.get(lease, 0) <= self.clock():
            raise ValueError("Controller lease was revoked")
        if operation == "open":
            opened = await native.motion.open(owner)
            if self._lease_intents.get(lease) is not intent or self.leases.get(lease, 0) <= self.clock():
                await native.motion.release(owner, opened["lease_id"])
                raise ValueError("Controller lease was revoked while preparing motion")
            return opened
        if operation == "challenge":
            return native.motion.challenge(owner, body["lease_id"])
        return await native.motion.command(owner, body["lease_id"], body["token"], body["action"], body["parameters"])

    async def request(self, user, method, path, body, key):
        if not isinstance(path, str) or not re.fullmatch(r"[A-Za-z0-9_:/.-]{1,300}", path) or ".." in path or path.startswith("/"):
            raise ValueError("Invalid controller path")
        if method == "GET" and path == "session":
            return {"authenticated": True, "csrf_token": "", "principal": user}
        if method == "GET" and path == "droids":
            return {"items": [await self.snapshot(droid) for c in self.entries() for droid in c.entry.data["droid_ids"]]}
        if path in {"ui/heartbeat", "ui/release"} and method == "POST":
            if not isinstance(body, dict) or set(body) - {"client_id", "droid_id", "visible", "telemetry"}:
                raise ValueError("Invalid lease request")
            droid, client_id = body.get("droid_id"), body.get("client_id")
            if not isinstance(client_id, str) or not 1 <= len(client_id) <= 128:
                raise ValueError("Invalid controller client")
            coordinator = self.coordinator(droid)
            lease = (user, droid, client_id)
            if path == "ui/release" or body.get("visible") is False:
                self._revoke_lease(lease)
                result = await self.stop(droid)
                return {"released": True, "stop": result}
            if body.get("visible") is not True:
                raise ValueError("Visible controller required")
            result = await self._heartbeat(lease, coordinator)
            if body.get("telemetry") is True:
                self._telemetry_leases.add(lease)
            else:
                self._telemetry_leases.discard(lease)
            self._update_telemetry(droid)
            return result
        match = re.fullmatch(r"droids/([A-Za-z0-9_-]+)(?:/(.*))?", path)
        if match:
            droid, suffix = match.group(1), match.group(2) or ""
            client = self.coordinator(droid).client
            if method == "GET":
                if not suffix:
                    return await self.snapshot(droid)
                if suffix == "preferences":
                    return await client.preferences(droid)
                if suffix.startswith("catalogs/"):
                    result = await client.catalog(droid, suffix[9:])
                    if suffix == "catalogs/animations" and hasattr(getattr(client, "session", None), "motion"):
                        for item in result["items"]:
                            item.update(available=True)
                            item.pop("reason", None)
                    return result
            if suffix in {"lights/open", "lights/frame"} and method == "POST":
                expected = {"client_id"} if suffix == "lights/open" else {"client_id", "rgb", "token"}
                if not isinstance(body, dict) or set(body) != expected:
                    raise ValueError("Invalid light frame fields")
                client_id = body["client_id"]
                if not isinstance(client_id, str) or not 1 <= len(client_id) <= 128:
                    raise ValueError("Invalid controller client")
                lease = (user, droid, client_id)
                if self.leases.get(lease, 0) <= self.clock() or droid in self.stopping or droid in self.failed:
                    raise ValueError("Visible controller lease required after successful STOP")
                intent = self._lease_intents.get(lease)
                if intent is None:
                    raise ValueError("Visible controller lease required")
                generation = (client, client.light_frame_generation)
                if suffix == "lights/open":
                    intent.light_token = uuid4().hex
                    intent.light_generation = generation
                    return {"token": intent.light_token}
                if not intent.light_token or body["token"] != intent.light_token or intent.light_generation != generation:
                    raise ValueError("Light animation was revoked; start a new animation explicitly")
                # No asynchronous admission gap between lease validation and
                # the client's native STOP-generation fence.
                return await client.light_frame(droid, body["rgb"])
            if suffix.startswith("motion/") and method == "POST":
                return await self._motion_request(user, droid, suffix[7:], body, client)
            if suffix == "preferences" and method == "PUT":
                if not isinstance(body, dict) or set(body) != {"revision", "values"}:
                    raise ValueError("Invalid shared preferences")
                return await client.save_preferences(droid, body["revision"], body["values"])
            if suffix == "operations" and method == "POST":
                if not isinstance(body, dict) or set(body) - {"action", "parameters", "policy", "client_id"}:
                    raise ValueError("Invalid operation")
                action = body.get("action")
                if action not in {"connection.connect", "connection.disconnect", "activity.stop", "sound.play", "lights.apply", "protocol.run"}:
                    raise ValueError("Unsupported controller action")
                if action not in {"activity.stop", "connection.disconnect"}:
                    lease = (user, droid, body.get("client_id"))
                    if self.leases.get(lease, 0) <= self.clock() or droid in self.stopping or (droid in self.failed and action != "connection.connect"):
                        raise ValueError("Visible controller lease required after successful STOP")
                if not isinstance(key, str) or not 1 <= len(key) <= 128:
                    raise ValueError("Operation idempotency key required")
                scoped_key = hashlib.sha256(f"{user}:{key}".encode()).hexdigest()
                submit = getattr(client, "submit", client.operate)
                result = await submit(droid, action, body.get("parameters", {}), body.get("policy"), scoped_key)
                if action in {"activity.stop", "connection.connect", "connection.disconnect"} and result.get("state") in {"completed", "dispatched"} and (await client.snapshot(droid)).get("control") != "failed":
                    self.failed.discard(droid)
                return result
        match = re.fullmatch(r"operations/([A-Za-z0-9_-]+)", path)
        if method == "GET" and match:
            for coordinator in self.entries():
                try:
                    result = await coordinator.client.operation(match.group(1))
                    droid = result.get("droid_id")
                    if result.get("action") in {"activity.stop", "connection.connect", "connection.disconnect"} and result.get("state") == "completed" and (await coordinator.client.snapshot(droid)).get("control") != "failed":
                        self.failed.discard(droid)
                    return result
                except APIError:
                    continue
        raise ValueError("Unsupported controller path or method")


@websocket_api.websocket_command({
    vol.Required("type"): "mech/request", vol.Required("path"): str,
    vol.Optional("method", default="GET"): vol.In(["GET", "POST", "PUT"]),
    vol.Optional("body"): dict, vol.Optional("key"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def websocket_request(hass, connection, msg):
    if not connection.user.is_active:
        connection.send_error(msg["id"], "unauthorized", "Active administrator required")
        return
    try:
        result = await hass.data[PANEL_DATA].request(connection.user.id, msg["method"], msg["path"], msg.get("body"), msg.get("key"))
        response = {"status": 200, "body": result}
    except PreferenceConflict as error:
        response = {"status": 409, "body": {"error": {"message": str(error)}}}
    except (APIError, ValueError, RuntimeError, TimeoutError) as error:
        response = {"status": 400, "body": {"error": {"message": str(error)}}}
    connection.send_result(msg["id"], response)


async def async_setup_panel(hass):
    if PANEL_DATA in hass.data:
        return
    service = PanelService(hass)
    hass.data[PANEL_DATA] = service
    websocket_api.async_register_command(hass, websocket_request)
    cancel = async_track_time_interval(hass, service.async_expire, timedelta(milliseconds=500))
    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, lambda event: cancel())
    root = Path(__file__).parent
    generated = root / "frontend"
    built = await hass.async_add_executor_job((generated / "controller" / "index.html").is_file)
    panel_script = generated / "panel.js" if built else root / "panel.js"
    assets = [panel_script, root / "icons.js", root / "brand/sidebar.svg"]
    if built:
        assets.append(generated / "controller/index.html")
    def fingerprint():
        return hashlib.sha256(b"".join(path.read_bytes() for path in assets)).hexdigest()[:16]
    version = await hass.async_add_executor_job(fingerprint)
    paths = [StaticPathConfig("/mech/panel.js", str(panel_script), False),
             StaticPathConfig("/mech/icons.js", str(root / "icons.js"), False),
             StaticPathConfig("/mech/sidebar.svg", str(root / "brand/sidebar.svg"), False)]
    if built:
        paths.append(StaticPathConfig("/mech/controller", str(generated / "controller"), False))
    await hass.http.async_register_static_paths(paths)
    frontend.add_extra_js_url(hass, f"/mech/icons.js?v={version}")
    await panel_custom.async_register_panel(hass, frontend_url_path="mech", webcomponent_name="mech-controller-panel", sidebar_title="Mech", sidebar_icon="mech:r2d2", module_url=f"/mech/panel.js?v={version}", config={"controller_version": version}, require_admin=True)
