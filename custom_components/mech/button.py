"""Explicit power, STOP and selected-catalog actions."""
from homeassistant.components.button import ButtonEntity
from .entity import MechEntity

BUTTONS = {"connect": "Connect", "disconnect": "Disconnect", "stop": "Stop", "play_sound": "Play selected sound", "apply_lights": "Apply selected lights", "run_protocol": "Run selected protocol"}


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities(MechButton(entry.runtime_data, droid, action)
                       for droid in entry.data["droid_ids"] for action in BUTTONS)


class MechButton(MechEntity, ButtonEntity):
    def __init__(self, coordinator, droid, action):
        super().__init__(coordinator, droid, action)
        self.action = action
        self._attr_name = BUTTONS[action]

    async def async_press(self):
        await self.hass.services.async_call("mech", self.action, {
            "droid_id": self.droid_id, "config_entry_id": self.coordinator.entry.entry_id,
        }, blocking=True, context=self._context)
