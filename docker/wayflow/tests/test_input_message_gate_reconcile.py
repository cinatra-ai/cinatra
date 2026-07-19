"""Mount-time guard for cinatra#1830 — HITL InputMessageNode gate reconcile.

pyagentspec 26.1.2 derives an ``InputMessageNode``'s expected inputs SOLELY
from ``{{placeholder}}`` tokens in its ``message`` field, and the base component
validator rejects any explicitly-declared ``inputs`` title not in that inferred
set ("received a property titled `X`, but did not expect any properties"). The
cinatra HITL authoring form (the #1794 primitives doc, and the host
``oas-compiler`` which pins ``component_type == "InputMessageNode"``)
deliberately declares the gate's inputs and feeds them via a ``DataFlowEdge`` —
a shape the pinned runtime rejects.

``agent_loader._reconcile_input_message_gates`` bridges the two at load time by
rewriting such gates to ``PluginInputMessageNode`` + a synthesized
``message_template``. These tests lock that behaviour so an unmountable declared-
inputs gate can never regress silently, and prove the shipped shape both fails
bare AND mounts after the shim on the canonical pin.
"""
from __future__ import annotations

import copy
import json

import pytest

try:
    from wayflowcore.agentspec import AgentSpecLoader  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — runs only where wayflowcore is installed
    AgentSpecLoader = None  # type: ignore[assignment]

import agent_loader  # type: ignore[import-not-found]


# A minimal, self-contained flow that mirrors the #1794 HITL authoring form:
# a prep node whose output is wired via a DataFlowEdge into an InputMessageNode
# gate that declares that input explicitly. This is exactly the shape the pinned
# runtime rejects and the loader shim repairs.
def _hitl_oas(gate_inputs):
    gate_input_props = [
        {"title": t, "type": "array", "json_schema": {"items": {"type": "string"}}, "default": []}
        for t in gate_inputs
    ]
    dfes = [
        {
            "component_type": "DataFlowEdge",
            "name": f"prep_{t}_to_gate_{t}",
            "source_node": {"$component_ref": "prep"},
            "source_output": t,
            "destination_node": {"$component_ref": "gate"},
            "destination_input": t,
        }
        for t in gate_inputs
    ]
    return {
        "agentspec_version": "26.1.0",
        "component_type": "Flow",
        "id": "hitl-fixture-flow",
        "name": "HITL fixture",
        "metadata": {"cinatra": {"type": "flow", "packageName": "@cinatra-ai/hitl-fixture"}},
        "inputs": [{"title": "cinatra_run_id", "type": "string", "default": ""}],
        "outputs": [{"title": "confirmed", "type": "string"}],
        "start_node": {"$component_ref": "start"},
        "nodes": [{"$component_ref": n} for n in ("start", "prep", "gate", "end")],
        "control_flow_connections": [
            {"component_type": "ControlFlowEdge", "name": "s_p", "from_node": {"$component_ref": "start"}, "to_node": {"$component_ref": "prep"}},
            {"component_type": "ControlFlowEdge", "name": "p_g", "from_node": {"$component_ref": "prep"}, "to_node": {"$component_ref": "gate"}},
            {"component_type": "ControlFlowEdge", "name": "g_e", "from_node": {"$component_ref": "gate"}, "to_node": {"$component_ref": "end"}},
        ],
        "data_flow_connections": dfes + [
            {"component_type": "DataFlowEdge", "name": "gate_confirmed_end", "source_node": {"$component_ref": "gate"}, "source_output": "confirmed", "destination_node": {"$component_ref": "end"}, "destination_input": "confirmed"},
        ],
        "$referenced_components": {
            "start": {"component_type": "StartNode", "id": "start", "name": "Inputs", "inputs": [{"title": "cinatra_run_id", "type": "string", "default": ""}]},
            "prep": {
                "component_type": "ApiNode", "id": "prep", "name": "Prep",
                "url": "{{CINATRA_BASE_URL}}/api/agents/passthrough", "http_method": "POST",
                "data": {"tool": "noop", "input": {}, "agent_run_id": "{{ cinatra_run_id }}"},
                "outputs": [{"title": t, "type": "array", "json_schema": {"items": {"type": "string"}}} for t in gate_inputs],
            },
            "gate": {
                "component_type": "InputMessageNode", "id": "gate", "name": "Review",
                "metadata": {"cinatra": {"requiresApproval": True, "renderer": "@cinatra-ai/hitl-fixture:review"}},
                "inputs": gate_input_props,
                "outputs": [{"title": "confirmed", "type": "string"}],
            },
            "end": {"component_type": "EndNode", "id": "end", "name": "End", "outputs": [{"title": "confirmed", "type": "string"}]},
        },
    }


