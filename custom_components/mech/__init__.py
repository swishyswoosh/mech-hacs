"""Home Assistant Bluetooth control with optional legacy API entries."""
import logging

from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import config_validation as cv

from .api import MechClient
from .const import DOMAIN, PLATFORMS
from .coordinator import MechCoordinator
from .services import async_setup_services
from .panel import PANEL_DATA, async_setup_panel

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
LOGGER = logging.getLogger(__name__)


async def async_setup(hass, config):
    hass.data.setdefault(DOMAIN, {})
    async_setup_services(hass)
    await async_setup_panel(hass)
    return True


async def async_setup_entry(hass, entry):
    native = entry.data.get("transport") == "bluetooth"
    if native:
        from .bluetooth_client import BluetoothClient
        client = BluetoothClient(hass, entry)
    else:
        client = MechClient(async_get_clientsession(hass), entry.data["url"], entry.data["token"])
    try:
        if native:
            await client.async_initialize()
        coordinator = MechCoordinator(hass, entry, client)
        await coordinator.async_config_entry_first_refresh()
        entry.runtime_data = coordinator
        hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    except BaseException:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
        if native:
            await client.async_close()
        raise
    return True


async def async_unload_entry(hass, entry):
    if await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        if entry.data.get("transport") == "bluetooth":
            await hass.data[PANEL_DATA].unload_entry(entry)
            try:
                await entry.runtime_data.client.async_close()
            except Exception:
                # Native close releases transport and persists its safety fault
                # before raising. Finish disposal; reload must retain that fault.
                LOGGER.exception("Bluetooth cleanup failed for %s; the safety fault remains latched", entry.entry_id)
        hass.data[DOMAIN].pop(entry.entry_id, None)
        if entry.data.get("transport") == "bluetooth":
            hass.data[PANEL_DATA].finish_unload_entry(entry)
        # Legacy API entries do not own the external service's Bluetooth link.
        return True
    return False


async def async_migrate_entry(hass, entry):
    """Preserve legacy service and entity identities while naming the transport."""
    if entry.version > 2:
        return False
    if entry.version == 1:
        hass.config_entries.async_update_entry(entry, data={**entry.data, "transport": "api"}, version=2)
    return True
