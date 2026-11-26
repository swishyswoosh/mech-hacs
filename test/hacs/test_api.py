"""Focused API-client tests: no Home Assistant installation or BLE required."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).parents[2]
PATH = (ROOT) / "custom_components/mech/api.py"
spec = importlib.util.spec_from_file_location("mech_api", PATH)
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)

class Response:
    def __init__(self, body, status=200): self.body, self.status = body, status
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def json(self): return self.body

class Session:
    def __init__(self, *responses): self.responses, self.calls = list(responses), []
    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.responses.pop(0)

class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_validate_requires_v1_and_stable_identity(self):
        session = Session(Response({"api_version": "1", "instance_id": "house"}))
        result = await api.MechClient(session, "http://controller:8080/", "secret").validate()
        self.assertEqual(result["instance_id"], "house")
        self.assertEqual(session.calls[0][1], "http://controller:8080/api/v1")
        bad = Session(Response({"api_version": "2", "instance_id": "house"}))
        with self.assertRaises(api.IncompatibleAPI): await api.MechClient(bad, "http://host", "x").validate()

    async def test_operation_preserves_key_and_never_retries(self):
        session = Session(Response({"operation_id": "o", "state": "accepted"}, 202))
        client = api.MechClient(session, "https://host/prefix", "secret")
        await client.operate("r2/one", "sound.play", {"sound_id": "hey"}, {"if_unavailable": "skip"}, "door-event")
        method, url, args = session.calls[0]
        self.assertEqual(method, "POST")
        self.assertTrue(url.endswith("/droids/r2%2Fone/operations"))
        self.assertEqual(args["headers"]["Idempotency-Key"], "door-event")
        self.assertFalse(args["allow_redirects"])
        self.assertEqual(len(session.calls), 1)
        self.assertEqual(args["json"]["policy"]["if_unavailable"], "skip")

    async def test_auth_and_redirect_fail_without_response_body_leak(self):
        for status, error in [(401, api.AuthenticationError), (403, api.AuthenticationError), (302, api.APIError), (500, api.APIError)]:
            session = Session(Response({"error": {"message": "secret"}}, status))
            with self.assertRaises(error) as caught:
                await api.MechClient(session, "http://host", "secret").droids()
            self.assertNotIn("secret", str(caught.exception))
            self.assertEqual(len(session.calls), 1)

    async def test_reads_and_catalogs_never_issue_operations(self):
        session = Session(Response({"items": [{"droid_id": "r2"}]}), Response({"droid_id": "r2"}), Response({"items": []}))
        client = api.MechClient(session, "http://host", "x")
        self.assertEqual((await client.droids())[0]["droid_id"], "r2")
        await client.snapshot("r2"); await client.catalog("r2", "sounds")
        self.assertTrue(all(method == "GET" for method, _, _ in session.calls))
        with self.assertRaises(ValueError): await client.catalog("r2", "../operations")

    def test_url_rejects_credentials_query_and_fragment(self):
        for url in ["file:///tmp/data", "http://user:password@host", "http://host/?token=secret", "http://host/#secret"]:
            with self.assertRaises(ValueError): api.MechClient(Session(), url, "x")
