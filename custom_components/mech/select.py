"""Catalog-backed choices; selecting an item does not execute it."""
from homeassistant.components.select import SelectEntity
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.restore_state import RestoreEntity
from .const import CATALOGS, eligible_items
from .entity import MechEntity


async def async_setup_entry(hass, entry, async_add_entities):
    async_add_entities(MechSelect(entry.runtime_data, droid, kind)
                       for droid in entry.data["droid_ids"] for kind in CATALOGS)


class MechSelect(MechEntity, SelectEntity, RestoreEntity):
    def __init__(self, coordinator, droid, kind):
        super().__init__(coordinator, droid, kind)
        self.kind = kind
        self._attr_name = CATALOGS[kind]

    async def async_added_to_hass(self):
        await super().async_added_to_hass()
        previous = await self.async_get_last_state()
        if previous:
            item_id = previous.attributes.get("selected_id")
            if item_id in self.choices().values():
                self.coordinator.selected[self.droid_id, self.kind] = item_id

    @property
    def extra_state_attributes(self):
        return {"selected_id": self.coordinator.selected.get((self.droid_id, self.kind))}

    def choices(self):
        items = eligible_items(self.coordinator.catalogs.get(self.droid_id, {}).get(self.kind, {}))
        return {f"{item['name']} ({item['id']})": item['id'] for item in items}

    @property
    def options(self):
        return list(self.choices())

    @property
    def current_option(self):
        selected = self.coordinator.selected.get((self.droid_id, self.kind))
        return next((label for label, key in self.choices().items() if key == selected), None)

    async def async_select_option(self, option):
        choices = self.choices()
        if option not in choices:
            raise HomeAssistantError("This catalog item is no longer available")
        self.coordinator.selected[self.droid_id, self.kind] = choices[option]
        self.async_write_ha_state()
