"""_patch_api_call_step_bridge_token tests.

Verifies bridge-token behavior:
  - Env-unset case: function returns None and prints a one-line warning so
    operators see that the X-Cinatra-Bridge-Token header is NOT being injected.
  - Env-set case: ApiCallStep._execute_request is wrapped so every outbound
    request gets request["headers"]["X-Cinatra-Bridge-Token"] populated, then
    delegates to the original method.
"""

import asyncio
import sys
from typing import Any, Dict
from unittest.mock import MagicMock


def test_bridge_token_no_op_when_env_unset(monkeypatch, capsys):
    """When CINATRA_BRIDGE_TOKEN is unset, the patch is a no-op + one-line warn."""
    # Ensure agent_loader is freshly imported under the unset env so the
    # function reads the current environment, not a cached module state.
    monkeypatch.delenv("CINATRA_BRIDGE_TOKEN", raising=False)

    from agent_loader import _patch_api_call_step_bridge_token

    result = _patch_api_call_step_bridge_token()

    assert result is None
    captured = capsys.readouterr()
    assert "CINATRA_BRIDGE_TOKEN unset" in captured.out


def test_bridge_token_injects_header_when_env_set(monkeypatch):
    """When CINATRA_BRIDGE_TOKEN is set, _execute_request is wrapped to inject
    the X-Cinatra-Bridge-Token header on every request.
    """
    recorded: Dict[str, Any] = {}

    class FakeApiCallStep:
        async def _execute_request(self, request: Dict[str, Any]) -> str:
            recorded["request"] = request
            return "ok"

    # Stub `wayflowcore.steps.ApiCallStep` so the patch can import it without
    # the real wayflowcore package being installed in the test env.
    fake_steps_module = MagicMock()
    fake_steps_module.ApiCallStep = FakeApiCallStep
    fake_wayflowcore = MagicMock()
    fake_wayflowcore.steps = fake_steps_module
    monkeypatch.setitem(sys.modules, "wayflowcore", fake_wayflowcore)
    monkeypatch.setitem(sys.modules, "wayflowcore.steps", fake_steps_module)

    monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", "test-token-abc-123")

    from agent_loader import _patch_api_call_step_bridge_token

    _patch_api_call_step_bridge_token()

    # Drive the patched method directly on the FakeApiCallStep class.
    instance = FakeApiCallStep()
    request: Dict[str, Any] = {}
    result = asyncio.run(instance._execute_request(request))

    assert result == "ok"
    assert request["headers"]["X-Cinatra-Bridge-Token"] == "test-token-abc-123"
    # The original _execute_request was called with the same dict object, so
    # the patch wraps (does not replace) the underlying behaviour.
    assert recorded["request"] is request


# ---------------------------------------------------------------------------
# Actionable capability errors (engineering#417)
#
# A bridge 503 with code=CAPABILITY_UNSATISFIABLE must be turned into a clean
# RuntimeError carrying the actionable `message`, so WayFlow's task-failure
# text (→ run RUN_ERROR) names the connector to install instead of the buried
# raw-JSON default or a generic "WayFlow task failed".
# ---------------------------------------------------------------------------


class _FakeResp:
    """Minimal httpx.Response stand-in: status_code + json()."""

    def __init__(self, status_code: int, body: Any, *, raise_on_json: bool = False):
        self.status_code = status_code
        self._body = body
        self._raise_on_json = raise_on_json

    def json(self) -> Any:
        if self._raise_on_json:
            raise ValueError("not json")
        return self._body


def _install_patch_returning(monkeypatch, resp: Any):
    """Patch ApiCallStep._execute_request so _original returns `resp`.

    Returns the FakeApiCallStep class so the caller can drive the patched
    method. A fresh class per test means the idempotency sentinel never
    short-circuits across tests.
    """

    class FakeApiCallStep:
        async def _execute_request(self, request: Dict[str, Any]) -> Any:
            return resp

    fake_steps_module = MagicMock()
    fake_steps_module.ApiCallStep = FakeApiCallStep
    fake_wayflowcore = MagicMock()
    fake_wayflowcore.steps = fake_steps_module
    monkeypatch.setitem(sys.modules, "wayflowcore", fake_wayflowcore)
    monkeypatch.setitem(sys.modules, "wayflowcore.steps", fake_steps_module)
    monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", "test-token-abc-123")

    from agent_loader import _patch_api_call_step_bridge_token

    _patch_api_call_step_bridge_token()
    return FakeApiCallStep


