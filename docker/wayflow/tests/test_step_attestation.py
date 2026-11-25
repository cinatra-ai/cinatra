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
  - `X-Cinatra-Execution-Attempt`: the execution attempt the task's own A2A
    message named (message metadata `__cinatra_execution_attempt__`);
  - `X-Cinatra-Step-Attestation`: `s2:<expiry>:<hex>`, the hex being
    HMAC-SHA256 with CINATRA_CONTEXT_ATTEST_KEY over
    `s2\\n<contextId>\\n<nodeId>\\n<attempt>\\n<raw>\\n<executed>\\n<declaration>\\n<expiry>`.

Without a binding or an attempt, or with a line break in the context id, the
step id or the attempt, it sets none of them. The application verifies the pair with the same key. The
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
EXECUTION_ATTEMPT = "X-Cinatra-Execution-Attempt"
ATTEMPT_ID = "attempt-under-test"
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
    "x-cinatra-execution-attempt",
)

#: The executing mount's binding: the three digests the loader records at mount.
SOURCE = {
    "sourceSha256": "a" * 64,
    "executedSourceSha256": "b" * 64,
    "declarationSourceSha256": "c" * 64,
}


def _s2_material(ctx: str, node_id: str, attempt: str, source: Dict[str, str], expiry: int) -> bytes:
    return (
        f"s2\n{ctx}\n{node_id}\n{attempt}\n{source['sourceSha256']}\n{source['executedSourceSha256']}"
        f"\n{source['declarationSourceSha256']}\n{expiry}"
    ).encode("utf-8")


def _expected_s2_sig(
    key: str, ctx: str, node_id: str, attempt: str, source: Dict[str, str], expiry: int
) -> str:
    return hmac.new(
        key.encode("utf-8"), _s2_material(ctx, node_id, attempt, source, expiry), hashlib.sha256
    ).hexdigest()


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
    attempt: str = ATTEMPT_ID,
) -> Dict[str, Any]:
    token = loader._WAYFLOW_CONTEXT_ID.set(ctx_id)
    # The execution attempt the task's message named, as the patched run_task
    # sets it. A loader without the variable signs no attempt.
    attempt_var = getattr(loader, "_WAYFLOW_EXECUTION_ATTEMPT", None)
    attempt_token = attempt_var.set(attempt) if attempt_var is not None else None
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
        if attempt_token is not None:
            attempt_var.reset(attempt_token)
        if source_token is not None:
            var.reset(source_token)
        loader._WAYFLOW_CONTEXT_ID.reset(token)


def _assert_signed_step(
    loader,
    headers: Dict[str, Any],
    before: int,
    after: int,
    source: Dict[str, str] = SOURCE,
    attempt: str = ATTEMPT_ID,
) -> None:
    assert headers[STEP_NODE] == NODE_ID
    assert headers.get(EXECUTION_ATTEMPT) == attempt
    assert headers.get(RAW_SOURCE) == source["sourceSha256"]
    assert headers.get(EXECUTED_SOURCE) == source["executedSourceSha256"]
    assert headers.get(DECLARATION_SOURCE) == source["declarationSourceSha256"]
    expiry, sig = _parse_s2_header(headers[STEP_ATTESTATION])
    ttl = loader._CONTEXT_ATTESTATION_TTL_SECONDS
    assert before + ttl <= expiry <= after + ttl
    assert sig == _expected_s2_sig(ATTEST_KEY, CTX_ID, NODE_ID, attempt, source, expiry)


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
            "x-cinatra-execution-attempt": "declared-attempt",
        },
    )
    after = int(time.time())
    h = req["headers"]
    signed = [k for k in h if k.lower() in SIGNED_NAMES]
    assert sorted(signed) == sorted(
        [STEP_NODE, STEP_ATTESTATION, RAW_SOURCE, EXECUTED_SOURCE, DECLARATION_SOURCE, EXECUTION_ATTEMPT]
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
                "x-cinatra-execution-attempt": "forged",
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


# (py8b) cinatra#3745 standing review: the runtime signs no context id, step
# id or attempt longer than the 512 characters the application accepts.
def test_no_step_or_source_pair_when_the_context_step_id_or_attempt_is_longer_than_512(monkeypatch):
    url = f"{INTERNAL_HOST}/api/llm-bridge"
    forged = {"x-cinatra-step-node": "forged", "x-cinatra-execution-attempt": "forged"}
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    # Control: 512 characters each are signed.
    before = int(time.time())
    req = _drive(loader, FakeApiCallStep, url, ctx_id=CTX_ID, attempt="a" * 512)
    after = int(time.time())
    _assert_signed_step(loader, req["headers"], before, after, attempt="a" * 512)
    req = _drive(loader, FakeApiCallStep, url, ctx_id="c" * 512)
    assert _signed_names(req["headers"]) == sorted(SIGNED_NAMES)
    req = _drive(loader, FakeApiCallStep, url, ctx_id="c" * 513, headers=forged)
    assert _signed_names(req["headers"]) == [], "context id 513"
    req = _drive(loader, FakeApiCallStep, url, ctx_id=CTX_ID, attempt="a" * 513, headers=forged)
    assert _signed_names(req["headers"]) == [], "attempt 513"
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id="n" * 512)
    req = _drive(loader, FakeApiCallStep, url, ctx_id=CTX_ID)
    assert req["headers"][STEP_NODE] == "n" * 512
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id="n" * 513)
    req = _drive(loader, FakeApiCallStep, url, ctx_id=CTX_ID, headers=forged)
    assert _signed_names(req["headers"]) == [], "step id 513"


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


