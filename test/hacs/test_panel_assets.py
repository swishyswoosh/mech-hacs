"""Register standalone sidebar assets before opening the controller panel."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from custom_components.mech import panel
from homeassistant.components import frontend


async def test_sidebar_icon_is_available_without_opening_the_panel(monkeypatch):
    paths = AsyncMock()
    register = AsyncMock()
    extra = Mock()
    async def execute(fn):
        return fn()
    hass = SimpleNamespace(data={}, http=SimpleNamespace(async_register_static_paths=paths),
        bus=SimpleNamespace(async_listen_once=Mock()), async_add_executor_job=execute)
    monkeypatch.setattr(panel.websocket_api, 'async_register_command', Mock())
    monkeypatch.setattr(panel, 'async_track_time_interval', Mock())
    monkeypatch.setattr(panel.panel_custom, 'async_register_panel', register)
    monkeypatch.setattr(frontend, 'add_extra_js_url', extra)
    await panel.async_setup_panel(hass)
    registration = register.call_args.kwargs
    assert registration['sidebar_icon'] == 'mech:r2d2'
    assert registration['require_admin'] is True
    assert '?v=' in registration['module_url']
    assert extra.call_count == 1
    assert extra.call_args.args[1].startswith('/mech/icons.js?v=')
    resources = {entry.url_path: Path(entry.path) for entry in paths.call_args.args[0]}
    assert resources['/mech/icons.js'].is_file()
    assert resources['/mech/sidebar.svg'].is_file()
    assert resources['/mech/panel.js'].is_file()
    await panel.async_setup_panel(hass)
    assert extra.call_count == 1
