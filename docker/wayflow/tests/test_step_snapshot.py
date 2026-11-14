"""cinatra#4264 slice B1a: the runtime records a listed node's inputs.

T4 vectors: the shared fixture's inputs give the same canonical bytes, sha256
and attestation here as in packages/agents/src/__tests__/step-snapshots-4264.test.ts;
NaN, Infinity and a lone surrogate are dropped.

T5 capture: only listed TOP-LEVEL nodes of the root flow; the FULL inputs,
the note port included; platform keys excluded; an oversize or non-JSON
capture is dropped; a message that lists no node records nothing and leaves the
messages unchanged.

T7 target node after a resume: a run that pauses (in an injected context
subflow) before the filing node, then resumes, records the filing node's
snapshot on the resumed leg, because the resume message carries the list too.

Review 2: a node run twice in one leg with different inputs carries no
claim (MF1); credential members are stripped by the repository scrubber
before hashing (MF2); an Agent-wrapped root flow is recorded (MF4).

The module is pure, so these run without the runtime image.

Red at main: step_snapshot.py and the fixture do not exist.
"""
from __future__ import annotations

import ast
import hashlib
import hmac
import json
from pathlib import Path

import pytest

import step_snapshot as snap

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "step-snapshot-vectors.json"
VECTORS = json.loads(FIXTURE.read_text(encoding="utf-8"))
KEY = VECTORS["key"]
RUN = VECTORS["run_id"]
NODE = VECTORS["node"]
FLOW = VECTORS["flow_sha256"]


# --------------------------------------------------------------------- T4


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=lambda v: v["name"])
def test_vectors_match_the_fixture(vector):
    value = ast.literal_eval(vector["python"])
    raw = snap.canonical_json_bytes(value)
    assert raw.hex() == vector["bytes_hex"]
    assert raw.decode("utf-8") == vector["inputs_json"]
    assert hashlib.sha256(raw).hexdigest() == vector["sha256"]
    captured = snap.capture_node_inputs(NODE, value, run_id=RUN, flow_sha256=FLOW, key=KEY)
    assert captured == {
        "node": NODE,
        "inputs_json": vector["inputs_json"],
        "sha256": vector["sha256"],
        "flow_sha256": FLOW,
        "attestation": vector["attestation"],
    }
    material = f"n1\n{RUN}\n{NODE}\n{vector['sha256']}\n{FLOW}".encode("utf-8")
    assert vector["attestation"] == "n1:" + hmac.new(KEY.encode(), material, hashlib.sha256).hexdigest()


def test_the_listed_edge_values_survive_byte_exact():
    by_name = {v["name"]: v["inputs_json"] for v in VECTORS["vectors"]}
    assert by_name["weight-float"] == '{"weight":1.0}'
    assert by_name["negative-zero"] == '{"value":-0.0}'
    assert by_name["big-int"] == '{"value":9223372036854775808}'
    assert by_name["line-separator"] == '{"text":"a b"}'
    assert by_name["unsorted-nested"].startswith('{"a":null,"b":{"a":[3,{"x":1,"y":2}],"z":1}')


@pytest.mark.parametrize(
    "value",
    [{"v": float("nan")}, {"v": float("inf")}, {"v": "\ud800"}, {"v": object()}],
    ids=["nan", "infinity", "lone-surrogate", "non-json"],
)
def test_unserializable_inputs_are_dropped(value):
    logs = []
    assert snap.capture_node_inputs(NODE, value, run_id=RUN, flow_sha256=FLOW, key=KEY, log=logs.append) is None
    assert logs and "not recorded" in logs[0]


# --------------------------------------------------------------------- T5


class _Conv:
    pass


class _Step:
    """A stand-in of a wayflowcore Step: the recorder reads its ``id`` only."""

    def __init__(self, step_id):
        self.id = step_id


class _Flow:
    def __init__(self, *steps):
        self.steps = {s.id: s for s in steps}


class _RootConv:
    """A root conversation whose component is the root flow."""

    def __init__(self, *steps):
        self.component = _Flow(*steps)


PRODUCE, FILE_IMAGE = _Step("produce"), _Step("file_image")