def _load(doc):
    raw = agent_loader._substitute_placeholders(json.dumps(doc))
    return AgentSpecLoader().load_json(raw)


@pytest.mark.skipif(AgentSpecLoader is None, reason="wayflowcore not installed")
def test_declared_input_gate_fails_bare_on_the_pin():
    """The #1794 declared-inputs form must fail bare AgentSpecLoader on the pin.

    Guards the root cause so a future pyagentspec bump that starts honoring
    declared inputs is noticed (this test would then need updating alongside a
    shim retirement).
    """
    with pytest.raises(Exception):
        _load(_hitl_oas(["skillIds"]))


@pytest.mark.skipif(AgentSpecLoader is None, reason="wayflowcore not installed")
@pytest.mark.parametrize("gate_inputs", [["skillIds"], ["prompts", "preview"]])
def test_reconcile_makes_declared_input_gate_mount(gate_inputs):
    """After the loader shim, the same gate mounts and the runtime step carries
    exactly the declared inputs — so the DataFlowEdge still delivers their values
    to the interrupt payload (and thus the renderer)."""
    doc = copy.deepcopy(_hitl_oas(gate_inputs))
    report = agent_loader._reconcile_input_message_gates(doc, "hitl-fixture")
    assert [r["node"] for r in report] == ["gate"]
    gate = doc["$referenced_components"]["gate"]
    assert gate["component_type"] == "PluginInputMessageNode"
    assert "inputs" not in gate
    assert gate["message_template"] == "".join(f"{{% if {t} %}}{{% endif %}}" for t in gate_inputs)

    flow = _load(doc)
    steps = flow.steps if hasattr(flow, "steps") else {}
    imn = [s for s in steps.values() if "Input" in type(s).__name__]
    assert len(imn) == 1
    assert sorted(d.name for d in imn[0].input_descriptors) == sorted(gate_inputs)


@pytest.mark.skipif(AgentSpecLoader is None, reason="wayflowcore not installed")
def test_reconcile_is_idempotent_and_renders_empty():
    """Re-running the shim is a no-op, and the synthesized template renders empty
    (no gate payload text leaks into the conversation)."""
    doc = _hitl_oas(["skillIds"])
    agent_loader._reconcile_input_message_gates(doc, "hitl-fixture")
    second = agent_loader._reconcile_input_message_gates(doc, "hitl-fixture")
    assert second == []  # already reconciled → nothing to do

    import jinja2
    rendered = jinja2.Environment().from_string(
        doc["$referenced_components"]["gate"]["message_template"]
    ).render(skillIds=["a", "b"])
    assert rendered == ""


def test_reconcile_leaves_malformed_input_titles_untouched():
    """If ANY declared input lacks a fold-able identifier title, the shim must
    NOT rewrite the node (never silently drop declared inputs a DFE may feed) —
    it leaves the node to fail loudly on the pin."""
    doc = _hitl_oas(["skillIds"])
    gate = doc["$referenced_components"]["gate"]
    # add a second, unnamed/malformed input descriptor
    gate["inputs"].append({"type": "string"})  # no title
    report = agent_loader._reconcile_input_message_gates(doc, "hitl-fixture")
    assert report == []
    assert gate["component_type"] == "InputMessageNode"
    assert "inputs" in gate and len(gate["inputs"]) == 2  # nothing dropped


def test_reconcile_rejects_non_identifier_and_duplicate_titles():
    doc = _hitl_oas(["skillIds"])
    doc["$referenced_components"]["gate"]["inputs"][0]["title"] = "not an ident"
    assert agent_loader._reconcile_input_message_gates(doc, "x") == []

    doc2 = _hitl_oas(["dup", "dup"])
    assert agent_loader._reconcile_input_message_gates(doc2, "x") == []


@pytest.mark.skipif(AgentSpecLoader is None, reason="wayflowcore not installed")
def test_gate_without_declared_inputs_is_untouched():
    """A gate that declares no inputs already mounts on the pin — the shim must
    not rewrite it (idempotent / minimal)."""
    doc = _hitl_oas([])  # no DFE-fed gate inputs
    doc["$referenced_components"]["gate"].pop("inputs", None)
    report = agent_loader._reconcile_input_message_gates(doc, "hitl-fixture")
    assert report == []
    assert doc["$referenced_components"]["gate"]["component_type"] == "InputMessageNode"
    _load(doc)  # still mounts
