"""Authenticated client for the versioned local controller API."""
from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import quote, urlsplit
from uuid import uuid4

import aiohttp


class APIError(Exception):
    """A request failed without implying that repeating an action is safe."""


class AuthenticationError(APIError):
    """Credentials are missing, revoked or insufficient."""


class IncompatibleAPI(APIError):
    """The service does not implement this API contract."""


class UnavailableError(APIError):
    """The service could not be reached."""


def service_url(value: str) -> str:
    """Accept a service root or ingress prefix, never URL credentials."""
    parsed = urlsplit(value.strip())
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment):
        raise ValueError("Use an HTTP(S) service URL without credentials, query or fragment")
    return value.strip().rstrip("/")


class MechClient:
    def __init__(self, session: aiohttp.ClientSession, url: str, token: str):
        self._session = session
        self.url = service_url(url)
        self._token = token

    async def _request(self, method: str, path: str = "", *, body=None, key=None) -> dict[str, Any]:
        headers = {"Authorization": f"Bearer {self._token}"}
        if key is not None:
            if not isinstance(key, str) or not 1 <= len(key) <= 128 or not key.isascii() or not key.isprintable():
                raise ValueError("Idempotency key must contain 1–128 printable ASCII characters")
            headers["Idempotency-Key"] = key
        try:
            async with self._session.request(
                method, f"{self.url}/api/v1{path}", headers=headers,
                json=body, allow_redirects=False, timeout=aiohttp.ClientTimeout(total=10),
            ) as response:
                if response.status in {401, 403}:
                    raise AuthenticationError("Controller authorization failed")
                if not 200 <= response.status < 300:
                    # Do not surface server error text, URLs or credentials in HA logs.
                    raise APIError(f"Controller returned HTTP {response.status}")
                data = await response.json()
                if not isinstance(data, dict):
                    raise IncompatibleAPI("Controller response must be a JSON object")
                return data
        except (aiohttp.ClientError, asyncio.TimeoutError) as error:
            raise UnavailableError("Controller request failed; action outcome may be unknown") from None
        except ValueError:
            raise IncompatibleAPI("Controller returned invalid JSON") from None

    async def validate(self) -> dict[str, Any]:
        data = await self._request("GET")
        if data.get("api_version") != "1" or not isinstance(data.get("instance_id"), str) or not data["instance_id"]:
            raise IncompatibleAPI("A controller implementing API v1 with a stable instance ID is required")
        return data

    async def droids(self) -> list[dict[str, Any]]:
        data = await self._request("GET", "/droids")
        items = data.get("items")
        if not isinstance(items, list) or any(not isinstance(item, dict) or not isinstance(item.get("droid_id"), str) for item in items):
            raise IncompatibleAPI("Controller droid list is invalid")
        return items

    async def snapshot(self, droid_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/droids/{quote(droid_id, safe='')}")

    async def catalog(self, droid_id: str, kind: str) -> dict[str, Any]:
        if kind not in {"sounds", "animations", "light_presets", "protocols", "paths"}:
            raise ValueError("Unknown catalog")
        data = await self._request("GET", f"/droids/{quote(droid_id, safe='')}/catalogs/{kind}")
        if not isinstance(data.get("items"), list):
            raise IncompatibleAPI("Controller catalog is invalid")
        return data

    async def operate(self, droid_id: str, action: str, parameters: dict, policy: dict | None = None, key: str | None = None) -> dict:
        # Exactly one HTTP attempt. Lost responses must not create duplicate effects.
        return await self._request("POST", f"/droids/{quote(droid_id, safe='')}/operations",
                                   body={"action": action, "parameters": parameters, "policy": policy or {}},
                                   key=uuid4().hex if key is None else key)

    async def operation(self, operation_id: str) -> dict:
        return await self._request("GET", f"/operations/{quote(operation_id, safe='')}")
