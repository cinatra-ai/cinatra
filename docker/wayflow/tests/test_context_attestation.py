"""#907 — per-node context-callback attestation minting.

The ApiCallStep patch, when CINATRA_CONTEXT_ATTEST_KEY is set, injects an HMAC
attestation over (contextId, nodeId) on /api/context-resolve + /api/context-
finalize calls, where nodeId is the compiled step's OWN id (`self.id`, e.g.
`ctx-<slotId>-resolve_context`). This binds the callback to the actually-
executing composed child so the server can prove WHICH child is calling.

These tests stub `wayflowcore.steps.ApiCallStep` (the real package is not
installed in the unit env), mirroring test_bridge_token.py.
"""

import asyncio
import hashlib
import hmac
import sys
from typing import Any, Dict
from unittest.mock import MagicMock

ATTEST_KEY = "attest-key-under-test"
BRIDGE_TOKEN = "bridge-tok-abc"
CTX_ID = "conv-ctx-id-123"


def _expected_sig(key: str, ctx: str, node_id: str) -> str:
    material = f"v1\n{ctx}\n{node_id}".encode("utf-8")
    return hmac.new(key.encode("utf-8"), material, hashlib.sha256).hexdigest()


def _install(monkeypatch, *, attest_key: str | None, node_id: str | None):
    """Install the patch with a fresh FakeApiCallStep (fresh class ⇒ the
    idempotency sentinel never short-circuits across tests). Returns the class."""

    class FakeApiCallStep:
        async def _execute_request(self, request: Dict[str, Any]) -> str:
            return "ok"

    if node_id is not None:
        FakeApiCallStep.id = node_id  # class attr → available as self.id

    fake_steps = MagicMock()
    fake_steps.ApiCallStep = FakeApiCallStep
    fake_wf = MagicMock()
    fake_wf.steps = fake_steps
    monkeypatch.setitem(sys.modules, "wayflowcore", fake_wf)
    monkeypatch.setitem(sys.modules, "wayflowcore.steps", fake_steps)

    monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", BRIDGE_TOKEN)
    if attest_key is None:
        monkeypatch.delenv("CINATRA_CONTEXT_ATTEST_KEY", raising=False)
    else:
        monkeypatch.setenv("CINATRA_CONTEXT_ATTEST_KEY", attest_key)

    import agent_loader

    agent_loader._patch_api_call_step_bridge_token()
    return FakeApiCallStep, agent_loader


def _drive(loader, FakeApiCallStep, url: str, *, ctx_id: str) -> Dict[str, Any]:
    token = loader._WAYFLOW_CONTEXT_ID.set(ctx_id)
    try:
        instance = FakeApiCallStep()
        request: Dict[str, Any] = {"url": url}
        asyncio.run(instance._execute_request(request))
        return request
    finally:
        loader._WAYFLOW_CONTEXT_ID.reset(token)


def test_attestation_injected_on_resolve(monkeypatch):
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id="ctx-slotA-resolve_context"
    )
    req = _drive(
        loader,
        FakeApiCallStep,
        "http://host.docker.internal:3000/api/context-resolve",
        ctx_id=CTX_ID,
    )
    h = req["headers"]
    assert h["X-Cinatra-Bridge-Token"] == BRIDGE_TOKEN
    assert h["X-Cinatra-A2A-Context-Id"] == CTX_ID
    assert h["X-Cinatra-Context-Node"] == "ctx-slotA-resolve_context"
    assert h["X-Cinatra-Context-Attestation"] == (
        "v1:" + _expected_sig(ATTEST_KEY, CTX_ID, "ctx-slotA-resolve_context")
    )


def test_attestation_injected_on_finalize(monkeypatch):
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id="ctx-slotA-finalize_interactive"
    )
    req = _drive(
        loader,
        FakeApiCallStep,
        "http://host/api/context-finalize",
        ctx_id=CTX_ID,
    )
    assert req["headers"]["X-Cinatra-Context-Attestation"] == (
        "v1:" + _expected_sig(ATTEST_KEY, CTX_ID, "ctx-slotA-finalize_interactive")
    )


def test_no_attestation_on_non_context_url(monkeypatch):
    """A non-context URL (llm-bridge) must NOT carry the attestation headers."""
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id="ctx-slotA-resolve_context"
    )
    req = _drive(
        loader,
        FakeApiCallStep,
        "http://host/api/llm-bridge",
        ctx_id=CTX_ID,
    )
    assert "X-Cinatra-Context-Attestation" not in req["headers"]
    assert "X-Cinatra-Context-Node" not in req["headers"]
    # bridge token + context-id are still injected for llm-bridge
    assert req["headers"]["X-Cinatra-Bridge-Token"] == BRIDGE_TOKEN


def test_no_attestation_when_key_unset(monkeypatch, capsys):
    """Key unset → warn + no attestation header (server fails closed)."""
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=None, node_id="ctx-slotA-resolve_context"
    )
    captured = capsys.readouterr()
    assert "CINATRA_CONTEXT_ATTEST_KEY unset" in captured.out
    req = _drive(
        loader,
        FakeApiCallStep,
        "http://host/api/context-resolve",
        ctx_id=CTX_ID,
    )
    assert "X-Cinatra-Context-Attestation" not in req["headers"]
    # bridge token still injected — the two secrets are independent
    assert req["headers"]["X-Cinatra-Bridge-Token"] == BRIDGE_TOKEN


def test_no_attestation_without_context_id(monkeypatch):
    """No run context-id (dev loopback) → no attestation minted."""
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id="ctx-slotA-resolve_context"
    )
    req = _drive(
        loader,
        FakeApiCallStep,
        "http://host/api/context-resolve",
        ctx_id="",
    )
    assert "X-Cinatra-Context-Attestation" not in req["headers"]


def test_no_attestation_when_node_id_missing(monkeypatch):
    """A step with no id → nothing to attest → no attestation header."""
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id=None
    )
    # ensure no stray class id
    if hasattr(FakeApiCallStep, "id"):
        delattr(FakeApiCallStep, "id")
    req = _drive(
        loader,
        FakeApiCallStep,
        "http://host/api/context-resolve",
        ctx_id=CTX_ID,
    )
    assert "X-Cinatra-Context-Attestation" not in req["headers"]
