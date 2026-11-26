"""Stable entity/device identity, independent of friendly names and IPs."""
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from .const import DOMAIN


class MechEntity(CoordinatorEntity):
    _attr_has_entity_name = True

    def __init__(self, coordinator, droid_id, key):
        super().__init__(coordinator)
        self.droid_id = droid_id
        identity = f"{coordinator.entry.data['instance_id']}:{droid_id}"
        self._attr_unique_id = f"{identity}:{key}"
        self._attr_device_info = DeviceInfo(identifiers={(DOMAIN, identity)},
            name=coordinator.data[droid_id].get("name", droid_id), manufacturer="Sphero", model="R2-D2")

    @property
    def snapshot(self):
        return self.coordinator.data.get(self.droid_id, {})