def _recorder(nodes=("produce", "file_image"), root=None, key=KEY, steps=(PRODUCE, FILE_IMAGE)):
    return snap.SnapshotRecorder(
        run_id=RUN,
        nodes=frozenset(nodes),
        flow_sha256=FLOW,
        key=key,
        root_conversation=root,
        root_steps=steps,
        log=lambda *_: None,
    )


def test_only_listed_top_level_nodes_of_the_root_flow_are_recorded():
    root, sub = _Conv(), _Conv()
    not_listed = _Step("not_listed")
    rec = _recorder(root=root, steps=(PRODUCE, FILE_IMAGE, not_listed))
    rec.observe(PRODUCE, {"topic": "cats", "note": "brighter"}, root)
    rec.observe(not_listed, {"x": 1}, root)
    rec.observe(FILE_IMAGE, {"prompt": "in a subflow"}, sub)
    assert [s["node"] for s in rec.snapshots()] == ["produce"]


def test_a_nested_step_sharing_a_root_id_and_the_root_conversation_is_not_recorded():
    """Review 1 MF3 break-shaped input: a nested flow's ``file_image`` runs
    first, with the ROOT conversation; only the root flow's own ``file_image``
    Step object is recorded."""
    root = _Conv()
    nested_file_image = _Step("file_image")
    rec = _recorder(root=root)
    rec.observe(nested_file_image, {"prompt": "nested"}, root)
    assert rec.snapshots() == []
    rec.observe(FILE_IMAGE, {"prompt": "root"}, root)
    (only,) = rec.snapshots()
    assert json.loads(only["inputs_json"]) == {"prompt": "root"}


def test_full_inputs_with_the_note_port_platform_keys_excluded():
    root = _Conv()
    rec = _recorder(root=root)
    rec.observe(
        FILE_IMAGE,
        {
            "prompt": "a cat",
            "note": "make it brighter",
            "cinatra_run_id": "run-x",
            "agent_run_id": "run-x",
            "__cinatra_run_token__": "secret",
            "title": "Cat",
        },
        root,
    )
    (only,) = rec.snapshots()
    assert json.loads(only["inputs_json"]) == {"note": "make it brighter", "prompt": "a cat", "title": "Cat"}


def test_a_node_run_twice_in_a_leg_with_identical_inputs_stays_one_claim():
    root = _Conv()
    rec = _recorder(root=root)
    rec.observe(PRODUCE, {"n": 1}, root)
    rec.observe(PRODUCE, {"n": 1}, root)
    (only,) = rec.snapshots()
    assert json.loads(only["inputs_json"]) == {"n": 1}


def test_a_node_run_twice_in_a_leg_with_different_inputs_is_ambiguous():
    """Review 2 MF1: the second run's inputs differ, so the node's claim is
    ambiguous and the leg carries none for it (fail closed); a third run with
    the first inputs does not bring it back. The other node is unaffected."""
    root = _Conv()
    rec = _recorder(root=root)
    rec.observe(PRODUCE, {"n": 1}, root)
    rec.observe(FILE_IMAGE, {"prompt": "a cat"}, root)
    rec.observe(PRODUCE, {"n": 2}, root)
    rec.observe(PRODUCE, {"n": 1}, root)
    assert [s["node"] for s in rec.snapshots()] == ["file_image"]


def test_a_second_run_that_cannot_be_recorded_makes_the_node_ambiguous():
    """The second run's inputs are over the cap: they cannot be compared with
    the first, so the node carries no claim."""
    root = _Conv()
    rec = _recorder(root=root)
    rec.observe(PRODUCE, {"n": 1}, root)
    rec.observe(PRODUCE, {"blob": "x" * (snap.STEP_SNAPSHOT_MAX_BYTES + 1)}, root)
    assert rec.snapshots() == []


def _deeply_nested(depth):
    value = {"leaf": 1}
    for _ in range(depth):
        value = {"n": value}
    return value


def test_inputs_nested_too_deep_to_serialize_are_not_recorded():
    """Inputs nested about 5000 levels deep raise RecursionError while they
    are serialized: they cannot be recorded, so no snapshot is returned."""
    assert (
        snap.capture_node_inputs(
            NODE, _deeply_nested(5000), run_id=RUN, flow_sha256=FLOW, key=KEY, log=lambda *_: None
        )
        is None
    )


