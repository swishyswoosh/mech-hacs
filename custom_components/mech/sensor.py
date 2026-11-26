"""Connection-aware cached state; no raw high-frequency sensor entities."""
from homeassistant.components.sensor import SensorEntity, SensorEntityDescription, SensorDeviceClass
from homeassistant.const import UnitOfElectricPotential
from .entity import MechEntity

DESCRIPTIONS = (
    SensorEntityDescription(key="connection", name="Connection"),
    SensorEntityDescription(key="power", name="Power"),
    SensorEntityDescription(key="control", name="Control"),
    SensorEntityDescription(key="battery_voltage", name="Battery voltage", device_class=SensorDeviceClass.VOLTAGE, native_unit_of_measurement=UnitOfElectricPotential.VOLT),
)


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities(MechSensor(entry.runtime_data, droid, description)
                       for droid in entry.data["droid_ids"] for description in DESCRIPTIONS)


class MechSensor(MechEntity, SensorEntity):
    def __init__(self, coordinator, droid, description):
        super().__init__(coordinator, droid, description.key)
        self.entity_description = description

    @property
    def available(self):
        if self.entity_description.key == "battery_voltage":
            return super().available and self.snapshot.get("connection") == "connected" and self.native_value is not None
        return super().available

    @property
    def native_value(self):
        return self.snapshot.get(self.entity_description.key)
