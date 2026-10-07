"""cinatra#3745 — the runtime signs the identity of the executing step on a run's
model-bridge and passthrough calls.

On a call to the configured internal host whose URL targets the model bridge
(`llm-bridge`) or the deterministic passthrough road (`/agents/passthrough`),
the ApiCallStep patch sets:

  - `X-Cinatra-Step-Node`: the executing compiled step's own id (`self.id`);
  - `X-Cinatra-Step-Attestation`: `s1:<expiry>:<hex>`, the hex being
    HMAC-SHA256 with CINATRA_CONTEXT_ATTEST_KEY over
    `s1\\n<contextId>\\n<nodeId>\\n<expiry>`.

The application verifies the pair with the same key. The context-resolution
pair on the context routes is unchanged.

These tests stub `wayflowcore.steps.ApiCallStep`, mirroring
test_context_attestation.py.
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
NODE_ID = "step-node-under-test"

INTERNAL_HOST = "http://host.docker.internal:3000"

STEP_NODE = "X-Cinatra-Step-Node"
STEP_ATTESTATION = "X-Cinatra-Step-Attestation"


def _s1_material(ctx: str, node_id: str, expiry: int) -> bytes:
    return f"s1\n{ctx}\n{node_id}\n{expiry}".encode("utf-8")


def _expected_s1_sig(key: str, ctx: str, node_id: str, expiry: int) -> str:
    return hmac.new(key.encode("utf-8"), _s1_material(ctx, node_id, expiry), hashlib.sha256).hexdigest()


def _parse_s1_header(value: str) -> Tuple[int, str]:
    version, expiry_str, sig = value.split(":", 2)
    assert version == "s1", "expected an s1 step attestation"
    return int(expiry_str), sig


def _install(
    monkeypatch,
    *,
    attest_key: Optional[str],
    node_id: Optional[str],
    base_url: Optional[str] = None,
):
    """Install the patch with a fresh FakeApiCallStep (a fresh class keeps the
    idempotency sentinel from short-circuiting across tests)."""

    class FakeApiCallStep:
        async def _execute_request(self, request: Dict[str, Any]) -> str:
            return "ok"

    if node_id is not None:
        FakeApiCallStep.id = node_id

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

    agent_loader._patch_api_call_step_bridge_token()
    return FakeApiCallStep, agent_loader


def _drive(
    loader,
    FakeApiCallStep,
    url: str,
    *,
    ctx_id: str,
    headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    token = loader._WAYFLOW_CONTEXT_ID.set(ctx_id)
    try:
        instance = FakeApiCallStep()
        request: Dict[str, Any] = {"url": url}
        if headers is not None:
            request["headers"] = dict(headers)
        asyncio.run(instance._execute_request(request))
        return request
    finally:
        loader._WAYFLOW_CONTEXT_ID.reset(token)


def _assert_signed_step(loader, headers: Dict[str, Any], before: int, after: int) -> None:
    assert headers[STEP_NODE] == NODE_ID
    expiry, sig = _parse_s1_header(headers[STEP_ATTESTATION])
    ttl = loader._CONTEXT_ATTESTATION_TTL_SECONDS
    assert before + ttl <= expiry <= after + ttl
    assert sig == _expected_s1_sig(ATTEST_KEY, CTX_ID, NODE_ID, expiry)


# (py1)
def test_model_bridge_call_carries_the_signed_step_identity(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    before = int(time.time())
    req = _drive(loader, FakeApiCallStep, f"{INTERNAL_HOST}/api/llm-bridge", ctx_id=CTX_ID)
    after = int(time.time())
    _assert_signed_step(loader, req["headers"], before, after)


# (py2)
def test_passthrough_call_carries_the_signed_step_identity(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    before = int(time.time())
    req = _drive(
        loader, FakeApiCallStep, f"{INTERNAL_HOST}/api/agents/passthrough", ctx_id=CTX_ID
    )
    after = int(time.time())
    _assert_signed_step(loader, req["headers"], before, after)


# (py3)
def test_runtime_step_values_replace_step_headers_declared_by_the_flow(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    before = int(time.time())
    req = _drive(
        loader,
        FakeApiCallStep,
        f"{INTERNAL_HOST}/api/llm-bridge",
        ctx_id=CTX_ID,
        headers={
            STEP_NODE: "declared-node",
            STEP_ATTESTATION: "s1:1:00",
            "x-cinatra-step-node": "declared-node-lower",
            "x-cinatra-step-attestation": "s1:1:11",
        },
    )
    after = int(time.time())
    h = req["headers"]
    step_names = [k for k in h if k.lower() in ("x-cinatra-step-node", "x-cinatra-step-attestation")]
    assert sorted(step_names) == sorted([STEP_NODE, STEP_ATTESTATION])
    _assert_signed_step(loader, h, before, after)


# (py4)
def test_context_resolve_call_carries_the_context_pair_and_no_step_pair(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    req = _drive(loader, FakeApiCallStep, f"{INTERNAL_HOST}/api/context-resolve", ctx_id=CTX_ID)
    h = req["headers"]
    assert STEP_NODE not in h
    assert STEP_ATTESTATION not in h
    assert h["X-Cinatra-Context-Node"] == NODE_ID
    version, expiry_str, sig = h["X-Cinatra-Context-Attestation"].split(":", 2)
    assert version == "v2"
    expected = hmac.new(
        ATTEST_KEY.encode("utf-8"),
        f"v2\n{CTX_ID}\n{NODE_ID}\n{int(expiry_str)}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    assert sig == expected


# (py5)
def test_calls_to_another_host_port_or_an_unparseable_url_carry_no_step_pair(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    for url in (
        "http://other.example.com/api/llm-bridge",
        "http://host.docker.internal:8080/api/agents/passthrough",
        "not a url at all llm-bridge",
    ):
        req = _drive(loader, FakeApiCallStep, url, ctx_id=CTX_ID)
        h = req.get("headers", {})
        assert STEP_NODE not in h, url
        assert STEP_ATTESTATION not in h, url


# (py6)
def test_no_step_pair_without_key_context_id_or_node_id(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=None, node_id=NODE_ID)
    req = _drive(loader, FakeApiCallStep, f"{INTERNAL_HOST}/api/llm-bridge", ctx_id=CTX_ID)
    assert STEP_NODE not in req["headers"]
    assert STEP_ATTESTATION not in req["headers"]

    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    req = _drive(loader, FakeApiCallStep, f"{INTERNAL_HOST}/api/llm-bridge", ctx_id="")
    assert STEP_NODE not in req["headers"]
    assert STEP_ATTESTATION not in req["headers"]

    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=None)
    req = _drive(
        loader, FakeApiCallStep, f"{INTERNAL_HOST}/api/agents/passthrough", ctx_id=CTX_ID
    )
    assert STEP_NODE not in req["headers"]
    assert STEP_ATTESTATION not in req["headers"]