def test_a_second_run_too_deep_to_record_leaves_no_claim_through_the_real_wrapper():
    """The second run of a node in one leg has inputs nested about 5000
    levels deep. They cannot be recorded, so the node is ambiguous and the leg
    carries no claim for it: the first run's claim must not stay in place as a
    claim for the wrong run. The other node is unaffected."""
    import contextvars

    current = contextvars.ContextVar("rec", default=None)

    class LoopStep:
        def __init__(self, step_id):
            self.id = step_id

        async def invoke_async(self, inputs, conversation):
            return "ok"

    snap.install_invoke_capture(LoopStep, current.get, log=lambda *_: None)
    looping, steady = LoopStep("produce"), LoopStep("file_image")
    root = _Conv()
    rec = _recorder(root=root, steps=(looping, steady))
    token = current.set(rec)
    try:
        assert _run(looping.invoke_async({"draft": 1}, root)) == "ok"
        assert _run(steady.invoke_async({"prompt": "a cat"}, root)) == "ok"
        assert _run(looping.invoke_async(_deeply_nested(5000), root)) == "ok"
    finally:
        current.reset(token)
    assert [s["node"] for s in rec.snapshots()] == ["file_image"]


def test_a_self_looping_node_with_new_inputs_carries_no_claim_through_the_real_wrapper():
    """Review 2 MF1, the self-loop road (a node whose control edge returns
    to itself, cf. tests/test_publish_gate_insert.py:285): the SAME Step object
    is invoked twice in one leg through the installed ``invoke_async`` capture,
    first with one input dict, then with another."""
    import contextvars

    current = contextvars.ContextVar("rec", default=None)

    class LoopStep:
        def __init__(self, step_id):
            self.id = step_id

        async def invoke_async(self, inputs, conversation):
            return "ok"

    snap.install_invoke_capture(LoopStep, current.get, log=lambda *_: None)
    looping, steady = LoopStep("produce"), LoopStep("file_image")
    root = _Conv()
    rec = _recorder(root=root, steps=(looping, steady))
    token = current.set(rec)
    try:
        _run(looping.invoke_async({"draft": 1}, root))
        _run(steady.invoke_async({"prompt": "a cat"}, root))
        _run(steady.invoke_async({"prompt": "a cat"}, root))
        _run(looping.invoke_async({"draft": 2}, root))
    finally:
        current.reset(token)
    assert [s["node"] for s in rec.snapshots()] == ["file_image"]


def test_oversize_and_non_dict_are_dropped_and_no_key_records_nothing():
    root = _Conv()
    rec = _recorder(root=root)
    rec.observe(PRODUCE, {"blob": "x" * (snap.STEP_SNAPSHOT_MAX_BYTES + 1)}, root)
    rec.observe(FILE_IMAGE, ["not", "a", "dict"], root)
    assert rec.snapshots() == []
    keyless = _recorder(root=root, key="  ")
    keyless.observe(PRODUCE, {"n": 1}, root)
    assert keyless.snapshots() == []


def test_no_listed_node_means_no_request_and_unchanged_messages():
    assert snap.read_snapshot_request({"metadata": {"other": 1}}) is None
    assert snap.read_snapshot_request({"metadata": {snap.SNAPSHOT_NODES_METADATA_KEY: ["a"]}}) is None
    assert snap.read_snapshot_request({}) is None
    messages = [{"kind": "message", "role": "agent", "parts": [{"kind": "text", "text": "hi"}]}]
    before = json.dumps(messages, sort_keys=True)
    assert snap.attach_step_snapshots(messages, [], "task-1") is messages
    assert json.dumps(messages, sort_keys=True) == before


def test_snapshots_ride_the_last_message_or_a_carrier():
    s = {"node": "n", "inputs_json": "{}", "sha256": "0" * 64, "flow_sha256": FLOW, "attestation": "n1:x"}
    messages = [{"role": "agent", "parts": [], "metadata": {"keep": 1}}]
    snap.attach_step_snapshots(messages, [s], "task-1")
    assert messages[-1]["metadata"] == {"keep": 1, snap.STEP_SNAPSHOTS_METADATA_KEY: [s]}
    empty: list = []
    snap.attach_step_snapshots(empty, [s], "task-2")
    assert empty[0]["message_id"] == "cinatra-step-snapshots-task-2"
    assert empty[0]["metadata"][snap.STEP_SNAPSHOTS_METADATA_KEY] == [s]


