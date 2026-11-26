"""Poll cached client state, never wake or connect a Bluetooth device."""
from datetime import timedelta
import logging

from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import APIError, AuthenticationError, IncompatibleAPI
from .const import DOMAIN, CATALOGS

LOGGER = logging.getLogger(__name__)


class MechCoordinator(DataUpdateCoordinator[dict]):
    def __init__(self, hass, entry, client):
        super().__init__(hass, LOGGER, config_entry=entry, name=DOMAIN,
                         update_interval=timedelta(seconds=30))
        self.client = client
        self.entry = entry
        self.catalogs: dict = {}
        self.selected: dict = {}
        self.identity_error: str | None = None

    def assert_identity(self):
        if self.identity_error:
            raise IncompatibleAPI(self.identity_error)

    async def _async_update_data(self):
        try:
            identity = await self.client.validate()
            if identity["instance_id"] != self.entry.data["instance_id"]:
                raise IncompatibleAPI("The service identity changed; reconfigure the integration")
            states = {}
            catalogs = {}
            for droid_id in self.entry.data["droid_ids"]:
                states[droid_id] = await self.client.snapshot(droid_id)
                if states[droid_id].get("droid_id") != droid_id:
                    raise IncompatibleAPI("Droid snapshot identity mismatch")
                catalogs[droid_id] = {kind: await self.client.catalog(droid_id, kind) for kind in CATALOGS}
            self.catalogs = catalogs
            # A mismatch stays latched until the entire refresh validates.
            # Transient outages alone leave Connect and priority STOP available.
            self.identity_error = None
            return states
        except IncompatibleAPI as error:
            self.identity_error = str(error)
            raise UpdateFailed(str(error)) from None
        except AuthenticationError as error:
            raise ConfigEntryAuthFailed(str(error)) from None
        except APIError as error:
            raise UpdateFailed(str(error)) from None
