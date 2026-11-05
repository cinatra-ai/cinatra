"""cinatra#3745 — the runtime signs the identity of the executing step, and the
source of the assistant that executes it, on a run's model-bridge and
passthrough calls.

On a call to the configured internal host whose URL targets the model bridge
(`llm-bridge`) or the deterministic passthrough road (`/agents/passthrough`),
while the task's executing assistant carries its frozen mount binding, the
ApiCallStep patch sets:

  - `X-Cinatra-Raw-Source`, `X-Cinatra-Executed-Source` and
    `X-Cinatra-Declaration-Source`: the three digests of that binding;
  - `X-Cinatra-Step-Node`: the executing compiled step's own id (`self.id`);
  - `X-Cinatra-Step-Attestation`: `s2:<expiry>:<hex>`, the hex being
    HMAC-SHA256 with CINATRA_CONTEXT_ATTEST_KEY over
    `s2\\n<contextId>\\n<nodeId>\\n<raw>\\n<executed>\\n<declaration>\\n<expiry>`.

Without a binding, or with a line break in the context or step id, it sets
none of them. The application verifies the pair with the same key. The
context-resolution pair on the context routes is unchanged.

These tests stub `wayflowcore.steps.ApiCallStep`, mirroring
test_context_attestation.py.
"""

import asyncio
import hashlib
import hmac
import sys
import time
from types import MappingProxyType
from typing import Any, Dict, Optional, Tuple
from unittest.mock import MagicMock

import pytest

ATTEST_KEY = "attest-key-under-test"
BRIDGE_TOKEN = "bridge-tok-abc"
CTX_ID = "conv-ctx-id-123"
NODE_ID = "step-node-under-test"

INTERNAL_HOST = "http://host.docker.internal:3000"

STEP_NODE = "X-Cinatra-Step-Node"
STEP_ATTESTATION = "X-Cinatra-Step-Attestation"
RAW_SOURCE = "X-Cinatra-Raw-Source"
EXECUTED_SOURCE = "X-Cinatra-Executed-Source"
DECLARATION_SOURCE = "X-Cinatra-Declaration-Source"
SIGNED_NAMES = (
    "x-cinatra-step-node",
    "x-cinatra-step-attestation",
    "x-cinatra-raw-source",
    "x-cinatra-executed-source",
    "x-cinatra-declaration-source",
)

#: The executing mount's binding: the three digests the loader records at mount.
SOURCE = {
    "sourceSha256": "a" * 64,
    "executedSourceSha256": "b" * 64,
    "declarationSourceSha256": "c" * 64,
}


def _s2_material(ctx: str, node_id: str, source: Dict[str, str], expiry: int) -> bytes:
    return (
        f"s2\n{ctx}\n{node_id}\n{source['sourceSha256']}\n{source['executedSourceSha256']}"
        f"\n{source['declarationSourceSha256']}\n{expiry}"
    ).encode("utf-8")


def _expected_s2_sig(key: str, ctx: str, node_id: str, source: Dict[str, str], expiry: int) -> str:
    return hmac.new(key.encode("utf-8"), _s2_material(ctx, node_id, source, expiry), hashlib.sha256).hexdigest()


def _parse_s2_header(value: str) -> Tuple[int, str]:
    version, expiry_str, sig = value.split(":", 2)
    assert version == "s2", "expected a source-bound s2 step attestation"
    return int(expiry_str), sig


def _signed_names(headers: Dict[str, Any]):
    return sorted(k.lower() for k in headers if k.lower() in SIGNED_NAMES)


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
    source: Optional[Dict[str, str]] = SOURCE,
) -> Dict[str, Any]:
    token = loader._WAYFLOW_CONTEXT_ID.set(ctx_id)
    # The executing task's mount binding, as the patched run_task sets it. A
    # loader without the binding variable signs no source (the test then reads
    # the headers it sent).
    var = getattr(loader, "_WAYFLOW_EXECUTED_SOURCE", None)
    source_token = (
        var.set(MappingProxyType(dict(source)) if source is not None else None)
        if var is not None
        else None
    )
    try:
        instance = FakeApiCallStep()
        request: Dict[str, Any] = {"url": url}
        if headers is not None:
            request["headers"] = dict(headers)
        asyncio.run(instance._execute_request(request))
        return request
    finally:
        if source_token is not None:
            var.reset(source_token)
        loader._WAYFLOW_CONTEXT_ID.reset(token)


