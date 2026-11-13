"""cinatra#4264 slice B1b: the runtime runs one step and its filing node.

T9 derivation (pure): the blog pipeline document of blog-pipeline-agent
b529ea6 (its three subflows reduced to their inputs and outputs) plus the note
edges slice C adds (``start.note -> draft_flow.note``, ``start.prompt ->
image_flow.prompt``) derives the segments ``(image_flow, file_image,
prompt)`` and ``(draft_flow, write_draft, note)``; a step that is its own
filing node derives; node ids and ports with ``:`` derive; every refusal of
the module header refuses with REGENERATE_SEGMENT_INVALID.

T10 repeated step: two entries share ``step: produce`` with the notes
``textNote`` and ``imageNote``; each segment feeds only its own note port from
the note, the other port keeps the snapshot value.

T11 (runtime half): a mounted flow version that differs from ``flowSha256``
refuses with REGENERATE_FLOW_CHANGED before anything else is read; a
snapshot whose bytes do not match its sha256, a missing snapshot value and a
missing note refuse.

T12 (runtime half): ``/.health`` lists ``regenerate_segment/1``; the receipt
is the g1 HMAC of the shared vectors, which the application test reads too.

The module is pure, so these run without the runtime image. The loader
wiring is read from its source here (the loader imports the runtime's
packages); test_regenerate_segment_loader.py runs it inside the image.

Red at the B1a head: regenerate_segment.py and both fixtures do not exist,
and the loader neither lists the capability nor branches on the request.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import json
import re
from pathlib import Path

import pytest

import regenerate_segment as rs

HERE = Path(__file__).resolve().parent
PIPELINE = json.loads((HERE / "fixtures" / "regenerate-segment-blog-pipeline.json").read_text(encoding="utf-8"))
RECEIPTS = json.loads((HERE / "fixtures" / "regenerate-segment-receipt-vectors.json").read_text(encoding="utf-8"))
LOADER_SOURCE = (HERE.parent / "agent_loader.py").read_text(encoding="utf-8")
FLOW = "f" * 64


def _refs(doc):
    return doc["$referenced_components"]


def _data_edges(doc):
    return [
        (
            e["source_node"]["$component_ref"],
            e["source_output"],
            e["destination_node"]["$component_ref"],
            e["destination_input"],
        )
        for e in doc["data_flow_connections"]
    ]


def _control_chain(doc):
    return [(e["from_node"]["$component_ref"], e["to_node"]["$component_ref"]) for e in doc["control_flow_connections"]]


def _code(excinfo):
    return excinfo.value.code


# --------------------------------------------------------------------- T9


def test_the_picture_segment_of_the_pipeline():
    d = rs.derive_regenerate_segment(PIPELINE, "image_flow", "file_image", "prompt")
    doc = d["doc"]
    assert d["note_source"] == "prompt"
    assert [n["$component_ref"] for n in doc["nodes"]] == [
        rs.SEGMENT_START_ID,
        "image_flow",
        "file_image",
        rs.SEGMENT_END_ID,
    ]
    assert _control_chain(doc) == [
        (rs.SEGMENT_START_ID, "image_flow"),
        ("image_flow", "file_image"),
        ("file_image", rs.SEGMENT_END_ID),
    ]
    edges = _data_edges(doc)
    # The step -> filing node edge, verbatim (the original edge object).
    original = [e for e in PIPELINE["data_flow_connections"] if e["id"] == "image:image_flow->file_image.image"]
    assert original and original[0] in doc["data_flow_connections"]
    assert ("image_flow", "image", "file_image", "image") in edges
    # The note, from the reserved start output only.
    assert (rs.SEGMENT_START_ID, rs.SEGMENT_NOTE_OUTPUT, "image_flow", "prompt") in edges
    # Platform keys from the start output of the same name.
    assert (rs.SEGMENT_START_ID, "cinatra_run_id", "image_flow", "cinatra_run_id") in edges
    assert (rs.SEGMENT_START_ID, "cinatra_run_id", "file_image", "cinatra_run_id") in edges
    # Every other port of the two nodes from cinatra_seg_<i>, sorted (node, port).
    assert d["ports"] == sorted(d["ports"])
    assert ("file_image", "title") in d["ports"] and ("file_image", "postArtifactId") in d["ports"]
    assert ("image_flow", "post") in d["ports"] and ("image_flow", "placement") in d["ports"]
    assert ("image_flow", "prompt") not in d["ports"] and ("file_image", "image") not in d["ports"]
    for i, (node, port) in enumerate(d["ports"]):
        assert (rs.SEGMENT_START_ID, f"cinatra_seg_{i}", node, port) in edges
    # Nothing from outside the segment feeds it: every source is the start or the step.
    assert {e[0] for e in edges} <= {rs.SEGMENT_START_ID, "image_flow", "file_image"}
    # The end exposes the filing node's outputs.
    assert [o["title"] for o in _refs(doc)[rs.SEGMENT_END_ID]["outputs"]] == ["artifactId", "representationRevisionId"]
    assert ("file_image", "artifactId", rs.SEGMENT_END_ID, "artifactId") in edges
    # The two nodes verbatim; only what they reach comes along.
    assert _refs(doc)["file_image"] == _refs(PIPELINE)["file_image"]
    assert _refs(doc)["image_flow"] == _refs(PIPELINE)["image_flow"]
    assert set(_refs(doc)) == {
        rs.SEGMENT_START_ID,
        rs.SEGMENT_END_ID,
        "image_flow",
        "file_image",
        "blog-image-generator-agent-subflow",
    }
    # The start outputs are reserved names only.
    titles = [i["title"] for i in _refs(doc)[rs.SEGMENT_START_ID]["inputs"]]
    assert all(t == "cinatra_run_id" or t.startswith("cinatra_seg_") for t in titles)
    assert [i["title"] for i in doc["inputs"]] == titles
    # The derivation never changes the mounted document.
    assert PIPELINE == json.loads((HERE / "fixtures" / "regenerate-segment-blog-pipeline.json").read_text("utf-8"))


def test_the_draft_segment_of_the_pipeline():
    d = rs.derive_regenerate_segment(PIPELINE, "draft_flow", "write_draft", "note")
    edges = _data_edges(d["doc"])
    assert d["note_source"] == "note"
    assert ("draft_flow", "title", "write_draft", "title") in edges
    assert ("draft_flow", "content", "write_draft", "content") in edges
    assert (rs.SEGMENT_START_ID, rs.SEGMENT_NOTE_OUTPUT, "draft_flow", "note") in edges
    # idea is fed by reserve_idea in the pipeline; in the segment it comes from the snapshot.
    assert ("draft_flow", "idea") in d["ports"]
    assert all(node == "draft_flow" for node, _ in d["ports"])
    assert "reserve_idea" not in _refs(d["doc"])


def _tiny(step_kind="ApiNode", ids=("start", "produce", "file", "end"), ports=("note", "topic"), extra_edges=()):
    start, produce, file_, end = ids
    note, topic = ports
    doc = {
        "agentspec_version": "25.4.1",
        "component_type": "Flow",
        "id": "tiny",
        "name": "tiny",
        "inputs": [{"title": "userNote", "type": "string"}, {"title": "cinatra_run_id", "type": "string"}],
        "outputs": [],
        "start_node": {"$component_ref": start},
        "nodes": [{"$component_ref": n} for n in ids],
        "control_flow_connections": [
            {"component_type": "ControlFlowEdge", "id": f"c{i}", "from_node": {"$component_ref": a},
             "from_branch": None, "to_node": {"$component_ref": b}}
            for i, (a, b) in enumerate(zip(ids, ids[1:]))
        ],
        "data_flow_connections": [
            {"component_type": "DataFlowEdge", "id": "d1", "source_node": {"$component_ref": start},
             "source_output": "userNote", "destination_node": {"$component_ref": produce}, "destination_input": note},
            {"component_type": "DataFlowEdge", "id": "d2", "source_node": {"$component_ref": produce},
             "source_output": "out", "destination_node": {"$component_ref": file_}, "destination_input": "body"},
            {"component_type": "DataFlowEdge", "id": "d3", "source_node": {"$component_ref": start},
             "source_output": "cinatra_run_id", "destination_node": {"$component_ref": file_},
             "destination_input": "cinatra_run_id"},
            *extra_edges,
        ],
        "$referenced_components": {
            start: {"component_type": "StartNode", "id": start, "name": start,
                    "inputs": [{"title": "userNote", "type": "string"}, {"title": "cinatra_run_id", "type": "string"}]},
            produce: {"component_type": step_kind, "id": produce, "name": produce,
                      "inputs": [{"title": note, "type": "string"}, {"title": topic, "type": "string"}],
                      "outputs": [{"title": "out", "type": "string"}]},
            file_: {"component_type": "ApiNode", "id": file_, "name": file_,
                    "inputs": [{"title": "body", "type": "string"}, {"title": "cinatra_run_id", "type": "string"}],
                    "outputs": [{"title": "artifactId", "type": "string"}]},
            end: {"component_type": "EndNode", "id": end, "name": end, "outputs": []},
        },
    }
    return doc


def test_a_step_that_is_its_own_filing_node():
    doc = _tiny()
    d = rs.derive_regenerate_segment(doc, "produce", "produce", "note")
    assert _control_chain(d["doc"]) == [(rs.SEGMENT_START_ID, "produce"), ("produce", rs.SEGMENT_END_ID)]
    assert d["note_source"] == "userNote"
    assert d["ports"] == [("produce", "topic")]
    assert [o["title"] for o in _refs(d["doc"])[rs.SEGMENT_END_ID]["outputs"]] == ["out"]


def test_ids_and_ports_with_a_colon_derive():
    doc = _tiny(ids=("s:0", "draft:flow", "write:draft", "e:0"), ports=("note:text", "a:b"))
    d = rs.derive_regenerate_segment(doc, "draft:flow", "write:draft", "note:text")
    assert d["ports"] == [("draft:flow", "a:b")]
    edges = _data_edges(d["doc"])
    assert (rs.SEGMENT_START_ID, "cinatra_seg_0", "draft:flow", "a:b") in edges
    assert (rs.SEGMENT_START_ID, rs.SEGMENT_NOTE_OUTPUT, "draft:flow", "note:text") in edges


def test_a_port_named_like_a_reserved_output_cannot_collide():
    doc = _tiny(ports=("note", "cinatra_seg_0"))
    d = rs.derive_regenerate_segment(doc, "produce", "file", "note")
    # The port keeps its own name as a destination; the start output is reserved.
    assert (rs.SEGMENT_START_ID, "cinatra_seg_0", "produce", "cinatra_seg_0") in _data_edges(d["doc"])


@pytest.mark.parametrize(
    "case",
    [
        "missing-node",
        "nested-node",
        "start-node",
        "duplicate-id",
        "reserved-id",
        "no-link",
        "no-note-edge",
        "two-note-edges",
        "note-not-from-start",
        "undeclared-port",
        "named-branch",
        "not-a-flow",
    ],
)
def test_each_refusal(case):
    doc = _tiny()
    step, node, note = "produce", "file", "note"
    refs = doc["$referenced_components"]
    if case == "missing-node":
        node = "nowhere"
    elif case == "nested-node":
        # A node that only a subflow holds is not top-level.
        refs["sub"] = {"component_type": "Flow", "id": "sub", "nodes": [{"$component_ref": "inner"}]}
        refs["inner"] = {"component_type": "ApiNode", "id": "inner", "inputs": []}
        node = "inner"
    elif case == "start-node":
        step = "start"
    elif case == "duplicate-id":
        refs["file"]["metadata"] = {"copy": {"component_type": "ApiNode", "id": "produce"}}
    elif case == "reserved-id":
        refs["end"]["id"] = rs.SEGMENT_END_ID
    elif case == "no-link":
        doc["data_flow_connections"] = [e for e in doc["data_flow_connections"] if e["id"] != "d2"]
    elif case == "no-note-edge":
        doc["data_flow_connections"] = [e for e in doc["data_flow_connections"] if e["id"] != "d1"]
    elif case == "two-note-edges":
        twin = copy.deepcopy(doc["data_flow_connections"][0])
        twin["id"] = "d1b"
        doc["data_flow_connections"].append(twin)
    elif case == "note-not-from-start":
        doc["data_flow_connections"][0]["source_node"] = {"$component_ref": "file"}
    elif case == "undeclared-port":
        doc["data_flow_connections"].append(
            {"component_type": "DataFlowEdge", "id": "d9", "source_node": {"$component_ref": "start"},
             "source_output": "userNote", "destination_node": {"$component_ref": "file"},
             "destination_input": "ghost"}
        )
    elif case == "named-branch":
        doc["control_flow_connections"][1]["from_branch"] = "failure"
    elif case == "not-a-flow":
        doc["component_type"] = "Agent"
    with pytest.raises(rs.RegenerateSegmentError) as excinfo:
        rs.derive_regenerate_segment(doc, step, node, note)
    assert _code(excinfo) == rs.REGENERATE_SEGMENT_INVALID


# --------------------------------------------------------------------- T10


def _repeated_step_doc():
    doc = _tiny(ports=("textNote", "imageNote"))
    refs = doc["$referenced_components"]
    refs["start"]["inputs"].append({"title": "imageAsk", "type": "string"})
    doc["inputs"].append({"title": "imageAsk", "type": "string"})
    doc["data_flow_connections"].append(
        {"component_type": "DataFlowEdge", "id": "d4", "source_node": {"$component_ref": "start"},
         "source_output": "imageAsk", "destination_node": {"$component_ref": "produce"},
         "destination_input": "imageNote"}
    )
    # A second filing node fed by the same step.
    refs["file2"] = {"component_type": "ApiNode", "id": "file2", "name": "file2",
                     "inputs": [{"title": "body", "type": "string"}],
                     "outputs": [{"title": "artifactId", "type": "string"}]}
    doc["nodes"].insert(3, {"$component_ref": "file2"})
    doc["data_flow_connections"].append(
        {"component_type": "DataFlowEdge", "id": "d5", "source_node": {"$component_ref": "produce"},
         "source_output": "out", "destination_node": {"$component_ref": "file2"}, "destination_input": "body"}
    )
    return doc


def _request(step, node, note, snapshots, flow=FLOW, start="userNote"):
    return {
        "step": step,
        "artifactNode": node,
        "noteInput": note,
        "noteStartOutput": start,
        "flowSha256": flow,
        "snapshots": [
            {"node": n, "inputs_json": s, "sha256": hashlib.sha256(s.encode("utf-8")).hexdigest()}
            for n, s in snapshots.items()
        ],
    }


def test_a_repeated_step_replaces_only_its_own_note_port():
    doc = _repeated_step_doc()
    produce = json.dumps({"textNote": "old text note", "imageNote": "old image note"}, sort_keys=True)
    snaps = {"produce": produce, "file": "{}", "file2": "{}"}
    message = {"userNote": "NEW TEXT", "imageAsk": "NEW IMAGE", "cinatra_run_id": "run-seg"}

    text = rs.prepare_segment_run(
        _request("produce", "file", "textNote", snaps), mounted_flow_sha256=FLOW, working_doc=doc, message_inputs=message
    )
    image = rs.prepare_segment_run(
        _request("produce", "file2", "imageNote", snaps, start="imageAsk"), mounted_flow_sha256=FLOW, working_doc=doc, message_inputs=message
    )
    (_, text_inputs), (image_derivation, image_inputs) = text, image
    assert text_inputs[rs.SEGMENT_NOTE_OUTPUT] == "NEW TEXT"
    assert text_inputs["cinatra_seg_0"] == "old image note"  # (produce, imageNote) keeps the snapshot
    assert image_derivation["note_source"] == "imageAsk"
    assert image_inputs[rs.SEGMENT_NOTE_OUTPUT] == "NEW IMAGE"
    assert image_inputs["cinatra_seg_0"] == "old text note"  # (produce, textNote) keeps the snapshot


# --------------------------------------------------------------------- T11


def test_a_changed_flow_refuses_before_anything_else_is_read():
    request = _request("produce", "file", "note", {"produce": "not even json"})
    with pytest.raises(rs.RegenerateSegmentError) as excinfo:
        # No document, a broken snapshot and no inputs: the version is checked first.
        rs.prepare_segment_run(request, mounted_flow_sha256="e" * 64, working_doc=None, message_inputs=None)
    assert _code(excinfo) == rs.REGENERATE_FLOW_CHANGED


def test_snapshot_bytes_are_re_verified():
    request = _request("produce", "file", "note", {"produce": '{"topic":"t"}', "file": "{}"})
    request["snapshots"][0]["inputs_json"] = '{"topic":"T"}'
    with pytest.raises(rs.RegenerateSegmentError) as excinfo:
        rs.prepare_segment_run(request, mounted_flow_sha256=FLOW, working_doc=_tiny(), message_inputs={})
    assert _code(excinfo) == rs.REGENERATE_SEGMENT_INVALID


@pytest.mark.parametrize("missing", ["snapshot-value", "snapshot-node", "note", "run-id"])
def test_a_missing_value_refuses(missing):
    snaps = {"produce": json.dumps({"topic": "kept", "note": "old"}), "file": "{}"}
    message = {"userNote": "new", "cinatra_run_id": "run-seg"}
    if missing == "snapshot-value":
        snaps["produce"] = json.dumps({"note": "old"})
    elif missing == "snapshot-node":
        del snaps["produce"]
    elif missing == "note":
        del message["userNote"]
    elif missing == "run-id":
        del message["cinatra_run_id"]
    with pytest.raises(rs.RegenerateSegmentError) as excinfo:
        rs.prepare_segment_run(
            _request("produce", "file", "note", snaps), mounted_flow_sha256=FLOW, working_doc=_tiny(), message_inputs=message
        )
    assert _code(excinfo) == rs.REGENERATE_SEGMENT_INVALID


def test_the_segment_inputs_of_a_good_request():
    snaps = {"produce": json.dumps({"topic": "kept", "note": "old"}), "file": json.dumps({"body": "x"})}
    derivation, inputs = rs.prepare_segment_run(
        _request("produce", "file", "note", snaps),
        mounted_flow_sha256=FLOW,
        working_doc=_tiny(),
        message_inputs={"userNote": "new", "cinatra_run_id": "run-seg", "lifecycleRepairRequest": {}},
    )
    assert inputs == {rs.SEGMENT_NOTE_OUTPUT: "new", "cinatra_seg_0": "kept", "cinatra_run_id": "run-seg"}
    assert set(inputs) == {i["title"] for i in derivation["doc"]["inputs"]}


@pytest.mark.parametrize(
    "metadata",
    [
        {rs.REGENERATE_SEGMENT_METADATA_KEY: "x"},
        {rs.REGENERATE_SEGMENT_METADATA_KEY: {"step": "a", "artifactNode": "b", "noteInput": "n", "flowSha256": "zz", "snapshots": []}},
        {rs.REGENERATE_SEGMENT_METADATA_KEY: {"step": "a", "artifactNode": "b", "noteInput": "n", "flowSha256": FLOW, "snapshots": []}},
        {rs.REGENERATE_SEGMENT_METADATA_KEY: {"step": "", "artifactNode": "b", "noteInput": "n", "noteStartOutput": "n",
                                              "flowSha256": FLOW,
                                              "snapshots": [{"node": "a", "inputs_json": "{}", "sha256": FLOW}]}},
        # The carried start output name of the note (App1 ruling on B1b): absent or empty refuses.
        {rs.REGENERATE_SEGMENT_METADATA_KEY: {"step": "a", "artifactNode": "b", "noteInput": "n", "flowSha256": FLOW,
                                              "snapshots": [{"node": "a", "inputs_json": "{}", "sha256": FLOW}]}},
        {rs.REGENERATE_SEGMENT_METADATA_KEY: {"step": "a", "artifactNode": "b", "noteInput": "n", "noteStartOutput": "",
                                              "flowSha256": FLOW,
                                              "snapshots": [{"node": "a", "inputs_json": "{}", "sha256": FLOW}]}},
        {rs.REGENERATE_SEGMENT_METADATA_KEY: {"step": "a", "artifactNode": "b", "noteInput": "n", "noteStartOutput": 3,
                                              "flowSha256": FLOW,
                                              "snapshots": [{"node": "a", "inputs_json": "{}", "sha256": FLOW}]}},
    ],
)
def test_a_malformed_request_refuses_and_an_absent_one_is_an_ordinary_run(metadata):
    with pytest.raises(rs.RegenerateSegmentError):
        rs.read_segment_request({"metadata": metadata})
    assert rs.read_segment_request({"metadata": {}}) is None
    assert rs.read_segment_request({}) is None


# --------------------------------------------------------------------- T12


def test_health_lists_the_capability():
    assert rs.REGENERATE_SEGMENT_CAPABILITY == "regenerate_segment/1"
    assert rs.REGENERATE_SEGMENT_CAPABILITY in rs.RUNTIME_CAPABILITIES
    health = LOADER_SOURCE[LOADER_SOURCE.index("    def health(self)"):]
    health = health[: health.index("\n    def ", 10)]
    assert '"capabilities": list(_regenerate_segment.RUNTIME_CAPABILITIES)' in health


@pytest.mark.parametrize("vector", RECEIPTS["vectors"], ids=lambda v: v["name"])
def test_receipt_vectors(vector):
    key = RECEIPTS["key"]
    material = f"g1\n{vector['run_id']}\n{vector['step']}\n{vector['artifactNode']}\n{vector['flowSha256']}"
    expected = "g1:" + hmac.new(key.encode("utf-8"), material.encode("utf-8"), hashlib.sha256).hexdigest()
    assert vector["attestation"] == expected
    assert rs.segment_receipt_attestation(
        key, vector["run_id"], vector["step"], vector["artifactNode"], vector["flowSha256"]
    ) == expected
    request = {"step": vector["step"], "artifactNode": vector["artifactNode"], "flowSha256": vector["flowSha256"]}
    assert rs.segment_receipt(key, vector["run_id"], request) == {**request, "attestation": expected}


def test_no_key_or_run_gives_no_receipt_and_the_receipt_rides_the_last_message():
    request = {"step": "a", "artifactNode": "b", "flowSha256": FLOW}
    assert rs.segment_receipt("", "run", request) is None
    assert rs.segment_receipt("k", None, request) is None
    messages = [{"role": "agent", "metadata": {"other": 1}}]
    receipt = rs.segment_receipt("k", "run", request)
    rs.attach_segment_receipt(messages, receipt, "task-1")
    assert messages[-1]["metadata"] == {"other": 1, rs.SEGMENT_RECEIPT_METADATA_KEY: receipt}
    empty: list = []
    rs.attach_segment_receipt(empty, receipt, "task-2")
    assert empty[0]["message_id"].startswith(rs.SEGMENT_RECEIPT_CARRIER_PREFIX)
    assert rs.attach_segment_receipt([{"role": "agent"}], None, "t") == [{"role": "agent"}]


# ----------------------------------------------------- the loader's wiring


def _function_source(name):
    start = LOADER_SOURCE.index(f"def {name}(")
    following = re.compile(r"\n(?:    )?(?:async )?def ").search(LOADER_SOURCE, start + 10)
    return LOADER_SOURCE[start: following.start() if following else len(LOADER_SOURCE)]


def test_the_loader_branches_before_any_conversation_and_signs_only_a_finished_segment():
    body = _function_source("_patched_run_task")
    read = body.index("_regenerate_segment.read_segment_request(")
    start = body.index("_start_segment_conversation(")
    stored = body.index("load_task_conversation(")
    assert read < start < stored
    # A segment never falls through to the whole flow's start_conversation.
    assert "needs_new_conv = _segment_request is None and (" in body
    receipt = body.index("_regenerate_segment.attach_segment_receipt(")
    assert body.rfind("isinstance(status, FinishedStatus)", 0, receipt) > body.index("elif isinstance(status, FinishedStatus):")
    helper = _function_source("_start_segment_conversation")
    assert helper.index("prepare_segment_run(") < helper.index("load_json(") < helper.index("start_conversation(")
    mount = _function_source("_mount_one_sync")
    assert '"_cinatra_working_doc"' in mount and '"_cinatra_spec_loader"' in mount


# ------------------------------------------- the carried note start output


def test_the_request_carries_the_note_start_output():
    request = rs.read_segment_request({"metadata": {rs.REGENERATE_SEGMENT_METADATA_KEY: _request(
        "produce", "file", "note", {"produce": "{}"}, start="userNote")}})
    assert request["noteStartOutput"] == "userNote"


def test_the_note_is_read_under_the_carried_name():
    snaps = {"produce": json.dumps({"topic": "kept", "note": "old"}), "file": json.dumps({"body": "x"})}
    # The step's note input is "note"; the start output that feeds it is "userNote".
    _derivation, inputs = rs.prepare_segment_run(
        _request("produce", "file", "note", snaps, start="userNote"),
        mounted_flow_sha256=FLOW,
        working_doc=_tiny(),
        message_inputs={"userNote": "new", "note": "not this", "cinatra_run_id": "run-seg"},
    )
    assert inputs[rs.SEGMENT_NOTE_OUTPUT] == "new"


@pytest.mark.parametrize("start", ["nope", "note", "cinatra_run_id"])
def test_a_carried_name_that_does_not_feed_the_note_refuses_before_any_step(start):
    # "nope" and "note": the mounted start node has no such output.
    # "cinatra_run_id": a start output, but not the one that feeds the note.
    snaps = {"produce": json.dumps({"topic": "kept", "note": "old"}), "file": "{}"}
    message = {"userNote": "new", "note": "new", "nope": "new", "cinatra_run_id": "run-seg"}
    with pytest.raises(rs.RegenerateSegmentError) as excinfo:
        rs.prepare_segment_run(
            _request("produce", "file", "note", snaps, start=start),
            mounted_flow_sha256=FLOW,
            working_doc=_tiny(),
            message_inputs=message,
        )
    assert _code(excinfo) == rs.REGENERATE_SEGMENT_INVALID


# ------------------------------------- pre-review fold: platform-owned names


#: The names the platform owns in the start message: the run id and its
#: loader alias, the per-run token key, and the typed repair request.
PLATFORM_OWNED = ["cinatra_run_id", "agent_run_id", "__cinatra_run_token__", "lifecycleRepairRequest"]


def _fed_by(name):
    """_tiny with the start output ``name`` (not userNote) feeding the note."""
    doc = _tiny()
    start = doc["$referenced_components"]["start"]
    if name not in [d["title"] for d in start["inputs"]]:
        start["inputs"].append({"title": name, "type": "string"})
        doc["inputs"].append({"title": name, "type": "string"})
    doc["data_flow_connections"][0]["source_output"] = name
    return doc


@pytest.mark.parametrize("name", PLATFORM_OWNED)
def test_a_platform_owned_start_output_never_carries_the_note(name):
    snaps = {"produce": json.dumps({"topic": "kept", "note": "old"}), "file": json.dumps({"body": "x"})}
    request = _request("produce", "file", "note", snaps, start=name)
    with pytest.raises(rs.RegenerateSegmentError) as excinfo:
        rs.read_segment_request({"metadata": {rs.REGENERATE_SEGMENT_METADATA_KEY: request}})
    assert _code(excinfo) == rs.REGENERATE_SEGMENT_INVALID
    with pytest.raises(rs.RegenerateSegmentError) as excinfo:
        rs.prepare_segment_run(
            request,
            mounted_flow_sha256=FLOW,
            working_doc=_fed_by(name),
            message_inputs={name: "the note", "cinatra_run_id": "run-seg", "agent_run_id": "run-seg"},
        )
    assert _code(excinfo) == rs.REGENERATE_SEGMENT_INVALID


def test_the_platform_owned_names_match_the_application():
    assert set(rs.PLATFORM_OWNED_INPUT_NAMES) == set(PLATFORM_OWNED)
    assert rs.PLATFORM_PORT_KEYS <= set(rs.PLATFORM_OWNED_INPUT_NAMES)
    shared = (HERE.parents[2] / "scripts" / "extensions" / "platform-supplied-flow-inputs.mjs").read_text(encoding="utf-8")
    for name in ("cinatra_run_id", "agent_run_id", "__cinatra_run_token__"):
        assert f'"{name}"' in shared


# ------------------------------------------- pre-review fold: no pause/resume


def test_a_segment_that_stops_for_input_refuses():
    rs.require_segment_finished(True)
    with pytest.raises(rs.RegenerateSegmentError) as excinfo:
        rs.require_segment_finished(False)
    assert _code(excinfo) == rs.REGENERATE_SEGMENT_PAUSED


def test_the_loader_fails_a_segment_that_did_not_finish_before_its_outcome_is_stored():
    # The task's submitted and working states are stored before the run; what
    # the guard precedes is the outcome: no input-required state and no
    # conversation of a segment is ever stored.
    body = _function_source("_patched_run_task")
    executed = body.index("status = await conversation.execute_async()")
    guard = body.index("_regenerate_segment.require_segment_finished(isinstance(status, FinishedStatus))")
    paused = body.index('task_state = "input-required"')
    stored = body.index("await _regenerate_segment.store_task_outcome(")
    assert executed < guard < paused < stored
    assert body.rfind("if _segment_request is not None:", 0, guard) > executed


# ------------------------------ pre-review fold: no snapshot value in history


def _segment_message():
    snaps = {"produce": json.dumps({"topic": "a private draft"}), "file": json.dumps({"body": "x"})}
    return {
        "kind": "message",
        "role": "user",
        "parts": [{"kind": "text", "text": "{}"}],
        "metadata": {
            rs.REGENERATE_SEGMENT_METADATA_KEY: _request("produce", "file", "note", snaps),
            "other": 1,
        },
    }


def test_the_stored_message_keeps_no_snapshot_value():
    original = _segment_message()
    before = copy.deepcopy(original)
    stored = rs.redact_segment_request(original)
    assert original == before  # the worker still reads the full request
    assert stored is not original and stored["parts"] is not original["parts"]
    request = stored["metadata"][rs.REGENERATE_SEGMENT_METADATA_KEY]
    assert request["snapshots"] == [
        {"node": s["node"], "sha256": s["sha256"]} for s in before["metadata"][rs.REGENERATE_SEGMENT_METADATA_KEY]["snapshots"]
    ]
    assert "a private draft" not in json.dumps(stored)
    assert request["step"] == "produce" and request["flowSha256"] == FLOW
    assert stored["metadata"]["other"] == 1
    plain = {"role": "user", "metadata": {"other": 1}}
    assert rs.redact_segment_request(plain) is plain
    assert rs.redact_segment_request(None) is None


def test_the_loader_stores_and_converses_only_the_redacted_request():
    scrub = _function_source("_scrub_run_token_from_message_for_storage")
    assert "_regenerate_segment.redact_segment_request(" in scrub
    body = _function_source("_patched_run_task")
    started = body.index("_start_segment_conversation(")
    redacted = body.index('params["message"] = _regenerate_segment.redact_segment_request(params.get("message"))')
    appended = body.index("conversation.append_message(wayflow_input_message)")
    assert started < redacted < appended


# ------------------ pre-review fold 2: no snapshot value in the conversation


class _RecordingStorage:
    """Records every call the task's outcome makes on the A2A storage."""

    def __init__(self):
        self.calls = []

    async def update_task(self, task_id, **kwargs):
        self.calls.append(("update_task", task_id, kwargs))

    async def update_task_conversation(self, **kwargs):
        self.calls.append(("update_task_conversation", kwargs))


