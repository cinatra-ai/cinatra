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


def _recorder(nodes=("produce", "file_image"), root=None, key=KEY):
    return snap.SnapshotRecorder(
        run_id=RUN, nodes=frozenset(nodes), flow_sha256=FLOW, key=key, root_conversation=root, log=lambda *_: None
    )


def test_only_listed_top_level_nodes_of_the_root_flow_are_recorded():
    root, sub = _Conv(), _Conv()
    rec = _recorder(root=root)
    rec.observe("produce", {"topic": "cats", "note": "brighter"}, root)
    rec.observe("not_listed", {"x": 1}, root)
    rec.observe("file_image", {"prompt": "in a subflow"}, sub)
    assert [s["node"] for s in rec.snapshots()] == ["produce"]


def test_full_inputs_with_the_note_port_platform_keys_excluded():
    root = _Conv()
    rec = _recorder(root=root)
    rec.observe(
        "file_image",
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


def test_first_capture_in_a_leg_wins():
    root = _Conv()
    rec = _recorder(root=root)
    rec.observe("produce", {"n": 1}, root)
    rec.observe("produce", {"n": 2}, root)
    assert json.loads(rec.snapshots()[0]["inputs_json"]) == {"n": 1}


def test_oversize_and_non_dict_are_dropped_and_no_key_records_nothing():
    root = _Conv()
    rec = _recorder(root=root)
    rec.observe("produce", {"blob": "x" * (snap.STEP_SNAPSHOT_MAX_BYTES + 1)}, root)
    rec.observe("file_image", ["not", "a", "dict"], root)
    assert rec.snapshots() == []
    keyless = _recorder(root=root, key="  ")
    keyless.observe("produce", {"n": 1}, root)
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
    conversation = _Conv()  # one root conversation across both legs

    leg1 = snap.read_snapshot_request({"metadata": dict(listed)})
    rec1 = snap.SnapshotRecorder(
        run_id=leg1["run_id"], nodes=leg1["nodes"], flow_sha256=FLOW, key=KEY, root_conversation=conversation
    )
    rec1.observe("produce", {"topic": "cats"}, conversation)
    rec1.observe("ctx-imageContext-resolve_context", {"slot": "imageContext"}, _Conv())
    leg1_messages = snap.attach_step_snapshots([{"role": "agent", "parts": []}], rec1.snapshots(), "task-1")
    assert [s["node"] for s in leg1_messages[-1]["metadata"][snap.STEP_SNAPSHOTS_METADATA_KEY]] == ["produce"]

    resume_message = {"metadata": {"__cinatra_run_token__": "t2", **listed}}
    leg2 = snap.read_snapshot_request(resume_message)
    assert leg2 is not None
    rec2 = snap.SnapshotRecorder(
        run_id=leg2["run_id"], nodes=leg2["nodes"], flow_sha256=FLOW, key=KEY, root_conversation=conversation
    )
    rec2.observe("file_image", {"prompt": "a cat", "note": ""}, conversation)
    leg2_messages = snap.attach_step_snapshots([], rec2.snapshots(), "task-2")
    (filed,) = leg2_messages[-1]["metadata"][snap.STEP_SNAPSHOTS_METADATA_KEY]
    assert filed["node"] == "file_image"
    assert filed["attestation"] == snap.snapshot_attestation(KEY, RUN, "file_image", filed["sha256"], FLOW)