def _assert_signed_step(
    loader, headers: Dict[str, Any], before: int, after: int, source: Dict[str, str] = SOURCE
) -> None:
    assert headers[STEP_NODE] == NODE_ID
    assert headers.get(RAW_SOURCE) == source["sourceSha256"]
    assert headers.get(EXECUTED_SOURCE) == source["executedSourceSha256"]
    assert headers.get(DECLARATION_SOURCE) == source["declarationSourceSha256"]
    expiry, sig = _parse_s2_header(headers[STEP_ATTESTATION])
    ttl = loader._CONTEXT_ATTESTATION_TTL_SECONDS
    assert before + ttl <= expiry <= after + ttl
    assert sig == _expected_s2_sig(ATTEST_KEY, CTX_ID, NODE_ID, source, expiry)


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
            STEP_ATTESTATION: "s2:1:00",
            "x-cinatra-step-node": "declared-node-lower",
            "x-cinatra-step-attestation": "s2:1:11",
            RAW_SOURCE: "f" * 64,
            "x-cinatra-executed-source": "f" * 64,
            "X-CINATRA-DECLARATION-SOURCE": "f" * 64,
        },
    )
    after = int(time.time())
    h = req["headers"]
    signed = [k for k in h if k.lower() in SIGNED_NAMES]
    assert sorted(signed) == sorted(
        [STEP_NODE, STEP_ATTESTATION, RAW_SOURCE, EXECUTED_SOURCE, DECLARATION_SOURCE]
    )
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
        assert _signed_names(h) == [], url


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


# (py7)
def test_no_step_or_source_pair_without_the_executing_mount_binding(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    for url in (f"{INTERNAL_HOST}/api/llm-bridge", f"{INTERNAL_HOST}/api/agents/passthrough"):
        req = _drive(
            loader,
            FakeApiCallStep,
            url,
            ctx_id=CTX_ID,
            source=None,
            headers={
                "x-cinatra-step-node": "forged",
                "x-cinatra-step-attestation": "s2:1:00",
                "x-cinatra-raw-source": "f" * 64,
                "x-cinatra-executed-source": "f" * 64,
                "x-cinatra-declaration-source": "f" * 64,
            },
        )
        assert _signed_names(req["headers"]) == [], url


# (py8)
def test_no_step_or_source_pair_when_the_context_or_step_id_holds_a_line_break(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    for ctx in ("ctx\nother", "ctx\rother"):
        req = _drive(loader, FakeApiCallStep, f"{INTERNAL_HOST}/api/llm-bridge", ctx_id=ctx)
        assert _signed_names(req["headers"]) == [], repr(ctx)
    for node in ("step\nother", "step\rother"):
        FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=node)
        req = _drive(loader, FakeApiCallStep, f"{INTERNAL_HOST}/api/llm-bridge", ctx_id=CTX_ID)
        assert _signed_names(req["headers"]) == [], repr(node)


# (py9)
def test_each_call_signs_the_binding_of_its_own_task(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    other = {**SOURCE, "executedSourceSha256": "d" * 64}
    before = int(time.time())
    first = _drive(loader, FakeApiCallStep, f"{INTERNAL_HOST}/api/llm-bridge", ctx_id=CTX_ID)
    second = _drive(
        loader, FakeApiCallStep, f"{INTERNAL_HOST}/api/llm-bridge", ctx_id=CTX_ID, source=other
    )
    after = int(time.time())
    _assert_signed_step(loader, first["headers"], before, after)
    _assert_signed_step(loader, second["headers"], before, after, source=other)
    assert first["headers"][STEP_ATTESTATION] != second["headers"][STEP_ATTESTATION]
    assert loader._WAYFLOW_EXECUTED_SOURCE.get() is None


# (py10)
@pytest.mark.parametrize(
    "assistant_binding, expected",
    [
        (MappingProxyType(dict(SOURCE)), "frozen"),
        (dict(SOURCE), None),
        (None, None),
        ("not a binding", None),
    ],
)
def test_the_task_binding_is_only_the_frozen_mount_snapshot(monkeypatch, assistant_binding, expected):
    _, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)

    class Assistant:
        pass

    assistant = Assistant()
    if assistant_binding is not None:
        assistant._cinatra_executed_source = assistant_binding
    token = loader._set_executed_source_for(assistant)
    try:
        current = loader._WAYFLOW_EXECUTED_SOURCE.get()
        if expected == "frozen":
            assert current is assistant_binding
        else:
            assert current is None
    finally:
        loader._WAYFLOW_EXECUTED_SOURCE.reset(token)
    assert loader._WAYFLOW_EXECUTED_SOURCE.get() is None
