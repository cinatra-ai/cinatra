"""#907/#1192 — per-node context-callback attestation minting.

The ApiCallStep patch, when CINATRA_CONTEXT_ATTEST_KEY is set, injects an HMAC
attestation over (contextId, nodeId, expiry) on /api/context-resolve + /api/
context-finalize calls, where nodeId is the compiled step's OWN id (`self.id`,
e.g. `ctx-<slotId>-resolve_context`). This binds the callback to the actually-
executing composed child so the server can prove WHICH child is calling.

#1192 Stage-0 hardening covered here:
  - HOST-ANCHOR: the bridge token, context id, and attestation are injected ONLY
    when the ApiNode call targets the configured CINATRA_BASE_URL host:port. A
    call to any OTHER host — even one whose PATH contains a context substring —
    receives NOTHING (internal callback headers stay on the configured base URL).
  - REPLAY WINDOW: the attestation is now v2 — the material carries a short-lived
    expiry (`v2\\n<ctx>\\n<node>\\n<expiryEpoch>`; header `v2:<expiryEpoch>:<hex>`)
    so a captured (node, attestation) pair is bounded to a short lifetime.

These tests stub `wayflowcore.steps.ApiCallStep` (the real package is not
installed in the unit env), mirroring test_bridge_token.py.
"""

import asyncio
import hashlib
import hmac
import sys
import time
from typing import Any, Dict, Optional, Tuple
from unittest.mock import MagicMock

ATTEST_KEY = "attest-key-under-test"
BRIDGE_TOKEN = "bridge-tok-abc"
CTX_ID = "conv-ctx-id-123"

# The default CINATRA_BASE_URL the loader host-anchors to when the env var is
# unset (matches _substitute_placeholders / _patch_a2a_agent_bridge_token).
INTERNAL_HOST = "http://host.docker.internal:3000"


def _v2_material(ctx: str, node_id: str, expiry: int) -> bytes:
    return f"v2\n{ctx}\n{node_id}\n{expiry}".encode("utf-8")


def _expected_v2_sig(key: str, ctx: str, node_id: str, expiry: int) -> str:
    return hmac.new(key.encode("utf-8"), _v2_material(ctx, node_id, expiry), hashlib.sha256).hexdigest()


def _parse_v2_header(value: str) -> Tuple[int, str]:
    """Split a `v2:<expiryEpoch>:<hex>` header into (expiry, sig)."""
    version, expiry_str, sig = value.split(":", 2)
    assert version == "v2", f"expected a v2 header, got {value!r}"
    return int(expiry_str), sig


def _install(
    monkeypatch,
    *,
    attest_key: Optional[str],
    node_id: Optional[str],
    base_url: Optional[str] = None,
):
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
    if base_url is None:
        monkeypatch.delenv("CINATRA_BASE_URL", raising=False)
    else:
        monkeypatch.setenv("CINATRA_BASE_URL", base_url)
    if attest_key is None:
        monkeypatch.delenv("CINATRA_CONTEXT_ATTEST_KEY", raising=False)
    else:
        monkeypatch.setenv("CINATRA_CONTEXT_ATTEST_KEY", attest_key)

    import agent_loader

    # The patch reads CINATRA_BASE_URL / tokens at patch time — call AFTER env is set.
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


# ---------------------------------------------------------------------------
# Positive: injection on the internal (CINATRA_BASE_URL) host, v2 attestation.
# ---------------------------------------------------------------------------


def test_attestation_injected_on_resolve(monkeypatch):
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id="ctx-slotA-resolve_context"
    )
    before = int(time.time())
    req = _drive(
        loader,
        FakeApiCallStep,
        f"{INTERNAL_HOST}/api/context-resolve",
        ctx_id=CTX_ID,
    )
    after = int(time.time())
    h = req["headers"]
    assert h["X-Cinatra-Bridge-Token"] == BRIDGE_TOKEN
    assert h["X-Cinatra-A2A-Context-Id"] == CTX_ID
    assert h["X-Cinatra-Context-Node"] == "ctx-slotA-resolve_context"
    expiry, sig = _parse_v2_header(h["X-Cinatra-Context-Attestation"])
    # Expiry ≈ now + TTL, and the signature recomputes over the emitted expiry.
    assert before + loader._CONTEXT_ATTESTATION_TTL_SECONDS <= expiry <= after + loader._CONTEXT_ATTESTATION_TTL_SECONDS
    assert sig == _expected_v2_sig(ATTEST_KEY, CTX_ID, "ctx-slotA-resolve_context", expiry)


def test_attestation_injected_on_finalize(monkeypatch):
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id="ctx-slotA-finalize_interactive"
    )
    req = _drive(
        loader,
        FakeApiCallStep,
        f"{INTERNAL_HOST}/api/context-finalize",
        ctx_id=CTX_ID,
    )
    expiry, sig = _parse_v2_header(req["headers"]["X-Cinatra-Context-Attestation"])
    assert sig == _expected_v2_sig(ATTEST_KEY, CTX_ID, "ctx-slotA-finalize_interactive", expiry)


# ---------------------------------------------------------------------------
# HOST-ANCHOR acceptance: a callback to a non-configured host whose PATH contains
# a context substring receives NOTHING (no bridge token, no context id, no
# attestation). Same for a same-host wrong-port and same-host default-port call.
# ---------------------------------------------------------------------------


def test_no_injection_on_attacker_host(monkeypatch):
    """A callback to an attacker host with a context-substring PATH gets nothing."""
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id="ctx-slotA-resolve_context"
    )
    req = _drive(
        loader,
        FakeApiCallStep,
        "http://evil.example.com/api/context-resolve",
        ctx_id=CTX_ID,
    )
    h = req.get("headers", {})
    assert "X-Cinatra-Bridge-Token" not in h
    assert "X-Cinatra-A2A-Context-Id" not in h
    assert "X-Cinatra-Context-Node" not in h
    assert "X-Cinatra-Context-Attestation" not in h


