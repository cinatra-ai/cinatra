"""cinatra#3032 (epic #3023, lifecycle-c W8) — parent-satisfied context slots.

Acceptance item 4: "A composite fixture agent's embedded agents receive the
parent's finalized selection and pause nowhere."

Plan (C) item 0.29: "a composite agent declares in its manifest which of its own
context slots satisfy which slots of the agents it embeds, one line per child
slot; the runtime resolves the parent's pick once and hands it down, and the
child's pause never fires."

PURE-INJECTOR SUITE, exactly like its sibling test_context_subflow_injection.py:
the loader's graph surgery is the subject, and the two facts that matter are
STRUCTURAL — no pausing subflow is put in front of a satisfied child slot, and
the parent's finalized selection reaches that child's consumers instead.

The pause is the injected subflow: its interactive selection step is the only
thing in a mounted child that can park a run for a context pick. A child slot
with no injected subflow therefore has nothing to pause on, which is what these
tests assert by id and by edge rather than by running a flow.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List

import pytest

from context_subflow_injection import (
    ContextInjectionError,
    inject_context_subflows,
)


def _cref(value: Any) -> Any:
    if isinstance(value, dict):
        return value.get("$component_ref")
    return value


def _data_edges(definition: Dict[str, Any]) -> set:
    return {
        (
            _cref(e["source_node"]),
            e["source_output"],
            _cref(e["destination_node"]),
            e["destination_input"],
        )
        for e in definition.get("data_flow_connections", [])
    }


def _all_ids(node: Any) -> set:
    ids: set = set()

    def walk(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                walk(item)
            return
        if not isinstance(value, dict):
            return
        if isinstance(value.get("id"), str):
            ids.add(value["id"])
        refs = value.get("$referenced_components")
        if isinstance(refs, dict):
            ids.update(k for k in refs if isinstance(k, str))
        for item in value.values():
            walk(item)

    walk(node)
    return ids


def _slot(slot_id: str, **overrides: Any) -> Dict[str, Any]:
    base: Dict[str, Any] = {
        "slotId": slot_id,
        "acceptedArtifactExtensions": ["@cinatra-ai/brand-voice-artifact"],
        "selectionMode": "interactive",
        "resolutionMode": "accumulate",
        "minItems": 0,
        "maxItems": 5,
    }
    base.update(overrides)
    return base


def _child(flow_id: str, package_name: str, slot_id: str) -> Dict[str, Any]:
    """An embedded agent: start -> work -> end, declaring ONE context slot whose
    consumer is its own work node."""
    return {
        "component_type": "Flow",
        "id": flow_id,
        "name": flow_id,
        "metadata": {
            "cinatra": {
                "type": "agent",
                "packageName": package_name,
                "contextSlots": [_slot(slot_id)],
            }
        },
        "inputs": [{"title": "brief", "type": "string"}],
        "outputs": [{"title": "result", "type": "string"}],
        "start_node": {"$component_ref": f"{flow_id}-start"},
        "nodes": [
            {"$component_ref": f"{flow_id}-start"},
            {"$component_ref": f"{flow_id}-work"},
            {"$component_ref": f"{flow_id}-end"},
        ],
        "control_flow_connections": [
            {
                "component_type": "ControlFlowEdge",
                "name": f"{flow_id}-start-to-work",
                "from_node": {"$component_ref": f"{flow_id}-start"},
                "to_node": {"$component_ref": f"{flow_id}-work"},
            },
            {
                "component_type": "ControlFlowEdge",
                "name": f"{flow_id}-work-to-end",
                "from_node": {"$component_ref": f"{flow_id}-work"},
                "to_node": {"$component_ref": f"{flow_id}-end"},
            },
        ],
        "data_flow_connections": [],
        "$referenced_components": {
            f"{flow_id}-start": {
                "component_type": "StartNode",
                "id": f"{flow_id}-start",
                "name": "Inputs",
                "inputs": [{"title": "brief", "type": "string"}],
            },
            f"{flow_id}-work": {
                "component_type": "ApiNode",
                "id": f"{flow_id}-work",
                "name": "Work",
                "url": "{{CINATRA_BASE_URL}}/api/llm-bridge",
                "http_method": "POST",
                "inputs": [
                    {"title": "brief", "type": "string"},
                    {"title": "contextSlotBindings", "type": "string"},
                ],
                "outputs": [{"title": "result", "type": "string"}],
            },
            f"{flow_id}-end": {
                "component_type": "EndNode",
                "id": f"{flow_id}-end",
                "name": "Done",
                "inputs": [{"title": "result", "type": "string"}],
            },
        },
    }


def _composite(
    lines: List[Dict[str, Any]],
    parent_slots: List[Dict[str, Any]] = None,
    children: List[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """A composite agent: start -> ideas -> draft -> end, running two embedded
    agents as subflow nodes, and declaring ONE slot of its own."""
    if parent_slots is None:
        parent_slots = [_slot("brandVoice")]
    if children is None:
        children = [
            _child("idea-flow", "@cinatra-ai/idea-agent", "ideaContext"),
            _child("draft-flow", "@cinatra-ai/draft-agent", "draftContext"),
        ]
    refs: Dict[str, Any] = {
        "start": {
            "component_type": "StartNode",
            "id": "start",
            "name": "Inputs",
            "inputs": [{"title": "brief", "type": "string"}],
        },
        "pipeline-work": {
            "component_type": "ApiNode",
            "id": "pipeline-work",
            "name": "Pipeline work",
            "url": "{{CINATRA_BASE_URL}}/api/llm-bridge",
            "http_method": "POST",
            "inputs": [
                {"title": "brief", "type": "string"},
                {"title": "contextSlotBindings", "type": "string"},
            ],
            "outputs": [{"title": "result", "type": "string"}],
        },
        "end": {
            "component_type": "EndNode",
            "id": "end",
            "name": "Done",
            "inputs": [{"title": "result", "type": "string"}],
        },
    }
    nodes = [
        {"$component_ref": "start"},
        {"$component_ref": "pipeline-work"},
    ]
    control: List[Dict[str, Any]] = [
        {
            "component_type": "ControlFlowEdge",
            "name": "start-to-work",
            "from_node": {"$component_ref": "start"},
            "to_node": {"$component_ref": "pipeline-work"},
        },
    ]
    previous = "pipeline-work"
    for child in children:
        flow_id = child["id"]
        holder = f"{flow_id}-node"
        refs[flow_id] = child
        refs[holder] = {
            "component_type": "FlowNode",
            "id": holder,
            "name": holder,
            "metadata": {"cinatra": {"packageName": child["metadata"]["cinatra"]["packageName"]}},
            "subflow": {"$component_ref": flow_id},
        }
        nodes.append({"$component_ref": holder})
        control.append(
            {
                "component_type": "ControlFlowEdge",
                "name": f"{previous}-to-{holder}",
                "from_node": {"$component_ref": previous},
                "to_node": {"$component_ref": holder},
            }
        )
        previous = holder
    nodes.append({"$component_ref": "end"})
    control.append(
        {
            "component_type": "ControlFlowEdge",
            "name": f"{previous}-to-end",
            "from_node": {"$component_ref": previous},
            "to_node": {"$component_ref": "end"},
        }
    )
    cinatra: Dict[str, Any] = {
        "type": "agent",
        "packageName": "@cinatra-ai/pipeline-agent",
        "contextSlots": parent_slots,
    }
    if lines is not None:
        cinatra["parentSatisfiedContextSlots"] = lines
    return {
        "agentspec_version": "26.1.0",
        "component_type": "Flow",
        "id": "pipeline-flow",
        "name": "Pipeline",
        "metadata": {"cinatra": cinatra},
        "inputs": [{"title": "brief", "type": "string"}],
        "outputs": [{"title": "result", "type": "string"}],
        "start_node": {"$component_ref": "start"},
        "nodes": nodes,
        "control_flow_connections": control,
        "data_flow_connections": [],
        "$referenced_components": refs,
    }


BOTH_LINES = [
    {
        "parentSlotId": "brandVoice",
        "childPackage": "@cinatra-ai/idea-agent",
        "childSlotId": "ideaContext",
    },
    {
        "parentSlotId": "brandVoice",
        "childPackage": "@cinatra-ai/draft-agent",
        "childSlotId": "draftContext",
    },
]


def _definition(composed: Dict[str, Any], flow_id: str) -> Dict[str, Any]:
    return composed["$referenced_components"][flow_id]


class TestEmbeddedAgentsPauseNowhere:
    """Acceptance item 4 — the embedded agents receive the parent's finalized
    selection and pause nowhere."""

    def test_no_context_subflow_is_injected_into_a_satisfied_child(self) -> None:
        composed, _report = inject_context_subflows(_composite(BOTH_LINES), "pipeline")

        for flow_id, slot_id in (
            ("idea-flow", "ideaContext"),
            ("draft-flow", "draftContext"),
        ):
            child = _definition(composed, flow_id)
            ids = _all_ids(child)
            # The pausing subflow and its node are what a child would have had.
            assert f"context-{slot_id}-subflow" not in ids
            assert f"context_{slot_id}" not in ids
            # And no marker claims one was placed.
            assert "loader-injected-context-resolution-for-" not in repr(child)

    def test_the_parent_still_resolves_its_own_slot_once(self) -> None:
        composed, report = inject_context_subflows(_composite(BOTH_LINES), "pipeline")
        ids = _all_ids({"root": {k: v for k, v in composed.items() if k != "$referenced_components"},
                        "refs": {k: v for k, v in composed["$referenced_components"].items()
                                 if k not in ("idea-flow", "draft-flow")}})
        assert "context-brandVoice-subflow" in ids
        assert "context_brandVoice" in ids
        # ONE pick: the parent's, and no other context node anywhere.
        every_id = _all_ids(composed)
        assert {i for i in every_id if i.startswith("context_")} == {"context_brandVoice"}
        slots_reported = [entry["slot"] for entry in report]
        assert slots_reported.count("brandVoice") >= 1

    def test_the_parents_finalized_selection_reaches_each_child(self) -> None:
        composed, _report = inject_context_subflows(_composite(BOTH_LINES), "pipeline")

        parent_edges = _data_edges(composed)
        # The parent's resolved bindings, handed to the node that runs each child.
        assert (
            "context_brandVoice",
            "contextSlotBindings",
            "idea-flow-node",
            "ideaContextContextSlotBindings",
        ) in parent_edges
        assert (
            "context_brandVoice",
            "contextSlotBindings",
            "draft-flow-node",
            "draftContextContextSlotBindings",
        ) in parent_edges

        # Inside each child, the value arrives on its StartNode and reaches the
        # consumer that declared the slot's input — the same consumer the
        # injected subflow would have fed.
        idea = _definition(composed, "idea-flow")
        assert (
            "idea-flow-start",
            "ideaContextContextSlotBindings",
            "idea-flow-work",
            "contextSlotBindings",
        ) in _data_edges(idea)
        titles = {
            entry["title"]
            for entry in idea["$referenced_components"]["idea-flow-start"]["inputs"]
        }
        assert "ideaContextContextSlotBindings" in titles

    def test_the_report_names_which_child_slot_each_line_satisfies(self) -> None:
        _composedm, report = inject_context_subflows(_composite(BOTH_LINES), "pipeline")
        satisfied = [entry["satisfies"] for entry in report if "satisfies" in entry]
        assert {
            "childPackage": "@cinatra-ai/idea-agent",
            "childSlotId": "ideaContext",
        } in satisfied
        assert {
            "childPackage": "@cinatra-ai/draft-agent",
            "childSlotId": "draftContext",
        } in satisfied

    def test_a_child_with_no_line_keeps_its_own_pause(self) -> None:
        """"a child with no slot receives nothing" — and a child with a slot and
        no line still resolves it itself."""
        composed, _report = inject_context_subflows(_composite(BOTH_LINES[:1]), "pipeline")
        idea = _definition(composed, "idea-flow")
        draft = _definition(composed, "draft-flow")
        assert "context_ideaContext" not in _all_ids(idea)
        # The unsatisfied child keeps the subflow it always had.
        assert "context_draftContext" in _all_ids(draft)
        assert "context-draftContext-subflow" in _all_ids(draft)

    def test_a_document_that_declares_nothing_is_untouched(self) -> None:
        doc = _composite([])
        before = copy.deepcopy(doc)
        composed, _report = inject_context_subflows(doc, "pipeline")
        # Injection still happens for the declared slots; what must NOT happen is
        # a hand-down edge nobody declared.
        assert all(
            "parent_satisfied" not in edge.get("name", "")
            for edge in composed.get("data_flow_connections", [])
        )
        assert doc == before  # the input document itself is never mutated


class TestTheDeclarationIsExecutableInput:
    """A present-but-malformed declaration fails the mount, the same posture the
    slot declaration itself has."""

    @pytest.mark.parametrize(
        "lines,expected",
        [
            ("not-an-array", "must be an array"),
            ([{"parentSlotId": "brandVoice"}], "must be a non-empty string"),
            (
                [{**BOTH_LINES[0], "extra": "x"}],
                "unknown key",
            ),
            ([BOTH_LINES[0], dict(BOTH_LINES[0])], "satisfied twice"),
        ],
    )
    def test_malformed_declarations_fail_the_mount(self, lines: Any, expected: str) -> None:
        with pytest.raises(ContextInjectionError) as err:
            inject_context_subflows(_composite(lines), "pipeline")
        assert expected in str(err.value)

    def test_a_line_that_names_no_embedded_agent_fails_the_mount(self) -> None:
        line = {
            "parentSlotId": "brandVoice",
            "childPackage": "@cinatra-ai/absent-agent",
            "childSlotId": "ideaContext",
        }
        with pytest.raises(ContextInjectionError) as err:
            inject_context_subflows(_composite([line]), "pipeline")
        assert "names no embedded agent" in str(err.value)

    def test_a_line_that_names_an_undeclared_child_slot_fails_the_mount(self) -> None:
        line = {
            "parentSlotId": "brandVoice",
            "childPackage": "@cinatra-ai/idea-agent",
            "childSlotId": "notASlot",
        }
        with pytest.raises(ContextInjectionError) as err:
            inject_context_subflows(_composite([line]), "pipeline")
        assert "names no embedded agent" in str(err.value)


# ---------------------------------------------------------------------------
# CONVERGENCE ROUND (cinatra#3032) — the four fail-open holes a read of the
# hand-down path found. Each of these passed BEFORE the fix, which is the whole
# problem: the child lost its pause and received nothing, or received two things.
# ---------------------------------------------------------------------------


def test_the_childs_start_node_is_never_its_own_consumer():
    """The StartNode is the SOURCE of the hand-down, not a consumer of it.

    It gains the binding input because it carries the value in; discovering it
    again as a consumer draws a start-to-start self-edge, and that self-edge
    alone satisfies the "this slot has a consumer" check — so a child whose real
    work node had lost its context input would still mount, silently doing the
    work without the pick.
    """
    composed, _report = inject_context_subflows(
        _composite(
            [
                {
                    "parentSlotId": "brandVoice",
                    "childPackage": "@cinatra-ai/idea-agent",
                    "childSlotId": "ideaContext",
                }
            ]
        ),
        "pipeline",
    )
    child = _definition(composed, "idea-flow")
    for source, _out, destination, _in in _data_edges(child):
        assert not (
            source == "idea-flow-start" and destination == "idea-flow-start"
        ), "the child's StartNode must never feed itself"

    # And the consumer check still bites when there is genuinely no consumer.
    doc = _composite(
        [
            {
                "parentSlotId": "brandVoice",
                "childPackage": "@cinatra-ai/idea-agent",
                "childSlotId": "ideaContext",
            }
        ]
    )
    work = doc["$referenced_components"]["idea-flow"]["$referenced_components"][
        "idea-flow-work"
    ]
    work["inputs"] = [i for i in work["inputs"] if i["title"] != "contextSlotBindings"]
    with pytest.raises(ContextInjectionError) as err:
        inject_context_subflows(doc, "pipeline")
    assert "no consumer" in str(err.value)


def test_a_line_naming_a_slot_the_parent_does_not_declare_fails_the_mount():
    """The line removes the child's pause; a parent slot that does not exist can
    never hand anything down, so the promise is refused rather than half-kept."""
    with pytest.raises(ContextInjectionError) as err:
        inject_context_subflows(
            _composite(
                [
                    {
                        "parentSlotId": "noSuchSlot",
                        "childPackage": "@cinatra-ai/idea-agent",
                        "childSlotId": "ideaContext",
                    }
                ]
            ),
            "pipeline",
        )
    assert "does not declare" in str(err.value)


def test_a_hand_down_from_an_already_carried_slot_fails_the_mount():
    """A slot the author already carries is NOT injected, so `context_<slot>` —
    the node the hand-down edge names as its source — does not exist. Before the
    fix the child's pause was removed and no edge was drawn at all: the child
    received nothing, silently."""
    doc = _composite(
        [
            {
                "parentSlotId": "brandVoice",
                "childPackage": "@cinatra-ai/idea-agent",
                "childSlotId": "ideaContext",
            }
        ]
    )
    # The author's own resolution marker for the parent's slot.
    doc["$referenced_components"]["pipeline-work"]["metadata"] = {
        "cinatra": {"purpose": "author-placed-context-resolution-for-brandVoice"}
    }
    with pytest.raises(ContextInjectionError) as err:
        inject_context_subflows(doc, "pipeline")
    assert "no resolved pick to hand down" in str(err.value)


def test_a_hand_down_never_competes_with_existing_wiring():
    """The consumer edges refuse to double-wire an input; the hand-down edge is
    the same write into the same kind of input and takes the same refusal."""
    doc = _composite(
        [
            {
                "parentSlotId": "brandVoice",
                "childPackage": "@cinatra-ai/idea-agent",
                "childSlotId": "ideaContext",
            }
        ]
    )
    doc["$referenced_components"]["idea-flow-node"]["inputs"] = [
        {"title": "ideaContextContextSlotBindings", "type": "string"}
    ]
    doc.setdefault("data_flow_connections", []).append(
        {
            "component_type": "DataFlowEdge",
            "name": "authors-own-wiring",
            "source_node": {"$component_ref": "pipeline-work"},
            "source_output": "result",
            "destination_node": {"$component_ref": "idea-flow-node"},
            "destination_input": "ideaContextContextSlotBindings",
        }
    )
    with pytest.raises(ContextInjectionError) as err:
        inject_context_subflows(doc, "pipeline")
    assert "already has a data-flow edge" in str(err.value)
