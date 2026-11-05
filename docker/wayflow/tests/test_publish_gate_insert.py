"""cinatra#4150 PR 4: the flow runtime stops in front of a declared publishing step.

A pack marks the node that publishes with ``metadata.cinatra.publishes: true``.
Before the runtime validates the graph, ``agent_loader._insert_publish_gates``
puts ONE host-owned ``InputMessageNode`` with the fixed id
``cinatra_publish_gate__<node>`` in front of each such node:

  - every control edge into the node is redirected to the gate, and one control
    edge goes from the gate to the node;
  - each data edge into the node gets a twin from the same source output into a
    same-named input of the gate, and the gate opts into value surfacing, so the
    pause carries exactly the values handed to the node (they are not proof of
    what goes out: the node itself still makes the publishing call);
  - the gate has one string output that nothing consumes.

The flag may only ADD a stop. Anything else that carries the key refuses the
load (that version does not mount; on a reload the version mounted before keeps
serving): a value that is not a JSON boolean, ``true`` on a node that cannot be
the publishing action or that is not a top-level node of the root flow, a pack
id that takes the reserved prefix, a publishing node with no incoming control
edge or with no data edge in, an edge or a reference the pass cannot rewrite,
and an input the gate could not surface.

The pure pass needs no wayflowcore. The load and run cases (A2) run only where
the pinned runtime is installed (inside the wayflow image).

Run (inside the wayflow image): python -m pytest -q tests/test_publish_gate_insert.py
"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest

import agent_loader  # type: ignore[import-not-found]

try:
    from wayflowcore.agentspec import AgentSpecLoader  # type: ignore[import-not-found]
    from wayflowcore.executors.executionstatus import (  # type: ignore[import-not-found]
        UserMessageRequestStatus,
    )
except Exception:  # pragma: no cover — runs only where wayflowcore is installed
    AgentSpecLoader = None  # type: ignore[assignment]
    UserMessageRequestStatus = None  # type: ignore[assignment]

PREFIX = "cinatra_publish_gate__"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "publish_gate_parity.json"
PARITY = json.loads(FIXTURE.read_text(encoding="utf-8"))
FLOWS = {f["name"]: f for f in PARITY["flows"]}


def _flow(name: str) -> dict:
    return copy.deepcopy(FLOWS[name]["flow"])


def _ref(edge_end: dict) -> str:
    return edge_end["$component_ref"]


def _cf_into(doc: dict, node: str) -> list:
    return [e for e in doc["control_flow_connections"] if _ref(e["to_node"]) == node]


def _df_into(doc: dict, node: str) -> list:
    return [e for e in doc["data_flow_connections"] if _ref(e["destination_node"]) == node]


def _node(cid: str, kind: str, cinatra: dict | None = None, **extra) -> dict:
    node = {"component_type": kind, "id": cid, "name": cid, **extra}
    if cinatra is not None:
        node["metadata"] = {"cinatra": cinatra}
    return node


def _branching_flow() -> dict:
    """start -> check; check's branch "go" -> publish, its branch "again" -> fix;
    fix -> publish; publish -> retry; retry's branch "retry" -> publish, its
    branch "done" -> end. The publishing node has three control edges in: a
    branch edge, a plain edge and a loop back. Two data edges feed its one
    input `body`."""
    nodes = [
        _node("start", "StartNode", inputs=[{"title": "body", "type": "string"}]),
        _node("check", "BranchingNode"),
        _node("fix", "ApiNode", {"riskClass": "read_only"}),
        _node("publish", "ApiNode", {"riskClass": "write", "publishes": True},
              inputs=[{"title": "body", "type": "string", "description": "the text"}]),
        _node("retry", "BranchingNode"),
        _node("end", "EndNode", outputs=[]),
    ]
    cf = [
        ("start", "check", None, "s_c"),
        ("check", "publish", "go", "c_p"),
        ("check", "fix", "again", "c_f"),
        ("fix", "publish", None, "f_p"),
        ("publish", "retry", None, "p_r"),
        ("retry", "publish", "retry", "r_p"),
        ("retry", "end", "done", "r_e"),
    ]
    return {
        "component_type": "Flow",
        "id": "branching",
        "name": "branching",
        "start_node": {"$component_ref": "start"},
        "nodes": [{"$component_ref": n["id"]} for n in nodes],
        "control_flow_connections": [
            {"component_type": "ControlFlowEdge", "name": name,
             "from_node": {"$component_ref": a}, "to_node": {"$component_ref": b},
             **({"from_branch": br} if br else {})}
            for a, b, br, name in cf
        ],
        "data_flow_connections": [
            {"component_type": "DataFlowEdge", "name": "s_body_p",
             "source_node": {"$component_ref": "start"}, "source_output": "body",
             "destination_node": {"$component_ref": "publish"}, "destination_input": "body"},
            {"component_type": "DataFlowEdge", "name": "f_body_p",
             "source_node": {"$component_ref": "fix"}, "source_output": "fixed",
             "destination_node": {"$component_ref": "publish"}, "destination_input": "body"},
        ],
        "$referenced_components": {n["id"]: n for n in nodes},
    }


# --- A1: one gate in front of each publishing node ---------------------------------------------------------------


def test_the_loader_prefix_is_the_fixture_prefix():
    assert agent_loader.PUBLISH_GATE_ID_PREFIX == PARITY["gatePrefix"] == PREFIX


@pytest.mark.parametrize("name", sorted(FLOWS))
def test_inserted_gate_ids_equal_the_fixture_publishing_steps(name):
    """A3, the loader half: the gates inserted are gatePrefix + each step the
    host compiler lists (the host half reads the same fixture)."""
    doc = _flow(name)
    report = agent_loader._insert_publish_gates(doc, name)
    expected = [PARITY["gatePrefix"] + s for s in FLOWS[name]["publishingSteps"]]
    assert [r["gate"] for r in report] == expected
    assert [r["node"] for r in report] == FLOWS[name]["publishingSteps"]
    refs = doc["$referenced_components"]
    assert sorted(k for k in refs if k.startswith(PREFIX)) == sorted(expected)


def test_the_gate_is_a_value_surfacing_input_message_node_in_front_of_the_node():
    doc = _flow("wordpress-publish-shape")
    agent_loader._insert_publish_gates(doc, "wp")
    gid = PREFIX + "publish"
    gate = doc["$referenced_components"][gid]
    assert gate["component_type"] == "InputMessageNode"
    assert gate["id"] == gid and gate["name"] == gid
    assert gate["metadata"]["cinatra"]["surfaceGateInputs"] is True
    assert len(gate["outputs"]) == 1 and gate["outputs"][0]["type"] == "string"
    order = [_ref(n) for n in doc["nodes"]]
    assert order.index(gid) == order.index("publish") - 1
    # Nothing consumes the gate's output.
    assert not [e for e in doc["data_flow_connections"] if _ref(e["source_node"]) == gid]


def test_every_control_edge_into_the_node_passes_through_the_gate():
    doc = _branching_flow()
    before = {e["name"]: e for e in copy.deepcopy(doc["control_flow_connections"])}
    report = agent_loader._insert_publish_gates(doc, "branching")
    gid = PREFIX + "publish"
    assert report[0]["controlEdges"] == 3
    into_publish = _cf_into(doc, "publish")
    assert len(into_publish) == 1 and _ref(into_publish[0]["from_node"]) == gid
    assert not into_publish[0].get("from_branch")
    into_gate = {e["name"]: e for e in _cf_into(doc, gid)}
    assert sorted(into_gate) == ["c_p", "f_p", "r_p"]
    for name, edge in into_gate.items():
        # Same edge, same source and branch; only the destination moved.
        assert _ref(edge["from_node"]) == _ref(before[name]["from_node"])
        assert edge.get("from_branch") == before[name].get("from_branch")
    # Edges that did not end at the publishing node are untouched.
    for name in ("s_c", "c_f", "p_r", "r_e"):
        assert next(e for e in doc["control_flow_connections"] if e["name"] == name) == before[name]


def test_the_gate_surfaces_exactly_the_values_handed_to_the_node():
    doc = _flow("linkedin-publish-shape")
    original_into_publish = copy.deepcopy(_df_into(doc, "publish"))
    report = agent_loader._insert_publish_gates(doc, "li")
    gid = PREFIX + "publish"
    # The publishing node keeps its own data edges unchanged.
    assert _df_into(doc, "publish") == original_into_publish
    twins = _df_into(doc, gid)
    key = lambda e: (_ref(e["source_node"]), e["source_output"], e["destination_input"])  # noqa: E731
    assert sorted(map(key, twins)) == sorted(map(key, original_into_publish))
    titles = [e["destination_input"] for e in original_into_publish]
    gate = doc["$referenced_components"][gid]
    assert [i["title"] for i in gate["inputs"]] == titles
    assert report[0]["inputs"] == titles
    assert len(titles) == 11


def test_two_data_edges_into_one_input_give_one_gate_input_and_two_twins():
    doc = _branching_flow()
    agent_loader._insert_publish_gates(doc, "branching")
    gid = PREFIX + "publish"
    gate = doc["$referenced_components"][gid]
    # The declared descriptor of the node's input is copied.
    assert gate["inputs"] == [{"title": "body", "type": "string", "description": "the text"}]
    assert sorted(_ref(e["source_node"]) for e in _df_into(doc, gid)) == ["fix", "start"]


def test_a_publishing_node_first_after_start_and_a_second_one_each_get_a_gate():
    doc = _flow("two-publishing-steps")
    agent_loader._insert_publish_gates(doc, "two")
    first, second = PREFIX + "announce", PREFIX + "post"
    assert [_ref(e["from_node"]) for e in _cf_into(doc, first)] == ["start"]
    assert [_ref(e["from_node"]) for e in _cf_into(doc, "announce")] == [first]
    assert [_ref(e["from_node"]) for e in _cf_into(doc, second)] == ["between"]
    assert [_ref(e["from_node"]) for e in _cf_into(doc, "post")] == [second]


def test_an_input_the_node_does_not_declare_gets_a_plain_string_input_on_the_gate():
    doc = _branching_flow()
    doc["data_flow_connections"].append(
        {"component_type": "DataFlowEdge", "name": "s_extra_p",
         "source_node": {"$component_ref": "start"}, "source_output": "body",
         "destination_node": {"$component_ref": "publish"}, "destination_input": "extra"}
    )
    agent_loader._insert_publish_gates(doc, "branching")
    gate = doc["$referenced_components"][PREFIX + "publish"]
    assert gate["inputs"][1] == {"title": "extra", "type": "string"}


def test_two_identical_data_edges_give_one_twin():
    doc = _branching_flow()
    twin_of_start = dict(doc["data_flow_connections"][0], name="s_body_p_again")
    doc["data_flow_connections"].append(twin_of_start)
    agent_loader._insert_publish_gates(doc, "branching")
    assert sorted(_ref(e["source_node"]) for e in _df_into(doc, PREFIX + "publish")) == ["fix", "start"]


def test_a_self_loop_on_the_node_passes_through_the_gate():
    doc = _branching_flow()
    doc["control_flow_connections"].append(
        {"component_type": "ControlFlowEdge", "name": "p_p",
         "from_node": {"$component_ref": "publish"}, "to_node": {"$component_ref": "publish"}}
    )
    report = agent_loader._insert_publish_gates(doc, "branching")
    gid = PREFIX + "publish"
    assert report[0]["controlEdges"] == 4
    assert [_ref(e["from_node"]) for e in _cf_into(doc, "publish")] == [gid]
    loop = next(e for e in doc["control_flow_connections"] if e["name"] == "p_p")
    assert _ref(loop["from_node"]) == "publish" and _ref(loop["to_node"]) == gid


def test_a_second_run_on_the_same_document_refuses():
    """The pass is not idempotent, by design: its own gate is indistinguishable
    from a pack node that takes the reserved prefix."""
    doc = _flow("wordpress-publish-shape")
    agent_loader._insert_publish_gates(doc, "wp")
    with pytest.raises(agent_loader.PublishGateError, match="RESERVED_NODE_ID"):
        agent_loader._insert_publish_gates(doc, "wp")


def test_a_document_that_is_not_an_object_is_returned_untouched():
    for doc in ([], "flow", None, 3):
        assert agent_loader._insert_publish_gates(doc, "odd") == []


def test_a_flow_with_no_declaration_is_untouched():
    doc = _flow("wordpress-publish-shape")
    doc["$referenced_components"]["publish"]["metadata"]["cinatra"].pop("publishes")
    before = copy.deepcopy(doc)
    assert agent_loader._insert_publish_gates(doc, "wp") == []
    assert doc == before


def test_an_explicit_false_adds_no_gate():
    doc = _flow("wordpress-publish-shape")
    report = agent_loader._insert_publish_gates(doc, "wp")
    assert [r["node"] for r in report] == ["publish"]
    assert PREFIX + "write_address" not in doc["$referenced_components"]


# --- the refusals: each ends the load, so that version does not mount ---------------------------------------------


def _refused(doc: dict) -> str:
    with pytest.raises(agent_loader.PublishGateError) as exc:
        agent_loader._insert_publish_gates(doc, "refusal")
    return str(exc.value)


@pytest.mark.parametrize("value", ["true", 1, 0, None, {}, [True], "false"])
def test_a_malformed_flag_refuses(value):
    doc = _flow("wordpress-publish-shape")
    doc["$referenced_components"]["publish"]["metadata"]["cinatra"]["publishes"] = value
    assert "PUBLISHES_MALFORMED" in _refused(doc)


def test_a_malformed_flag_on_a_node_that_does_not_publish_refuses_too():
    doc = _flow("wordpress-publish-shape")
    doc["$referenced_components"]["write_address"]["metadata"]["cinatra"]["publishes"] = "no"
    assert "PUBLISHES_MALFORMED" in _refused(doc)


@pytest.mark.parametrize(
    "kind", ["StartNode", "EndNode", "InputMessageNode", "OutputMessageNode", "BranchingNode", "SomethingNew", None]
)
def test_true_on_a_node_that_cannot_be_the_publishing_action_refuses(kind):
    doc = _flow("wordpress-publish-shape")
    node = doc["$referenced_components"]["publish"]
    if kind is None:
        node.pop("component_type")
    else:
        node["component_type"] = kind
    assert "PUBLISHES_MISPLACED" in _refused(doc)


def test_true_on_the_flow_root_refuses():
    doc = _flow("wordpress-publish-shape")
    doc["metadata"]["cinatra"]["publishes"] = True
    doc["$referenced_components"]["publish"]["metadata"]["cinatra"].pop("publishes")
    assert "PUBLISHES_MISPLACED" in _refused(doc)


def test_true_inside_a_nested_subflow_refuses():
    doc = _flow("wordpress-publish-shape")
    doc["$referenced_components"]["publish"]["metadata"]["cinatra"].pop("publishes")
    inner = _flow("two-publishing-steps")
    inner["id"] = inner["name"] = "inner_flow"
    doc["$referenced_components"]["inner_flow"] = inner
    assert "PUBLISHES_MISPLACED" in _refused(doc)


def test_true_on_a_root_component_that_is_not_a_listed_node_refuses():
    doc = _flow("wordpress-publish-shape")
    doc["nodes"] = [n for n in doc["nodes"] if _ref(n) != "publish"]
    assert "PUBLISHES_MISPLACED" in _refused(doc)


@pytest.mark.parametrize("where", ["top-level key", "nested id", "listed node ref"])
def test_a_pack_id_with_the_reserved_prefix_refuses(where):
    doc = _flow("wordpress-publish-shape")
    if where == "top-level key":
        doc["$referenced_components"][PREFIX + "x"] = _node(PREFIX + "x", "ApiNode")
    elif where == "nested id":
        inner = _flow("two-publishing-steps")
        for n in inner["$referenced_components"].values():
            n.get("metadata", {}).get("cinatra", {}).pop("publishes", None)
        inner["$referenced_components"]["between"]["id"] = PREFIX + "between"
        doc["$referenced_components"]["inner_flow"] = inner
    else:
        doc["nodes"].append({"$component_ref": PREFIX + "y"})
    assert "RESERVED_NODE_ID" in _refused(doc)


def test_the_reserved_prefix_refuses_even_when_nothing_is_declared():
    doc = _flow("wordpress-publish-shape")
    doc["$referenced_components"]["publish"]["metadata"]["cinatra"].pop("publishes")
    doc["$referenced_components"][PREFIX + "x"] = _node(PREFIX + "x", "ApiNode")
    assert "RESERVED_NODE_ID" in _refused(doc)


def test_a_publishing_node_with_no_incoming_control_edge_refuses():
    doc = _flow("wordpress-publish-shape")
    doc["control_flow_connections"] = [
        e for e in doc["control_flow_connections"] if _ref(e["to_node"]) != "publish"
    ]
    assert "PUBLISH_GATE_NO_ENTRY" in _refused(doc)


def test_a_flow_with_no_control_edges_at_all_refuses():
    doc = _flow("wordpress-publish-shape")
    del doc["control_flow_connections"]
    assert "PUBLISH_GATE_NO_ENTRY" in _refused(doc)


@pytest.mark.parametrize("which", ["control_flow_connections", "data_flow_connections"])
@pytest.mark.parametrize("value", [{}, "edges", 0])
def test_an_edge_list_that_is_not_a_list_refuses(which, value):
    doc = _flow("wordpress-publish-shape")
    doc[which] = value
    assert f"PUBLISH_GATE_UNSUPPORTED: the flow's {which} is not a list" in _refused(doc)


@pytest.mark.parametrize("shape", ["no edge into the node", "no edge list", "an empty edge list"])
def test_a_publishing_node_with_no_data_edge_in_refuses(shape):
    """The stop would surface nothing, and a flow with no data edge list may be
    wired by name, which the pass cannot read."""
    doc = _flow("wordpress-publish-shape")
    if shape == "no edge into the node":
        doc["data_flow_connections"] = [
            e for e in doc["data_flow_connections"] if _ref(e["destination_node"]) != "publish"
        ]
    elif shape == "no edge list":
        del doc["data_flow_connections"]
    else:
        doc["data_flow_connections"] = []
    assert "no data edge feeds it" in _refused(doc)


def test_the_start_node_set_to_the_publishing_node_refuses():
    doc = _flow("wordpress-publish-shape")
    doc["start_node"] = {"$component_ref": "publish"}
    assert "referenced outside the root flow" in _refused(doc)


def test_a_nested_definition_that_reuses_the_publishing_node_id_refuses():
    doc = _flow("wordpress-publish-shape")
    inner = _flow("two-publishing-steps")
    for n in inner["$referenced_components"].values():
        n.get("metadata", {}).get("cinatra", {}).pop("publishes", None)
    inner["$referenced_components"]["publish"] = _node("publish", "ApiNode")
    doc["$referenced_components"]["inner_flow"] = inner
    assert "a nested definition reuses the id of node 'publish'" in _refused(doc)


def test_true_on_an_inline_node_in_the_root_node_list_refuses():
    doc = _flow("wordpress-publish-shape")
    doc["$referenced_components"]["publish"]["metadata"]["cinatra"].pop("publishes")
    doc["nodes"].append(_node("inline", "ApiNode", {"publishes": True}))
    assert "PUBLISHES_MISPLACED" in _refused(doc)


def test_a_node_list_that_is_not_a_list_refuses_a_declaration():
    doc = _flow("wordpress-publish-shape")
    doc["nodes"] = {"nodes": doc["nodes"]}
    assert "PUBLISHES_MISPLACED" in _refused(doc)


@pytest.mark.parametrize("which", ["control_flow_connections", "data_flow_connections"])
def test_an_edge_the_pass_cannot_read_refuses(which):
    doc = _flow("wordpress-publish-shape")
    doc[which].append({"$component_ref": "some_edge"})
    assert "PUBLISH_GATE_UNSUPPORTED" in _refused(doc)


@pytest.mark.parametrize("field,value", [("source_output", 5), ("destination_input", None)])
def test_a_data_edge_with_a_name_that_is_not_a_string_refuses(field, value):
    doc = _flow("wordpress-publish-shape")
    _df_into(doc, "publish")[0][field] = value
    assert "PUBLISH_GATE_UNSUPPORTED: data edge #" in _refused(doc)


def test_an_edge_end_that_is_not_a_reference_refuses():
    doc = _flow("wordpress-publish-shape")
    doc["control_flow_connections"][0]["to_node"] = {"component_type": "ApiNode", "id": "inline"}
    assert "PUBLISH_GATE_UNSUPPORTED" in _refused(doc)


def test_a_publishing_node_referenced_outside_the_root_flow_refuses():
    """A subflow that lists the publishing node would run it without the gate."""
    doc = _flow("wordpress-publish-shape")
    inner = _flow("two-publishing-steps")
    for n in inner["$referenced_components"].values():
        n.get("metadata", {}).get("cinatra", {}).pop("publishes", None)
    inner["nodes"].append({"$component_ref": "publish"})
    doc["$referenced_components"]["inner_flow"] = inner
    assert "PUBLISH_GATE_UNSUPPORTED" in _refused(doc)


@pytest.mark.parametrize("title", ["post-text", "1st", "", "a b"])
def test_an_input_the_gate_could_not_surface_refuses(title):
    doc = _flow("wordpress-publish-shape")
    _df_into(doc, "publish")[0]["destination_input"] = title
    assert "PUBLISH_GATE_UNSUPPORTED" in _refused(doc)


def test_a_refusal_names_the_node_but_no_value():
    doc = _flow("wordpress-publish-shape")
    doc["$referenced_components"]["publish"]["metadata"]["cinatra"]["publishes"] = "secret-looking-value"
    text = _refused(doc)
    assert "'publish'" in text and "secret-looking-value" not in text


def test_a_node_id_is_quoted_on_one_line_and_cut_at_120_characters():
    q = agent_loader._quote_node_id
    assert q("x" * 120) == repr("x" * 120)
    assert q("x" * 121) == repr("x" * 120 + "...")
    for raw in ("a\nb", "a\u2028b", "a\rb"):
        assert "\n" not in q(raw) and "\u2028" not in q(raw) and "\r" not in q(raw)
    assert q("a\nb") == "'a\\nb'"


def test_a_node_id_that_is_not_a_string_is_never_printed():
    q = agent_loader._quote_node_id
    for value in ({"token": "secret-looking-value"}, ["secret-looking-value"], 12345):
        assert "secret-looking-value" not in q(value) and "12345" not in q(value)
    doc = _flow("wordpress-publish-shape")
    doc["$referenced_components"]["publish"]["metadata"]["cinatra"].pop("publishes")
    inline = _node("inline", "ApiNode", {"publishes": "x"})
    inline["id"] = {"token": "secret-looking-value"}
    doc["nodes"].append(inline)
    text = _refused(doc)
    assert "PUBLISHES_MALFORMED" in text and "secret-looking-value" not in text


# --- the mount pipeline: the pass runs before the gate reconcile ---------------------------------------------------


class _Stop(Exception):
    pass


class _CapturingLoader:
    def __init__(self) -> None:
        self.text: str | None = None

    def load_json(self, text: str):
        self.text = text
        raise _Stop()


def _mount(tmp_path: Path, doc: dict) -> _CapturingLoader:
    raw = json.dumps(doc).encode("utf-8")
    oas = tmp_path / "oas.json"
    oas.write_bytes(raw)
    loader = _CapturingLoader()
    with pytest.raises(_Stop):
        agent_loader._mount_one_sync(
            loader, "vendor", "slug", oas, hashlib.sha256(raw).hexdigest(), "http://wayflow.invalid"
        )
    return loader


def test_the_mount_inserts_the_gate_and_the_reconcile_makes_it_surface_values(tmp_path):
    loader = _mount(tmp_path, _flow("wordpress-publish-shape"))
    loaded = json.loads(loader.text)
    gate = loaded["$referenced_components"][PREFIX + "publish"]
    # The reconcile ran AFTER the insertion: the gate is the pin-accepted form,
    # and its template renders every surfaced value.
    assert gate["component_type"] == "PluginInputMessageNode"
    assert "inputs" not in gate
    titles = [e["destination_input"] for e in _df_into(_flow("wordpress-publish-shape"), "publish")]
    for t in titles:
        assert '"' + t + '": {% if ' + t + " %}{{ " + t + " | tojson }}" in gate["message_template"]


def test_the_mount_refuses_a_malformed_declaration_before_the_runtime_sees_it(tmp_path):
    doc = _flow("wordpress-publish-shape")
    doc["$referenced_components"]["publish"]["metadata"]["cinatra"]["publishes"] = "true"
    raw = json.dumps(doc).encode("utf-8")
    oas = tmp_path / "oas.json"
    oas.write_bytes(raw)
    loader = _CapturingLoader()
    with pytest.raises(agent_loader.PublishGateError):
        agent_loader._mount_one_sync(
            loader, "vendor", "slug", oas, hashlib.sha256(raw).hexdigest(), "http://wayflow.invalid"
        )
    assert loader.text is None


def test_the_mount_of_a_flow_with_no_declaration_hands_the_runtime_no_gate(tmp_path):
    doc = _flow("wordpress-publish-shape")
    doc["$referenced_components"]["publish"]["metadata"]["cinatra"].pop("publishes")
    loader = _mount(tmp_path, doc)
    assert PREFIX not in loader.text


def _renamed(doc: dict, old: str, new: str) -> dict:
    refs = doc["$referenced_components"]
    refs[new] = refs.pop(old)
    refs[new]["id"] = refs[new]["name"] = new
    for end in (
        [n for n in doc["nodes"]]
        + [e[k] for e in doc["control_flow_connections"] for k in ("from_node", "to_node")]
        + [e[k] for e in doc["data_flow_connections"] for k in ("source_node", "destination_node")]
    ):
        if end.get("$component_ref") == old:
            end["$component_ref"] = new
    return doc


def test_the_mount_log_quotes_and_cuts_the_gate_id(tmp_path, capsys):
    odd = "pub\nlish" + "x" * 130
    _mount(tmp_path, _renamed(_flow("wordpress-publish-shape"), "publish", odd))
    line = next(x for x in capsys.readouterr().out.splitlines() if "publish gates vendor/slug" in x)
    assert "lish" in line and "..." in line and "x" * 130 not in line


def test_a_mount_with_a_context_injection_records_the_gated_document(tmp_path, monkeypatch):
    """With a context-subflow injection, the composed document the debug view
    reads holds the gate, and its fingerprint is that of the document loaded."""

    class _Server:
        def serve_agent(self, agent, url):
            self.agent = agent

    class _Loader:
        def load_json(self, text):
            self.text = text
            return type("_Agent", (), {})()

    monkeypatch.setattr(
        agent_loader, "inject_context_subflows", lambda d, label: (copy.deepcopy(d), [{"slot": "s"}])
    )
    monkeypatch.setattr(agent_loader, "A2AServer", _Server)
    monkeypatch.setattr(agent_loader, "_discover_a2a_asgi_app", lambda server, label: object())
    raw = json.dumps(_flow("wordpress-publish-shape")).encode("utf-8")
    oas = tmp_path / "oas.json"
    oas.write_bytes(raw)
    loader = _Loader()
    mounted = agent_loader._mount_one_sync(
        loader, "vendor", "slug", oas, hashlib.sha256(raw).hexdigest(), "http://wayflow.invalid"
    )
    gate = mounted.composed_oas["$referenced_components"][PREFIX + "publish"]
    assert gate["component_type"] == "PluginInputMessageNode"
    composed = json.dumps(mounted.composed_oas)
    assert mounted.composed_sha256 == hashlib.sha256(composed.encode("utf-8")).hexdigest()
    assert json.loads(loader.text) == json.loads(agent_loader._substitute_placeholders(composed))


# --- A2: the loaded flow is no longer API-only, and a run stops at the gate ----------------------------------------


def _load(doc: dict):
    return AgentSpecLoader().load_json(agent_loader._substitute_placeholders(json.dumps(doc)))


def _preloaded(name: str) -> dict:
    doc = _flow(name)
    agent_loader._insert_publish_gates(doc, name)
    agent_loader._reconcile_input_message_gates(doc, name)
    return doc


@pytest.mark.skipif(AgentSpecLoader is None, reason="wayflowcore not installed (run inside the wayflow image)")
@pytest.mark.parametrize("name", sorted(FLOWS))
def test_the_loaded_flow_is_no_longer_api_only(name):
    assert agent_loader._is_apinode_only_flow(_load(_flow(name))) is True  # today: API-only
    flow = _load(_preloaded(name))
    assert agent_loader._is_apinode_only_flow(flow) is False
    gate_steps = {
        name: type(step).__name__ for name, step in flow.steps.items() if name.startswith(PREFIX)
    }
    assert gate_steps == {PREFIX + s: "InputMessageStep" for s in FLOWS[name]["publishingSteps"]}


@pytest.mark.skipif(AgentSpecLoader is None, reason="wayflowcore not installed (run inside the wayflow image)")
def test_a_gated_flow_mounts_through_serve_agent_without_the_api_only_bypass(tmp_path, monkeypatch, capsys):
    """The real mount: the real loader and A2AServer.serve_agent, with the
    production API-only bypass installed (and undone after the test). The gated
    flow is served without the bypass; the same flow with no declaration needs it."""
    from wayflowcore.agentserver.server import A2AServer as server_cls  # type: ignore[import-not-found]

    monkeypatch.setattr(
        server_cls, "serve_agent", getattr(server_cls.serve_agent, "__wrapped__", server_cls.serve_agent)
    )
    agent_loader._patch_serve_agent_flow_validation()

    def mount(doc: dict, slug: str):
        raw = json.dumps(doc).encode("utf-8")
        oas = tmp_path / f"{slug}.json"
        oas.write_bytes(raw)
        return agent_loader._mount_one_sync(
            AgentSpecLoader(), "vendor", slug, oas, hashlib.sha256(raw).hexdigest(), "http://wayflow.invalid"
        )

    capsys.readouterr()
    gated = mount(_flow("wordpress-publish-shape"), "gated")
    out = capsys.readouterr().out
    assert "publish gates vendor/gated" in out and "validation bypassed" not in out
    assert agent_loader._is_apinode_only_flow(gated.server.agent) is False
    plain = _flow("wordpress-publish-shape")
    plain["$referenced_components"]["publish"]["metadata"]["cinatra"].pop("publishes")
    mount(plain, "plain")
    assert "validation bypassed" in capsys.readouterr().out


@pytest.mark.skipif(AgentSpecLoader is None, reason="wayflowcore not installed (run inside the wayflow image)")
def test_a_run_stops_at_the_gate_before_the_publishing_call_and_names_the_gate():
    """`announce` is the first step after start. Its URL cannot be reached, so a
    call would raise; the run must yield at the gate first, and the step the
    runtime signs in its gate claim is the gate the host derives."""
    flow = _load(_preloaded("two-publishing-steps"))
    conversation = flow.start_conversation(inputs={"message": "hello", "cinatra_run_id": "run-1"})
    status = conversation.execute()
    assert isinstance(status, UserMessageRequestStatus)
    assert agent_loader._find_yielding_step_id(status, conversation) == PREFIX + "announce"
    surfaced = json.loads(conversation.get_messages()[-1].content)
    assert surfaced == {"message": "hello"}