def test_capability_unsatisfiable_503_raises_actionable_message(monkeypatch):
    """Bridge 503 + CAPABILITY_UNSATISFIABLE → RuntimeError(actionable message)."""
    msg = (
        'This agent requires the "media_input" LLM capability, but no installed '
        "and configured LLM provider supports it. Install and configure an LLM "
        "connector for one of these providers: gemini."
    )
    resp = _FakeResp(
        503,
        {"error": "capability_unsatisfiable", "code": "CAPABILITY_UNSATISFIABLE", "message": msg},
    )
    FakeApiCallStep = _install_patch_returning(monkeypatch, resp)

    instance = FakeApiCallStep()
    request: Dict[str, Any] = {"url": "http://host.docker.internal:3000/api/llm-bridge"}

    import pytest as _pytest

    with _pytest.raises(RuntimeError) as exc:
        asyncio.run(instance._execute_request(request))
    # The clean actionable message is raised verbatim — NOT the buried JSON.
    assert str(exc.value) == msg
    assert "WayFlow task failed" not in str(exc.value)


def test_capability_503_missing_message_uses_default(monkeypatch):
    """503 + code but no `message` → a sensible default actionable error."""
    resp = _FakeResp(
        503, {"code": "CAPABILITY_UNSATISFIABLE", "capability": "media_input"}
    )
    FakeApiCallStep = _install_patch_returning(monkeypatch, resp)

    instance = FakeApiCallStep()
    request: Dict[str, Any] = {"url": "http://x:3000/api/llm-bridge"}

    import pytest as _pytest

    with _pytest.raises(RuntimeError) as exc:
        asyncio.run(instance._execute_request(request))
    assert "Install and configure" in str(exc.value)


def test_non_capability_503_passes_through(monkeypatch):
    """A 503 that is NOT a capability error is returned unchanged (no raise)."""
    resp = _FakeResp(503, {"error": "service_unavailable"})
    FakeApiCallStep = _install_patch_returning(monkeypatch, resp)

    instance = FakeApiCallStep()
    request: Dict[str, Any] = {"url": "http://x:3000/api/llm-bridge"}

    result = asyncio.run(instance._execute_request(request))
    assert result is resp  # falls through; WayFlow applies its own handling


def test_non_bridge_503_passes_through(monkeypatch):
    """A capability-shaped 503 on a NON-bridge URL must NOT be hijacked."""
    resp = _FakeResp(503, {"code": "CAPABILITY_UNSATISFIABLE", "message": "x"})
    FakeApiCallStep = _install_patch_returning(monkeypatch, resp)

    instance = FakeApiCallStep()
    request: Dict[str, Any] = {"url": "http://x:3000/api/some-other-endpoint"}

    result = asyncio.run(instance._execute_request(request))
    assert result is resp


def test_success_response_passes_through(monkeypatch):
    """A non-response return value (e.g. 'ok') and 2xx both pass through."""
    # Non-response sentinel — status_code attr absent → getattr None → no raise.
    FakeApiCallStep = _install_patch_returning(monkeypatch, "ok")
    instance = FakeApiCallStep()
    request: Dict[str, Any] = {"url": "http://x:3000/api/llm-bridge"}
    assert asyncio.run(instance._execute_request(request)) == "ok"

    # 200 OK response on the bridge URL also passes through.
    resp200 = _FakeResp(200, {"ok": True})
    FakeApiCallStep2 = _install_patch_returning(monkeypatch, resp200)
    instance2 = FakeApiCallStep2()
    assert (
        asyncio.run(instance2._execute_request({"url": "http://x:3000/api/llm-bridge"}))
        is resp200
    )


def test_capability_503_unparseable_body_passes_through(monkeypatch):
    """A 503 whose body is not JSON must fall through (no crash, no raise)."""
    resp = _FakeResp(503, None, raise_on_json=True)
    FakeApiCallStep = _install_patch_returning(monkeypatch, resp)

    instance = FakeApiCallStep()
    request: Dict[str, Any] = {"url": "http://x:3000/api/llm-bridge"}

    result = asyncio.run(instance._execute_request(request))
    assert result is resp
