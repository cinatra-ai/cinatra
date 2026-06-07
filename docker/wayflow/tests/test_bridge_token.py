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