# --------------------------------------------------------------------- T7


def test_the_filing_node_is_recorded_on_the_resumed_leg():
    """Leg 1 runs `produce`, then pauses in the context subflow's gate before
    `file_image`; leg 2 (a resume) runs `file_image`. Each leg reads the list
    from its own message, so the resumed leg records the filing node."""
    listed = {
        snap.SNAPSHOT_NODES_METADATA_KEY: ["file_image", "produce"],
        snap.SNAPSHOT_RUN_METADATA_KEY: RUN,
    }
    conversation = _RootConv(PRODUCE, FILE_IMAGE)  # one root conversation across both legs

    rec1 = snap.snapshot_recorder_for_leg(
        {"metadata": dict(listed)}, flow_sha256=FLOW, key=KEY, conversation=conversation
    )
    rec1.observe(PRODUCE, {"topic": "cats"}, conversation)
    rec1.observe(_Step("ctx-imageContext-resolve_context"), {"slot": "imageContext"}, _Conv())
    leg1_messages = snap.attach_step_snapshots([{"role": "agent", "parts": []}], rec1.snapshots(), "task-1")
    assert [s["node"] for s in leg1_messages[-1]["metadata"][snap.STEP_SNAPSHOTS_METADATA_KEY]] == ["produce"]

    resume_message = {"metadata": {"__cinatra_run_token__": "t2", **listed}}
    rec2 = snap.snapshot_recorder_for_leg(resume_message, flow_sha256=FLOW, key=KEY, conversation=conversation)
    assert rec2 is not None
    rec2.observe(FILE_IMAGE, {"prompt": "a cat", "note": ""}, conversation)
    leg2_messages = snap.attach_step_snapshots([], rec2.snapshots(), "task-2")
    (filed,) = leg2_messages[-1]["metadata"][snap.STEP_SNAPSHOTS_METADATA_KEY]
    assert filed["node"] == "file_image"
    assert filed["attestation"] == snap.snapshot_attestation(KEY, RUN, "file_image", filed["sha256"], FLOW)


# ------------------------------------------------- review 1 MF1 and MF2


def test_every_declared_node_is_requested_none_truncated():
    """MF1: 33 Regenerate entries (s00..s32, z00..z32) give 66 nodes; every one
    is recorded, z31 and z32 included."""
    nodes = sorted([f"s{i:02d}" for i in range(33)] + [f"z{i:02d}" for i in range(33)])
    request = snap.read_snapshot_request(
        {"metadata": {snap.SNAPSHOT_NODES_METADATA_KEY: nodes, snap.SNAPSHOT_RUN_METADATA_KEY: RUN}}
    )
    assert request is not None
    assert request["nodes"] == frozenset(nodes)
    root = _Conv()
    steps = [_Step(n) for n in nodes]
    rec = snap.SnapshotRecorder(
        run_id=RUN, nodes=request["nodes"], flow_sha256=FLOW, key=KEY, root_conversation=root,
        root_steps=steps, log=lambda *_: None,
    )
    for step in steps:
        rec.observe(step, {"n": step.id}, root)
    assert [s["node"] for s in rec.snapshots()] == nodes


@pytest.mark.parametrize("flow", ["x", "F" * 64, "f" * 63, ""], ids=["short", "upper", "63", "empty"])
def test_a_flow_version_that_is_not_64_lowercase_hex_records_nothing(flow):
    """MF2, runtime side: the flow version is a sha256 hex, as core requires."""
    assert snap.capture_node_inputs(NODE, {"a": 1}, run_id=RUN, flow_sha256=flow, key=KEY, log=lambda *_: None) is None


# ------------------------------------------- review 1 MF3 (pure halves)


