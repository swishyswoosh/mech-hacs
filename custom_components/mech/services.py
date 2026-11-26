"""Semantic HA actions; the service remains the sole droid session owner."""
import asyncio
import time
import voluptuous as vol
from homeassistant.core import SupportsResponse, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.service import async_register_admin_service

from .api import APIError
from .const import DOMAIN, CATALOGS, eligible_items

COMMANDS = {"connect": "connection.connect", "disconnect": "connection.disconnect", "stop": "activity.stop",
            "play_sound": "sound.play", "apply_lights": "lights.apply", "run_protocol": "protocol.run"}
ITEMS = {"play_sound": ("sounds", "sound_id"), "apply_lights": ("light_presets", "preset_id"), "run_protocol": ("protocols", "protocol_id")}
BASE = {vol.Required("droid_id"): cv.string, vol.Optional("config_entry_id"): cv.string}
POLICY = {vol.Optional("if_unavailable", default="skip"): vol.In(["skip", "error", "connect"]),
          vol.Optional("if_busy", default="skip"): vol.In(["skip", "error", "replace"]),
          vol.Optional("expires_in_ms", default=5000): vol.All(vol.Coerce(int), vol.Range(min=100, max=30000)),
          vol.Optional("cooldown_key"): cv.string,
          vol.Optional("cooldown_ms", default=0): vol.All(vol.Coerce(int), vol.Range(min=0, max=3600000))}


def find_coordinator(hass, data):
    candidates = [c for entry_id, c in hass.data.get(DOMAIN, {}).items()
                  if data["droid_id"] in c.entry.data["droid_ids"]
                  and ("config_entry_id" not in data or entry_id == data["config_entry_id"])]
    if len(candidates) != 1:
        raise HomeAssistantError("Choose one configured service and droid; use config_entry_id if the ID is ambiguous")
    return candidates[0]


@callback
def async_setup_services(hass):
    if hass.services.has_service(DOMAIN, "play_sound"):
        return

    async def handle(call):
        data = call.data
        coordinator = find_coordinator(hass, data)
        client, droid = coordinator.client, data["droid_id"]
        try:
            coordinator.assert_identity()
            if call.service == "list_catalog":
                return await client.catalog(droid, data["kind"])
            if call.service == "get_operation":
                result = await client.operation(data["operation_id"])
                if result.get("droid_id") != droid:
                    raise HomeAssistantError("Operation does not belong to the selected droid")
                return result
            parameters, policy = {}, {}
            if call.service in ITEMS:
                kind, field = ITEMS[call.service]
                item_id = data.get(field) or coordinator.selected.get((droid, kind))
                # Refresh from cached service catalogs to catch deletion/effect changes.
                catalog = await client.catalog(droid, kind)
                if not item_id or not any(item["id"] == item_id for item in eligible_items(catalog)):
                    raise HomeAssistantError("Choose an available non-motion catalog item")
                parameters[field] = item_id
                policy = {key.schema: data[key.schema] for key in POLICY if key.schema in data}
                if policy.get("cooldown_ms") and not policy.get("cooldown_key"):
                    raise HomeAssistantError("A cooldown key is required when cooldown is enabled")
            coordinator.assert_identity()
            submit = getattr(client, "submit", client.operate)
            result = await submit(droid, COMMANDS[call.service], parameters, policy, data.get("idempotency_key"))
            if data.get("wait") == "terminal" and result.get("operation_id"):
                deadline = time.monotonic() + data["timeout_ms"] / 1000
                while result.get("state") in {"accepted", "running", "acknowledged"}:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    try:
                        async with asyncio.timeout(remaining):
                            await asyncio.sleep(min(0.5, remaining))
                            result = await client.operation(result["operation_id"])
                    except TimeoutError:
                        break
            return result
        except (APIError, ValueError) as error:
            raise HomeAssistantError(str(error)) from None

    for name in COMMANDS:
        schema = {**BASE, vol.Optional("idempotency_key"): cv.string,
                  vol.Optional("wait", default="accepted"): vol.In(["accepted", "terminal"]),
                  vol.Optional("timeout_ms", default=10000): vol.All(vol.Coerce(int), vol.Range(min=1, max=30000))}
        if name in ITEMS:
            schema.update(POLICY)
            schema[vol.Optional(ITEMS[name][1])] = cv.string
        # Match the admin-only panel while preserving contextless automations.
        async_register_admin_service(hass, DOMAIN, name, handle, schema=vol.Schema(schema), supports_response=SupportsResponse.OPTIONAL)
    for name, field, validator in [("list_catalog", "kind", vol.In(list(CATALOGS))), ("get_operation", "operation_id", cv.string)]:
        hass.services.async_register(DOMAIN, name, handle, schema=vol.Schema({**BASE, vol.Required(field): validator}), supports_response=SupportsResponse.ONLY)
