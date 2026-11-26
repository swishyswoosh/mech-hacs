"""Run HA tests after its required HTTP-client initialization."""
import sys
import homeassistant  # Initializes the runtime's HTTP compatibility aliases.
import pytest

raise SystemExit(pytest.main(["-o", "asyncio_mode=auto", *(sys.argv[1:] or ["-q", "test/hacs/test_api.py"])]))