def test_the_leg_recorder_reads_the_root_flow_steps_from_the_conversation():
    listed = {snap.SNAPSHOT_NODES_METADATA_KEY: ["file_image"], snap.SNAPSHOT_RUN_METADATA_KEY: RUN}
    conversation = _RootConv(PRODUCE, FILE_IMAGE)
    rec = snap.snapshot_recorder_for_leg({"metadata": listed}, flow_sha256=FLOW, key=KEY, conversation=conversation)
    assert rec is not None and rec.root_conversation is conversation
    rec.observe(_Step("file_image"), {"p": "nested"}, conversation)
    assert rec.snapshots() == []
    rec.observe(FILE_IMAGE, {"p": "root"}, conversation)
    assert [s["node"] for s in rec.snapshots()] == ["file_image"]
    # No list, no flow version, or a component with no steps: no recorder.
    assert snap.snapshot_recorder_for_leg({}, flow_sha256=FLOW, key=KEY, conversation=conversation) is None
    assert snap.snapshot_recorder_for_leg({"metadata": listed}, flow_sha256="", key=KEY, conversation=conversation) is None
    assert snap.snapshot_recorder_for_leg({"metadata": listed}, flow_sha256=FLOW, key=KEY, conversation=_Conv()) is None


def _run(coro):
    import asyncio

    return asyncio.run(coro)


def test_the_installed_capture_records_through_a_real_call():
    """The wrapper ``install_invoke_capture`` puts on ``Step.invoke_async``
    hands the step, inputs and conversation to the leg's recorder, for a
    positional and a keyword call, and runs the step either way."""
    import contextvars

    current = contextvars.ContextVar("rec", default=None)
    ran = []

    class FakeStep:
        def __init__(self, step_id):
            self.id = step_id

        async def invoke_async(self, inputs, conversation):
            ran.append(self.id)
            return "ok"

    snap.install_invoke_capture(FakeStep, current.get, log=lambda *_: None)
    snap.install_invoke_capture(FakeStep, current.get, log=lambda *_: None)  # idempotent
    a, b = FakeStep("produce"), FakeStep("file_image")
    root = _Conv()
    rec = _recorder(root=root, steps=(a, b))
    token = current.set(rec)
    try:
        assert _run(a.invoke_async({"n": 1}, root)) == "ok"
        assert _run(b.invoke_async(inputs={"n": 2}, conversation=root)) == "ok"
    finally:
        current.reset(token)
    assert ran == ["produce", "file_image"]
    assert [s["node"] for s in rec.snapshots()] == ["file_image", "produce"]
    # No recorder: the step runs, nothing is read.
    assert _run(a.invoke_async({"n": 3}, root)) == "ok"


def test_signature_drift_of_invoke_async_fails_loudly():
    class Drifted:
        async def invoke_async(self, extra, inputs, conversation):
            return None

    class Missing:
        pass

    with pytest.raises(RuntimeError, match="invoke_async"):
        snap.install_invoke_capture(Drifted, lambda: None)
    with pytest.raises(RuntimeError, match="invoke_async"):
        snap.install_invoke_capture(Missing, lambda: None)


def _loader_source():
    return (Path(__file__).resolve().parent.parent / "agent_loader.py").read_text(encoding="utf-8")


def test_the_loader_guards_and_installs_the_capture_at_startup():
    """The loader's startup live-binding guard names ``Step.invoke_async``,
    ``build_parent_app`` installs the capture, the patch goes through
    ``install_invoke_capture`` and the leg recorder through
    ``snapshot_recorder_for_leg``. (agent_loader itself imports only inside the
    runtime image; tests/test_step_snapshot_loader.py runs it there.)"""
    tree = ast.parse(_loader_source())
    bindings = None
    calls_by_function = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", None) == "_LIVE_CLASS_BINDINGS":
            bindings = ast.literal_eval(node.value)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names = set()
            for inner in ast.walk(node):
                if isinstance(inner, ast.Call):
                    f = inner.func
                    names.add(f.attr if isinstance(f, ast.Attribute) else getattr(f, "id", None))
            calls_by_function[node.name] = names
    assert bindings is not None
    assert ("wayflowcore", "Step", "invoke_async") in bindings
    assert "_patch_step_snapshot_capture" in calls_by_function["build_parent_app"]
    assert "install_invoke_capture" in calls_by_function["_patch_step_snapshot_capture"]
    assert any("snapshot_recorder_for_leg" in names for names in calls_by_function.values())


# ---------------------------------------------- Review 2 MF2 and MF4


