"""Choose a cached HA Bluetooth device without connecting or waking it."""
import re

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.components import bluetooth
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import selector

from .api import MechClient, APIError, AuthenticationError, IncompatibleAPI
from .const import DOMAIN


class MechConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 2

    async def async_step_user(self, user_input=None):
        errors = {}
        if user_input is not None:
            if user_input.get("use_service"):
                return await self.async_step_service()
            address = user_input.get("address", "").strip().upper()
            if not re.fullmatch(r"(?:[0-9A-F]{2}:){5}[0-9A-F]{2}", address):
                errors["address"] = "invalid_address"
            else:
                identity = f"ha-bluetooth:{address}"
                await self.async_set_unique_id(identity)
                self._abort_if_unique_id_configured()
                name = user_input.get("name", "").strip() or "R2-D2"
                return self.async_create_entry(title=name, data={
                    "transport": "bluetooth", "address": address, "name": name,
                    "instance_id": identity, "droid_ids": [f"r2-{address.replace(':', '').lower()}"],
                })
        # Read HA's existing cache only: no scan, connection, or radio request.
        discovered = bluetooth.async_discovered_service_info(self.hass, connectable=True)
        services = {"00010001-574f-4f20-5370-6865726f2121", "00020001-574f-4f20-5370-6865726f2121"}

        def rank(info):
            name = (info.name or "").upper()
            likely = name.startswith(("R2", "D2-")) or bool(services.intersection(uuid.lower() for uuid in info.service_uuids))
            return (not likely, name, info.address)

        options = {}
        for info in sorted(discovered, key=rank):
            address = info.address.upper()
            options.setdefault(address, {"value": address, "label": f"{info.name or 'Bluetooth device'} ({address})"})
        return self.async_show_form(step_id="user", data_schema=vol.Schema({
            vol.Optional("address"): selector.SelectSelector(selector.SelectSelectorConfig(
                options=list(options.values()), custom_value=True, mode=selector.SelectSelectorMode.DROPDOWN)),
            vol.Optional("name", default="R2-D2"): str,
            vol.Optional("use_service", default=False): bool,
        }), errors=errors)

    async def async_step_service(self, user_input=None):
        errors = {}
        if user_input is not None:
            try:
                client = MechClient(async_get_clientsession(self.hass), user_input["url"], user_input["token"])
                identity = await client.validate()
                await self.async_set_unique_id(identity["instance_id"])
                self._abort_if_unique_id_configured()
                self._droids = {item["droid_id"]: item.get("name", item["droid_id"]) for item in await client.droids()}
                if not self._droids:
                    errors["base"] = "no_droids"
                else:
                    self._pending = {"transport": "api", "url": client.url, "token": user_input["token"], "instance_id": identity["instance_id"]}
                    return await self.async_step_droids()
            except AuthenticationError:
                errors["base"] = "invalid_auth"
            except IncompatibleAPI:
                errors["base"] = "incompatible_api"
            except APIError:
                errors["base"] = "cannot_connect"
            except ValueError:
                errors["base"] = "invalid_url"
        return self.async_show_form(step_id="service", data_schema=vol.Schema({
            vol.Required("url"): str,
            vol.Required("token"): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)),
        }), errors=errors)

    async def async_step_droids(self, user_input=None):
        if user_input is not None:
            selected = user_input.get("droid_ids", [])
            if selected and all(item in self._droids for item in selected):
                return self.async_create_entry(title="Mech Droid Controller", data={**self._pending, "droid_ids": selected})
        return self.async_show_form(step_id="droids", data_schema=vol.Schema({
            vol.Required("droid_ids"): selector.SelectSelector(selector.SelectSelectorConfig(
                options=[{"value": key, "label": name} for key, name in self._droids.items()], multiple=True))
        }), errors={"base": "select_droid"} if user_input is not None else {})

    async def async_step_reauth(self, entry_data):
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input=None):
        errors = {}
        if user_input is not None:
            entry = self._get_reauth_entry()
            try:
                client = MechClient(async_get_clientsession(self.hass), entry.data["url"], user_input["token"])
                identity = await client.validate()
                if identity["instance_id"] != entry.data["instance_id"]:
                    return self.async_abort(reason="wrong_service")
                return self.async_update_reload_and_abort(entry, data_updates={"token": user_input["token"]})
            except AuthenticationError:
                errors["base"] = "invalid_auth"
            except APIError:
                errors["base"] = "cannot_connect"
        return self.async_show_form(step_id="reauth_confirm", data_schema=vol.Schema({
            vol.Required("token"): selector.TextSelector(selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD))
        }), errors=errors)