def test_no_injection_on_same_host_wrong_port(monkeypatch):
    """Same host, DIFFERENT port ⇒ a different service ⇒ no secret injected."""
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id="ctx-slotA-resolve_context"
    )
    req = _drive(
        loader,
        FakeApiCallStep,
        "http://host.docker.internal:8080/api/context-resolve",
        ctx_id=CTX_ID,
    )
    h = req.get("headers", {})
    assert "X-Cinatra-Bridge-Token" not in h
    assert "X-Cinatra-Context-Attestation" not in h


def test_no_injection_on_same_host_default_port(monkeypatch):
    """Same host, no explicit port (→ :80) must NOT match a :3000 base URL."""
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id="ctx-slotA-resolve_context"
    )
    req = _drive(
        loader,
        FakeApiCallStep,
        "http://host.docker.internal/api/context-resolve",
        ctx_id=CTX_ID,
    )
    h = req.get("headers", {})
    assert "X-Cinatra-Bridge-Token" not in h
    assert "X-Cinatra-Context-Attestation" not in h


def test_no_injection_on_unparseable_url(monkeypatch):
    """A malformed URL fails CLOSED (treated as not-internal)."""
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id="ctx-slotA-resolve_context"
    )
    req = _drive(
        loader,
        FakeApiCallStep,
        "http://host.docker.internal:not-a-port/api/context-resolve",
        ctx_id=CTX_ID,
    )
    h = req.get("headers", {})
    assert "X-Cinatra-Bridge-Token" not in h
    assert "X-Cinatra-Context-Attestation" not in h


def test_injection_anchors_to_custom_base_url(monkeypatch):
    """CINATRA_BASE_URL redirects the anchor: the custom host injects, the old
    default host does not."""
    FakeApiCallStep, loader = _install(
        monkeypatch,
        attest_key=ATTEST_KEY,
        node_id="ctx-slotA-resolve_context",
        base_url="https://cinatra.example.com:8443",
    )
    # Matches the custom base URL → injected.
    ok = _drive(
        loader,
        FakeApiCallStep,
        "https://cinatra.example.com:8443/api/context-resolve",
        ctx_id=CTX_ID,
    )
    assert ok["headers"]["X-Cinatra-Bridge-Token"] == BRIDGE_TOKEN
    assert "X-Cinatra-Context-Attestation" in ok["headers"]
    # The OLD default internal host is now foreign → nothing injected.
    nope = _drive(
        loader,
        FakeApiCallStep,
        f"{INTERNAL_HOST}/api/context-resolve",
        ctx_id=CTX_ID,
    )
    assert "X-Cinatra-Bridge-Token" not in nope.get("headers", {})


# ---------------------------------------------------------------------------
# Internal-host, non-attestation cases (bridge token / context id still gated on
# the host but not on the attestation substrings).
# ---------------------------------------------------------------------------


def test_no_attestation_on_non_context_url(monkeypatch):
    """An internal non-context URL (llm-bridge) carries the bridge token +
    context id but NOT the attestation headers."""
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id="ctx-slotA-resolve_context"
    )
    req = _drive(
        loader,
        FakeApiCallStep,
        f"{INTERNAL_HOST}/api/llm-bridge",
        ctx_id=CTX_ID,
    )
    assert "X-Cinatra-Context-Attestation" not in req["headers"]
    assert "X-Cinatra-Context-Node" not in req["headers"]
    # bridge token + context id are still injected for the internal llm-bridge.
    assert req["headers"]["X-Cinatra-Bridge-Token"] == BRIDGE_TOKEN
    assert req["headers"]["X-Cinatra-A2A-Context-Id"] == CTX_ID


def test_no_attestation_when_key_unset(monkeypatch, capsys):
    """Key unset → warn + no attestation header (server fails closed); the bridge
    token is still injected on the internal host (the two secrets are independent)."""
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=None, node_id="ctx-slotA-resolve_context"
    )
    captured = capsys.readouterr()
    assert "CINATRA_CONTEXT_ATTEST_KEY unset" in captured.out
    req = _drive(
        loader,
        FakeApiCallStep,
        f"{INTERNAL_HOST}/api/context-resolve",
        ctx_id=CTX_ID,
    )
    assert "X-Cinatra-Context-Attestation" not in req["headers"]
    assert req["headers"]["X-Cinatra-Bridge-Token"] == BRIDGE_TOKEN


def test_no_attestation_without_context_id(monkeypatch):
    """No run context-id (dev loopback) → no attestation minted (bridge token
    still injected on the internal host)."""
    FakeApiCallStep, loader = _install(
        monkeypatch, attest_key=ATTEST_KEY, node_id="ctx-slotA-resolve_context"
    )
    req = _drive(
        loader,
        FakeApiCallStep,
        f"{INTERNAL_HOST}/api/context-resolve",
        ctx_id="",
    )
    assert "X-Cinatra-Context-Attestation" not in req["headers"]
    assert "X-Cinatra-A2A-Context-Id" not in req["headers"]
    assert req["headers"]["X-Cinatra-Bridge-Token"] == BRIDGE_TOKEN


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
        f"{INTERNAL_HOST}/api/context-resolve",
        ctx_id=CTX_ID,
    )
    assert "X-Cinatra-Context-Attestation" not in req["headers"]
    # bridge token + context id still injected on the internal host.
    assert req["headers"]["X-Cinatra-Bridge-Token"] == BRIDGE_TOKEN