# (py11) cinatra#3745 pre-1 finding 1: a task's pair is bound to the attempt its
# own message named, so a task of an earlier attempt cannot sign for a later one.
def test_no_step_or_source_pair_without_the_tasks_execution_attempt(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    assert hasattr(loader, "_WAYFLOW_EXECUTION_ATTEMPT"), "the loader holds the task's attempt"
    for attempt in ("", "attempt\nother", "attempt\rother"):
        for url in (f"{INTERNAL_HOST}/api/llm-bridge", f"{INTERNAL_HOST}/api/agents/passthrough"):
            req = _drive(
                loader,
                FakeApiCallStep,
                url,
                ctx_id=CTX_ID,
                attempt=attempt,
                headers={"x-cinatra-execution-attempt": "forged", "x-cinatra-step-node": "forged"},
            )
            assert _signed_names(req["headers"]) == [], (repr(attempt), url)


# (py12)
def test_each_task_signs_its_own_attempt(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    before = int(time.time())
    first = _drive(loader, FakeApiCallStep, f"{INTERNAL_HOST}/api/llm-bridge", ctx_id=CTX_ID, attempt="attempt-a")
    second = _drive(loader, FakeApiCallStep, f"{INTERNAL_HOST}/api/llm-bridge", ctx_id=CTX_ID, attempt="attempt-b")
    after = int(time.time())
    _assert_signed_step(loader, first["headers"], before, after, attempt="attempt-a")
    _assert_signed_step(loader, second["headers"], before, after, attempt="attempt-b")
    assert loader._WAYFLOW_EXECUTION_ATTEMPT.get() == ""


# (py13)
@pytest.mark.parametrize(
    "message, expected",
    [
        ({"metadata": {"__cinatra_execution_attempt__": "attempt-a"}}, "attempt-a"),
        ({"metadata": {"__cinatra_execution_attempt__": "attempt-a", "other": 1}}, "attempt-a"),
        ({"metadata": {}}, ""),
        ({"metadata": {"__cinatra_execution_attempt__": 7}}, ""),
        ({"metadata": {"__cinatra_execution_attempt__": ""}}, ""),
        ({"metadata": {"__cinatra_execution_attempt__": "a\nb"}}, ""),
        ({"metadata": {"__cinatra_execution_attempt__": "a\rb"}}, ""),
        ({"metadata": {"__cinatra_execution_attempt__": "a" * 513}}, ""),
        ({"metadata": "not a mapping"}, ""),
        # The text part is the flow's input: an attempt there is never read.
        ({"parts": [{"kind": "text", "text": '{"__cinatra_execution_attempt__": "attempt-a"}'}]}, ""),
        (None, ""),
    ],
)
def test_the_tasks_attempt_is_read_only_from_its_message_metadata(monkeypatch, message, expected):
    _, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    assert loader.CINATRA_EXECUTION_ATTEMPT_MESSAGE_KEY == "__cinatra_execution_attempt__"
    assert loader._execution_attempt_from_message(message) == expected


# ---------------------------------------------------------------------------
# cinatra#3745: the publish decision of the task's visit. A publish release
# names its decision in the resume message (metadata
# `__cinatra_publish_decision__`); the loader keeps it for that task and signs
# it beside the s2 pair, over the same values plus the decision id:
#   X-Cinatra-Publish-Decision:             <decisionId>
#   X-Cinatra-Publish-Decision-Attestation: s3:<expiry>:<hex>
# ---------------------------------------------------------------------------
PUBLISH_DECISION = "X-Cinatra-Publish-Decision"
PUBLISH_DECISION_ATTESTATION = "X-Cinatra-Publish-Decision-Attestation"
DECISION_NAMES = ("x-cinatra-publish-decision", "x-cinatra-publish-decision-attestation")


def _expected_s3_sig(decision: str, expiry: int, attempt: str = ATTEMPT_ID) -> str:
    material = (
        f"s3\n{CTX_ID}\n{NODE_ID}\n{attempt}\n{SOURCE['sourceSha256']}\n{SOURCE['executedSourceSha256']}"
        f"\n{SOURCE['declarationSourceSha256']}\n{decision}\n{expiry}"
    ).encode("utf-8")
    return hmac.new(ATTEST_KEY.encode("utf-8"), material, hashlib.sha256).hexdigest()


def _drive_with_decision(loader, FakeApiCallStep, url: str, decision: str, **kwargs) -> Dict[str, Any]:
    assert hasattr(loader, "_WAYFLOW_PUBLISH_DECISION"), "the loader holds the task's publish decision"
    token = loader._WAYFLOW_PUBLISH_DECISION.set(decision)
    try:
        return _drive(loader, FakeApiCallStep, url, ctx_id=CTX_ID, **kwargs)
    finally:
        loader._WAYFLOW_PUBLISH_DECISION.reset(token)


# (py14)
def test_a_call_of_a_released_visit_carries_its_signed_publish_decision_beside_the_step_pair(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    for url in (f"{INTERNAL_HOST}/api/llm-bridge", f"{INTERNAL_HOST}/api/agents/passthrough"):
        before = int(time.time())
        req = _drive_with_decision(loader, FakeApiCallStep, url, "decision-2")
        after = int(time.time())
        h = req["headers"]
        _assert_signed_step(loader, h, before, after)
        assert h[PUBLISH_DECISION] == "decision-2"
        version, expiry_str, sig = h[PUBLISH_DECISION_ATTESTATION].split(":", 2)
        assert version == "s3"
        expiry = int(expiry_str)
        ttl = loader._CONTEXT_ATTESTATION_TTL_SECONDS
        assert before + ttl <= expiry <= after + ttl
        assert sig == _expected_s3_sig("decision-2", expiry)


# (py15)
def test_no_publish_decision_headers_without_a_decision_or_without_the_step_pair(monkeypatch):
    FakeApiCallStep, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    forged = {PUBLISH_DECISION: "forged", "x-cinatra-publish-decision-attestation": "s3:1:00"}
    url = f"{INTERNAL_HOST}/api/llm-bridge"
    # No decision for this task: the flow's own decision headers are dropped, the s2 pair is signed as before.
    req = _drive_with_decision(loader, FakeApiCallStep, url, "", headers=forged)
    assert not [k for k in req["headers"] if k.lower() in DECISION_NAMES]
    assert req["headers"][STEP_NODE] == NODE_ID
    # No step pair (no attempt): no decision either.
    req = _drive_with_decision(loader, FakeApiCallStep, url, "decision-2", headers=forged, attempt="")
    assert not [k for k in req["headers"] if k.lower() in DECISION_NAMES]
    # A decision the application would refuse is not signed.
    for bad in ("a\nb", "a\rb", "d" * 513):
        req = _drive_with_decision(loader, FakeApiCallStep, url, bad)
        assert not [k for k in req["headers"] if k.lower() in DECISION_NAMES], repr(bad)
        assert req["headers"][STEP_NODE] == NODE_ID


# (py16)
@pytest.mark.parametrize(
    "message, expected",
    [
        ({"metadata": {"__cinatra_publish_decision__": "decision-2"}}, "decision-2"),
        ({"metadata": {}}, ""),
        ({"metadata": {"__cinatra_publish_decision__": 7}}, ""),
        ({"metadata": {"__cinatra_publish_decision__": ""}}, ""),
        ({"metadata": {"__cinatra_publish_decision__": "a\nb"}}, ""),
        ({"metadata": {"__cinatra_publish_decision__": "a" * 513}}, ""),
        ({"metadata": "not a mapping"}, ""),
        # The text part is the gate's answer: a decision there is never read.
        ({"parts": [{"kind": "text", "text": '{"__cinatra_publish_decision__": "decision-2"}'}]}, ""),
        (None, ""),
    ],
)
def test_the_tasks_publish_decision_is_read_only_from_its_message_metadata(monkeypatch, message, expected):
    _, loader = _install(monkeypatch, attest_key=ATTEST_KEY, node_id=NODE_ID)
    assert getattr(loader, "CINATRA_PUBLISH_DECISION_MESSAGE_KEY", None) == "__cinatra_publish_decision__"
    assert loader._publish_decision_from_message(message) == expected


# (py17) The patched run_task keeps the decision per task, beside the attempt, and resets it after the task.
def test_run_task_sets_and_resets_the_tasks_publish_decision():
    import pathlib

    source = (pathlib.Path(__file__).resolve().parent.parent / "agent_loader.py").read_text(encoding="utf-8")
    assert '_decision_token = _WAYFLOW_PUBLISH_DECISION.set(\n                _publish_decision_from_message(params.get("message"))' in source
    assert "_WAYFLOW_PUBLISH_DECISION.reset(_decision_token)" in source
