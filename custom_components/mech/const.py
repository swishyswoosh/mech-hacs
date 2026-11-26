"""Integration constants shared by setup, entities and actions."""
DOMAIN = "mech"
PLATFORMS = ["sensor", "select", "button"]
CATALOGS = {"sounds": "Sound", "light_presets": "Light preset", "protocols": "Protocol"}


def eligible_items(catalog: dict) -> list[dict]:
    """Fail closed on unknown effects; this release never starts motion."""
    return [item for item in catalog.get("items", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
            and isinstance(item.get("name"), str) and item.get("available") is True
            and isinstance(item.get("effects"), list) and item["effects"]
            and all(effect in {"audio", "lights"} for effect in item["effects"])]