def test_credential_members_are_stripped_by_the_repository_scrubber_before_hashing():
    """MF2, runtime side: a top-level and a nested ``api_key`` (and a ``token``
    in a list) are absent from ``inputs_json``; the sha256 and the attestation
    are over the canonical bytes of the STRIPPED object."""
    captured = snap.capture_node_inputs(
        NODE,
        {
            "prompt": "a cat",
            "api_key": "sk-top",
            "settings": {"api_key": "sk-nested", "size": "1024"},
            "tools": [{"token": "t-1", "name": "draw"}],
        },
        run_id=RUN,
        flow_sha256=FLOW,
        key=KEY,
    )
    assert captured is not None
    assert "sk-top" not in captured["inputs_json"] and "sk-nested" not in captured["inputs_json"]
    assert "api_key" not in captured["inputs_json"] and "t-1" not in captured["inputs_json"]
    stripped = {"prompt": "a cat", "settings": {"size": "1024"}, "tools": [{"name": "draw"}]}
    raw = snap.canonical_json_bytes(stripped)
    assert captured["inputs_json"] == raw.decode("utf-8")
    assert captured["sha256"] == hashlib.sha256(raw).hexdigest()
    assert captured["attestation"] == snap.snapshot_attestation(KEY, RUN, NODE, captured["sha256"], FLOW)


def test_the_strip_is_the_repository_scrubber_not_a_second_list():
    from cinatra_executors import input_message

    assert snap._scrub_credentials is input_message._scrub_credentials


def test_a_credential_member_inside_a_tuple_is_stripped_too():
    captured = snap.capture_node_inputs(
        NODE, {"pairs": ({"api_key": "sk-tuple", "v": 1},)}, run_id=RUN, flow_sha256=FLOW, key=KEY
    )
    assert captured is not None and json.loads(captured["inputs_json"]) == {"pairs": [{"v": 1}]}


class _Agent:
    """An Agent-wrapped root: no ``steps`` of its own, the flow under ``flow``."""

    def __init__(self, flow):
        self.flow = flow


class _ListFlow:
    def __init__(self, *steps):
        self.steps = list(steps)


def test_an_agent_wrapped_root_flow_gets_its_snapshots():
    """MF4: the recorder resolves the root steps as agent_loader.py:1541-1549
    does (``component.steps``, else ``component.flow.steps``)."""
    listed = {snap.SNAPSHOT_NODES_METADATA_KEY: ["file_image"], snap.SNAPSHOT_RUN_METADATA_KEY: RUN}
    inner = _Flow(PRODUCE, FILE_IMAGE)
    conversation = _Conv()
    conversation.component = _Agent(inner)
    rec = snap.snapshot_recorder_for_leg({"metadata": listed}, flow_sha256=FLOW, key=KEY, conversation=conversation)
    assert rec is not None
    rec.observe(FILE_IMAGE, {"prompt": "root"}, conversation)
    (only,) = rec.snapshots()
    assert only["node"] == "file_image" and json.loads(only["inputs_json"]) == {"prompt": "root"}


def test_an_agent_wrapped_root_flow_running_in_its_own_conversation_is_recorded():
    """The wrapped flow may run in a conversation of its own whose component is
    that very flow: its own steps are recorded there; a nested flow's
    conversation (another component) is not."""
    listed = {snap.SNAPSHOT_NODES_METADATA_KEY: ["file_image", "produce"], snap.SNAPSHOT_RUN_METADATA_KEY: RUN}
    inner = _ListFlow(PRODUCE, FILE_IMAGE)
    agent_conversation = _Conv()
    agent_conversation.component = _Agent(inner)
    flow_conversation = _Conv()
    flow_conversation.component = inner
    nested_conversation = _Conv()
    nested_conversation.component = _Flow(_Step("other"))
    rec = snap.snapshot_recorder_for_leg(
        {"metadata": listed}, flow_sha256=FLOW, key=KEY, conversation=agent_conversation
    )
    assert rec is not None
    rec.observe(PRODUCE, {"topic": "cats"}, nested_conversation)
    assert rec.snapshots() == []
    rec.observe(PRODUCE, {"topic": "cats"}, flow_conversation)
    assert [s["node"] for s in rec.snapshots()] == ["produce"]