class _Conversation:
    """Stands in for the segment's conversation: it holds the start inputs the
    segment was started with, as the runtime's conversation state does."""

    def __init__(self, inputs):
        self.inputs = inputs
        self.message_list = [{"role": "user", "content": json.dumps(inputs)}]


def _stored_form(value):
    """Everything the storage was handed, serialized the way a store would."""
    return json.dumps(value, default=lambda o: vars(o) if hasattr(o, "__dict__") else repr(o), sort_keys=True)


def _segment_inputs():
    snaps = {"produce": json.dumps({"topic": "a private draft", "note": "old"}), "file": json.dumps({"body": "x"})}
    _derivation, inputs = rs.prepare_segment_run(
        _request("produce", "file", "note", snaps),
        mounted_flow_sha256=FLOW,
        working_doc=_tiny(),
        message_inputs={"userNote": "new", "cinatra_run_id": "run-seg"},
    )
    return inputs


def test_the_segment_start_inputs_carry_the_snapshot_value():
    # The premise of the next test: the segment's conversation is started with
    # the snapshot value as a start input.
    assert "a private draft" in json.dumps(_segment_inputs())


def test_a_finished_segment_stores_its_outcome_but_never_its_conversation():
    import asyncio

    task = {"id": "task-seg", "context_id": "ctx-seg"}
    messages = [{"kind": "message", "role": "agent", "parts": [{"kind": "text", "text": "done"}]}]

    segment = _RecordingStorage()
    asyncio.run(rs.store_task_outcome(
        segment, task, state="completed", new_messages=messages,
        conversation=_Conversation(_segment_inputs()), segment=True,
    ))
    assert [c[0] for c in segment.calls] == ["update_task"]
    assert segment.calls[0][1] == "task-seg"
    assert segment.calls[0][2] == {"state": "completed", "new_messages": messages}
    assert "a private draft" not in _stored_form(segment.calls)

    # An ordinary leg stores its conversation as before (and the stored form
    # would show the value if a segment's conversation were stored).
    ordinary = _RecordingStorage()
    conversation = _Conversation(_segment_inputs())
    asyncio.run(rs.store_task_outcome(
        ordinary, task, state="input-required", new_messages=messages,
        conversation=conversation, segment=False,
    ))
    assert [c[0] for c in ordinary.calls] == ["update_task", "update_task_conversation"]
    assert ordinary.calls[1][1] == {"context_id": "ctx-seg", "task_id": "task-seg", "conv": conversation}
    assert ordinary.calls[1][1]["conv"] is conversation
    assert "a private draft" in _stored_form(ordinary.calls)


def test_the_loader_stores_every_outcome_through_the_one_helper():
    body = _function_source("_patched_run_task")
    assert "update_task_conversation" not in body
    call = body.index("await _regenerate_segment.store_task_outcome(")
    assert body.index("segment=_segment_request is not None", call) > call
    assert body.index("conversation=conversation", call) > call
