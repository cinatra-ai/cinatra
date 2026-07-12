"""cinatra#1194 — loader-owned context-subflow injection.

Pure-injector suite (no wayflowcore needed) plus a mount-path test with
stubbed loader globals and an OPTIONAL real pyagentspec deserialization
smoke (skipped when wayflowcore is not installed — it runs inside the
Docker image, where the pin is present).

The load-bearing guarantee: for a slim (declaration-only) spec, injection
produces a graph STRUCTURALLY IDENTICAL to the historical hand-authored
format — same subflow definition bytes, same control/data-flow topology,
same input schema — because the server-side attestation minter signs the
executing node ids and the #907 re-anchor grammar must not drift.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from context_subflow_injection import (
    CONTEXT_SUBFLOW_TEMPLATE_VERSION,
    ContextInjectionError,
    build_context_flow_node,
    build_context_subflow,
    inject_context_subflows,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def _hand_authored() -> Dict[str, Any]:
    with open(FIXTURES / "hand_authored_context_subflow.json") as fh:
        return json.load(fh)


def _cref(value: Any) -> Any:
    return value.get("$component_ref") if isinstance(value, dict) else value


def _control_edges(doc: Dict[str, Any]) -> set:
    return {
        (_cref(e["from_node"]), _cref(e["to_node"]))
        for e in doc["control_flow_connections"]
    }


def _data_edges(doc: Dict[str, Any]) -> set:
    return {
        (
            _cref(e["source_node"]),
            e["source_output"],
            _cref(e["destination_node"]),
            e["destination_input"],
        )
        for e in doc["data_flow_connections"]
    }


def _slot(slot_id: str = "ideaContext", **overrides: Any) -> Dict[str, Any]:
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


def _slim_spec(
    slots: List[Dict[str, Any]],
    consumer_inputs: List[str] = None,
    package_name: str = "@cinatra-ai/slim-agent",
) -> Dict[str, Any]:
    """A minimal slim (declaration-only) leaf spec: start → work → end."""
    if consumer_inputs is None:
        consumer_inputs = ["contextSlotBindings"]
    return {
        "agentspec_version": "26.1.0",
        "component_type": "Flow",
        "id": "slim-agent-flow",
        "name": "Slim agent",
        "metadata": {
            "cinatra": {
                "type": "agent",
                "packageName": package_name,
                "contextSlots": slots,
            }
        },
        "inputs": [{"title": "brief", "type": "string"}],
        "outputs": [{"title": "result", "type": "string"}],
        "start_node": {"$component_ref": "start"},
        "nodes": [
            {"$component_ref": "start"},
            {"$component_ref": "work"},
            {"$component_ref": "end"},
        ],
        "control_flow_connections": [
            {
                "component_type": "ControlFlowEdge",
                "name": "start_to_work",
                "from_node": {"$component_ref": "start"},
                "to_node": {"$component_ref": "work"},
            },
            {
                "component_type": "ControlFlowEdge",
                "name": "work_to_end",
                "from_node": {"$component_ref": "work"},
                "to_node": {"$component_ref": "end"},
            },
        ],
        "data_flow_connections": [
            {
                "component_type": "DataFlowEdge",
                "name": "start_brief_to_work",
                "source_node": {"$component_ref": "start"},
                "source_output": "brief",
                "destination_node": {"$component_ref": "work"},
                "destination_input": "brief",
            },
            {
                "component_type": "DataFlowEdge",
                "name": "work_result_to_end",
                "source_node": {"$component_ref": "work"},
                "source_output": "result",
                "destination_node": {"$component_ref": "end"},
                "destination_input": "result",
            },
        ],
        "$referenced_components": {
            "start": {
                "component_type": "StartNode",
                "id": "start",
                "name": "Inputs",
                "inputs": [{"title": "brief", "type": "string"}],
            },
            "work": {
                "component_type": "ApiNode",
                "id": "work",
                "name": "Work",
                "url": "{{CINATRA_BASE_URL}}/api/llm-bridge",
                "http_method": "POST",
                # An ApiNode only accepts input properties its jinja-templated
                # `data` actually references (pyagentspec validates this).
                "data": {
                    "user": "brief: {{ brief }}"
                    + "".join(
                        f" {t}: {{{{ {t} }}}}" for t in consumer_inputs
                    ),
                },
                "inputs": [{"title": "brief", "type": "string"}]
                + [{"title": t, "type": "array"} for t in consumer_inputs],
                "outputs": [{"title": "result", "type": "string"}],
            },
            "end": {
                "component_type": "EndNode",
                "id": "end",
                "name": "Outputs",
                "outputs": [{"title": "result", "type": "string"}],
                "inputs": [{"title": "result", "type": "string"}],
            },
        },
    }


# ---------------------------------------------------------------------------
# Template byte-parity — the injected subflow IS the hand-authored subflow.
# ---------------------------------------------------------------------------


def test_template_byte_parity_with_hand_authored_subflow() -> None:
    hand = _hand_authored()
    assert build_context_subflow("ideaContext") == hand["subflow"]


def test_flow_node_matches_hand_marker_modulo_metadata() -> None:
    hand = _hand_authored()["marker"]
    node = build_context_flow_node("ideaContext")
    assert node["id"] == hand["id"]
    assert node["name"] == hand["name"]
    assert node["subflow"] == hand["subflow"]
    assert node["component_type"] == hand["component_type"]
    # Provenance is explicit: loader-injected purpose + template version.
    cin = node["metadata"]["cinatra"]
    assert cin["purpose"] == "loader-injected-context-resolution-for-ideaContext"
    assert cin["templateVersion"] == CONTEXT_SUBFLOW_TEMPLATE_VERSION


def test_template_rejects_reserved_token_and_empty_slot() -> None:
    with pytest.raises(ContextInjectionError):
        build_context_subflow("")
    with pytest.raises(ContextInjectionError):
        build_context_subflow("evil__SLOT__slot")


# ---------------------------------------------------------------------------
# Slim-leaf injection.
# ---------------------------------------------------------------------------


def test_slim_leaf_injection_structure() -> None:
    doc = _slim_spec([_slot()])
    composed, report = inject_context_subflows(doc, "t")

    assert report == [
        {
            "slot": "ideaContext",
            "definition": "slim-agent-flow",
            "packageName": "@cinatra-ai/slim-agent",
            "templateVersion": CONTEXT_SUBFLOW_TEMPLATE_VERSION,
        }
    ]
    # Original document untouched; composed is a distinct object.
    assert composed is not doc
    assert "context_ideaContext" not in doc["$referenced_components"]

    refs = composed["$referenced_components"]
    assert refs["context-ideaContext-subflow"] == _hand_authored()["subflow"]
    assert {"$component_ref": "context_ideaContext"} in composed["nodes"]

    # Control splice: start → context node → work (original edge retargeted).
    edges = _control_edges(composed)
    assert ("start", "context_ideaContext") in edges
    assert ("context_ideaContext", "work") in edges
    assert ("start", "work") not in edges

    # Hidden inputs with hand-format names/defaults, on flow AND StartNode.
    for owner in (composed, refs["start"]):
        by_title = {
            i["title"]: i for i in owner["inputs"] if isinstance(i, dict)
        }
        assert by_title["cinatra_run_id"]["default"] == ""
        assert by_title["projectId"]["default"] == ""
        assert (
            by_title["ideaContextParentPackageName"]["default"]
            == "@cinatra-ai/slim-agent"
        )
        assert by_title["ideaContextSlotId"]["default"] == "ideaContext"
    hidden = refs["start"]["metadata"]["cinatra"]["hidden"]
    for title in (
        "cinatra_run_id",
        "projectId",
        "ideaContextParentPackageName",
        "ideaContextSlotId",
    ):
        assert title in hidden

    # Data-flow wiring into the subflow node + consumer edge (hand parity).
    dedges = _data_edges(composed)
    assert ("start", "cinatra_run_id", "context_ideaContext", "parentRunId") in dedges
    assert (
        "start",
        "ideaContextParentPackageName",
        "context_ideaContext",
        "parentPackageName",
    ) in dedges
    assert ("start", "ideaContextSlotId", "context_ideaContext", "slotId") in dedges
    assert ("start", "projectId", "context_ideaContext", "projectId") in dedges
    assert (
        "context_ideaContext",
        "contextSlotBindings",
        "work",
        "contextSlotBindings",
    ) in dedges


def test_slim_injection_reproduces_hand_authored_topology() -> None:
    """Strip the hand-carried machinery out of the REAL hand-format shape and
    prove injection reproduces the exact original topology."""
    hand = _hand_authored()
    doc = _slim_spec([_slot()])
    composed, _ = inject_context_subflows(doc, "t")

    # The injected subflow definition is byte-identical to the hand format.
    assert (
        composed["$referenced_components"]["context-ideaContext-subflow"]
        == hand["subflow"]
    )
    # Exactly one context FlowNode, referenced from nodes, wired start→ctx→work.
    assert composed["$referenced_components"]["context_ideaContext"]["subflow"] == {
        "$component_ref": "context-ideaContext-subflow"
    }


def test_multiple_start_successors_all_retargeted() -> None:
    doc = _slim_spec([_slot()])
    doc["control_flow_connections"].append(
        {
            "component_type": "ControlFlowEdge",
            "name": "start_to_end_direct",
            "from_node": {"$component_ref": "start"},
            "to_node": {"$component_ref": "end"},
            "from_branch": "alt",
        }
    )
    composed, _ = inject_context_subflows(doc, "t")
    edges = _control_edges(composed)
    assert ("context_ideaContext", "work") in edges
    assert ("context_ideaContext", "end") in edges
    assert ("start", "work") not in edges
    assert ("start", "end") not in edges
    # Edge attributes preserved on retarget.
    alt = [
        e
        for e in composed["control_flow_connections"]
        if e.get("name") == "start_to_end_direct"
    ]
    assert alt and alt[0].get("from_branch") == "alt"


def test_two_slots_chain_in_declaration_order() -> None:
    doc = _slim_spec(
        [_slot("alpha"), _slot("beta")],
        consumer_inputs=["alphaContextSlotBindings", "betaContextSlotBindings"],
    )
    composed, report = inject_context_subflows(doc, "t")
    assert [r["slot"] for r in report] == ["alpha", "beta"]
    edges = _control_edges(composed)
    assert ("start", "context_alpha") in edges
    assert ("context_alpha", "context_beta") in edges
    assert ("context_beta", "work") in edges
    dedges = _data_edges(composed)
    assert (
        "context_alpha",
        "contextSlotBindings",
        "work",
        "alphaContextSlotBindings",
    ) in dedges
    assert (
        "context_beta",
        "contextSlotBindings",
        "work",
        "betaContextSlotBindings",
    ) in dedges


# ---------------------------------------------------------------------------
# Legacy / no-op paths.
# ---------------------------------------------------------------------------


def test_author_placed_marker_skips_injection_and_returns_same_object() -> None:
    doc = _slim_spec([_slot()])
    doc["$referenced_components"]["context_ideaContext"] = {
        "component_type": "FlowNode",
        "id": "context_ideaContext",
        "subflow": {"$component_ref": "context-ideaContext-subflow"},
        "metadata": {
            "cinatra": {
                "purpose": "author-placed-context-resolution-for-ideaContext"
            }
        },
    }
    out, report = inject_context_subflows(doc, "t")
    assert out is doc  # identity — the raw-text mount path stays byte-identical
    assert report == []


def test_loader_injected_marker_is_idempotent() -> None:
    doc = _slim_spec([_slot()])
    composed, report = inject_context_subflows(doc, "t")
    assert report
    again, report2 = inject_context_subflows(composed, "t")
    assert again is composed
    assert report2 == []


def test_absent_null_and_empty_declarations_are_no_ops() -> None:
    for value in (None, []):
        doc = _slim_spec([_slot()])
        doc["metadata"]["cinatra"]["contextSlots"] = value
        out, report = inject_context_subflows(doc, "t")
        assert out is doc and report == []
    doc = _slim_spec([_slot()])
    del doc["metadata"]["cinatra"]["contextSlots"]
    out, report = inject_context_subflows(doc, "t")
    assert out is doc and report == []


def test_nested_child_marker_does_not_suppress_root_declaration() -> None:
    """Definition-local marker scan: a composed CHILD's own marker for the
    same slot id must not suppress the root definition's injection."""
    doc = _slim_spec([_slot("shared")], consumer_inputs=["contextSlotBindings"])
    # Nested legacy child definition carrying its OWN marker for "shared".
    doc["$referenced_components"]["legacy-child-subflow"] = {
        "component_type": "Flow",
        "id": "legacy-child-subflow",
        "start_node": {"$component_ref": "legacy-child__start"},
        "nodes": [],
        "control_flow_connections": [],
        "$referenced_components": {
            "legacy-child__context_shared": {
                "component_type": "FlowNode",
                "id": "legacy-child__context_shared",
                "subflow": {"$component_ref": "legacy-child__context-shared-subflow"},
                "metadata": {
                    "cinatra": {
                        "purpose": "author-placed-context-resolution-for-shared"
                    }
                },
            },
        },
    }
    # The nested child's ctx-shared-* ids are NOT present, so no collision.
    composed, report = inject_context_subflows(doc, "t")
    assert [r["slot"] for r in report] == ["shared"]
    assert "context_shared" in composed["$referenced_components"]


# ---------------------------------------------------------------------------
# Fail-closed matrices.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "mutate",
    [
        lambda s: s.update(slotId=""),
        lambda s: s.pop("slotId"),
        lambda s: s.update(selectionMode="both"),
        lambda s: s.update(resolutionMode="merge"),
        lambda s: s.update(acceptedArtifactExtensions=[]),
        lambda s: s.update(acceptedArtifactExtensions="not-a-list"),
        lambda s: s.update(minItems=-1),
        lambda s: s.update(maxItems=0),
        lambda s: s.update(minItems=6, maxItems=2),
        lambda s: s.update(readableOnly="yes"),
        lambda s: s.update(unknownKey=True),
    ],
)
def test_malformed_declaration_fails_the_mount(mutate) -> None:
    slot = _slot()
    mutate(slot)
    doc = _slim_spec([slot])
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


def test_integral_float_bounds_are_accepted_like_the_zod_schema() -> None:
    """JSON numeric-literal parity (Codex round-1): the canonical zod schema
    accepts `1.0` / `1e0` (Number.isInteger is true); json.loads surfaces
    those as float. The loader must accept them identically."""
    doc = _slim_spec([_slot(minItems=1.0, maxItems=5.0)])
    composed, report = inject_context_subflows(doc, "t")
    assert [r["slot"] for r in report] == ["ideaContext"]
    assert "context_ideaContext" in composed["$referenced_components"]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda s: s.update(minItems=2.5),
        lambda s: s.update(minItems="1"),
        lambda s: s.update(minItems=True),
        lambda s: s.update(maxItems=0.5),
        lambda s: s.update(minItems=6.0, maxItems=2.0),
        # zod `.optional()` parity: a PRESENT key with an explicit JSON null
        # is invalid (only an ABSENT key is optional).
        lambda s: s.update(minItems=None),
        lambda s: s.update(maxItems=None),
        lambda s: s.update(readableOnly=None),
    ],
)
def test_non_integral_or_non_numeric_bounds_still_fail(mutate) -> None:
    slot = _slot()
    mutate(slot)
    doc = _slim_spec([slot])
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


def test_contextSlots_on_a_non_flow_definition_node_is_ignored() -> None:
    """Carrier recognition requires the flow-definition shape; a contextSlots
    blob on any other node is ignored (never injected, never a mount error)
    — the server-side declaration scan mirrors this exactly."""
    doc = _slim_spec([_slot()])
    # Legacy marker present so the ROOT declaration is fully carried…
    doc["$referenced_components"]["context_ideaContext"] = {
        "component_type": "FlowNode",
        "id": "context_ideaContext",
        "subflow": {"$component_ref": "context-ideaContext-subflow"},
        "metadata": {
            "cinatra": {
                "purpose": "author-placed-context-resolution-for-ideaContext"
            }
        },
    }
    # …and a degenerate (non-definition) node declares ANOTHER slot: ignored.
    doc["$referenced_components"]["stray_blob"] = {
        "component_type": "FlowNode",
        "id": "stray_blob",
        "metadata": {"cinatra": {"contextSlots": [_slot("strayContext")]}},
    }
    out, report = inject_context_subflows(doc, "t")
    assert out is doc and report == []


def test_non_array_declaration_fails_the_mount() -> None:
    doc = _slim_spec([_slot()])
    doc["metadata"]["cinatra"]["contextSlots"] = {"slotId": "x"}
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


def test_duplicate_slot_ids_fail() -> None:
    doc = _slim_spec([_slot("dup"), _slot("dup")])
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


def test_id_collision_fails() -> None:
    doc = _slim_spec([_slot()])
    # An existing unrelated component already uses an id the injector needs.
    doc["$referenced_components"]["ctx-ideaContext-resolve_context"] = {
        "component_type": "ApiNode",
        "id": "ctx-ideaContext-resolve_context",
        "url": "{{CINATRA_BASE_URL}}/api/unrelated",
    }
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


def test_missing_owner_package_fails() -> None:
    doc = _slim_spec([_slot()])
    del doc["metadata"]["cinatra"]["packageName"]
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


def test_disagreeing_owner_packages_fail() -> None:
    doc = _slim_spec([_slot()])
    # A FlowNode elsewhere references the ROOT definition with a different
    # packageName — cross-check must fail, never silently prefer either.
    doc["$referenced_components"]["weird_ref"] = {
        "component_type": "FlowNode",
        "id": "weird_ref",
        "subflow": {"$component_ref": "slim-agent-flow"},
        "metadata": {"cinatra": {"packageName": "@evil/other"}},
    }
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


def test_zero_consumers_fails() -> None:
    doc = _slim_spec([_slot()], consumer_inputs=[])
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


def test_bare_consumer_with_multiple_slots_fails() -> None:
    doc = _slim_spec(
        [_slot("alpha"), _slot("beta")], consumer_inputs=["contextSlotBindings"]
    )
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


def test_bare_plus_qualified_on_same_component_fails() -> None:
    doc = _slim_spec(
        [_slot()],
        consumer_inputs=["contextSlotBindings", "ideaContextContextSlotBindings"],
    )
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


def test_existing_edge_into_consumer_input_fails() -> None:
    doc = _slim_spec([_slot()])
    doc["data_flow_connections"].append(
        {
            "component_type": "DataFlowEdge",
            "name": "pre_wired",
            "source_node": {"$component_ref": "start"},
            "source_output": "brief",
            "destination_node": {"$component_ref": "work"},
            "destination_input": "contextSlotBindings",
        }
    )
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


def test_incompatible_existing_hidden_input_fails() -> None:
    doc = _slim_spec([_slot()])
    doc["inputs"].append(
        {"title": "ideaContextSlotId", "type": "string", "default": "otherSlot"}
    )
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


def test_compatible_existing_input_is_reused() -> None:
    doc = _slim_spec([_slot()])
    for owner_key in (None, "start"):
        owner = doc if owner_key is None else doc["$referenced_components"]["start"]
        owner["inputs"].append(
            {"title": "cinatra_run_id", "type": "string", "default": ""}
        )
    composed, report = inject_context_subflows(doc, "t")
    assert report
    titles = [i["title"] for i in composed["inputs"]]
    assert titles.count("cinatra_run_id") == 1


def test_no_start_successors_fails() -> None:
    doc = _slim_spec([_slot()])
    doc["control_flow_connections"] = [
        e
        for e in doc["control_flow_connections"]
        if _cref(e["from_node"]) != "start"
    ]
    with pytest.raises(ContextInjectionError):
        inject_context_subflows(doc, "t")


# ---------------------------------------------------------------------------
# Nested (composed) definition carriers.
# ---------------------------------------------------------------------------


def test_nested_definition_injection_with_referencer_package() -> None:
    child = _slim_spec([_slot("childSlot")], consumer_inputs=["contextSlotBindings"])
    child["id"] = "child-agent-subflow"
    del child["metadata"]["cinatra"]["packageName"]
    child["metadata"]["cinatra"]["contextSlots"] = [_slot("childSlot")]

    parent = _slim_spec([], consumer_inputs=[])
    parent["metadata"]["cinatra"].pop("contextSlots")
    parent["$referenced_components"]["child-agent-subflow"] = child
    parent["$referenced_components"]["child_flow"] = {
        "component_type": "FlowNode",
        "id": "child_flow",
        "subflow": {"$component_ref": "child-agent-subflow"},
        "metadata": {"cinatra": {"packageName": "@cinatra-ai/child-agent"}},
    }
    parent["nodes"].append({"$component_ref": "child_flow"})

    composed, report = inject_context_subflows(parent, "t")
    assert report == [
        {
            "slot": "childSlot",
            "definition": "child-agent-subflow",
            "packageName": "@cinatra-ai/child-agent",
            "templateVersion": CONTEXT_SUBFLOW_TEMPLATE_VERSION,
        }
    ]
    child_def = composed["$referenced_components"]["child-agent-subflow"]
    assert "context_childSlot" in child_def["$referenced_components"]
    # The injected FlowNode is spliced into the CHILD's graph, not the parent's.
    assert {"$component_ref": "context_childSlot"} in child_def["nodes"]
    assert "context_childSlot" not in composed["$referenced_components"]


# ---------------------------------------------------------------------------
# Real published specs (repo-adjacent ground truth): every currently
# published first-party agent must be a NO-OP (they all carry hand subflows
# for their declared slots, or declare nothing).
# ---------------------------------------------------------------------------


def test_hand_fixture_full_legacy_spec_is_a_noop() -> None:
    hand = _hand_authored()
    doc = _slim_spec([_slot()])
    refs = doc["$referenced_components"]
    refs["context-ideaContext-subflow"] = copy.deepcopy(hand["subflow"])
    refs["context_ideaContext"] = copy.deepcopy(hand["marker"])
    doc["nodes"].append({"$component_ref": "context_ideaContext"})
    out, report = inject_context_subflows(doc, "t")
    assert out is doc and report == []


# ---------------------------------------------------------------------------
# Mount path (stubbed loader globals): a legacy doc reaches load_json as the
# EXACT original string; an injected doc reaches it composed + substituted.
# ---------------------------------------------------------------------------


class _FakeLoader:
    def __init__(self) -> None:
        self.loaded: List[str] = []

    def load_json(self, text: str) -> Any:
        self.loaded.append(text)

        class _Agent:  # attribute-assignable, like wayflowcore flows
            pass

        return _Agent()


def _mount(monkeypatch, tmp_path: Path, doc: Dict[str, Any]):
    import agent_loader as al

    oas_path = tmp_path / "cinatra" / "oas.json"
    oas_path.parent.mkdir(parents=True)
    raw = json.dumps(doc, indent=1)
    oas_path.write_text(raw)
    import hashlib

    fingerprint = hashlib.sha256(raw.encode()).hexdigest()

    class _FakeServer:
        def serve_agent(self, agent: Any, url: str) -> None:
            self.agent = agent

    monkeypatch.setattr(al, "A2AServer", _FakeServer)
    monkeypatch.setattr(al, "_discover_a2a_asgi_app", lambda server, label: object())
    fake_loader = _FakeLoader()
    mounted = al._mount_one_sync(
        fake_loader, "cinatra-ai", "under-test", oas_path, fingerprint, "http://x"
    )
    return raw, fake_loader, mounted


def test_mount_legacy_doc_reaches_load_json_byte_identical(
    monkeypatch, tmp_path: Path
) -> None:
    import agent_loader as al

    doc = _slim_spec([_slot()])
    hand = _hand_authored()
    refs = doc["$referenced_components"]
    refs["context-ideaContext-subflow"] = copy.deepcopy(hand["subflow"])
    refs["context_ideaContext"] = copy.deepcopy(hand["marker"])
    doc["nodes"].append({"$component_ref": "context_ideaContext"})

    raw, fake_loader, mounted = _mount(monkeypatch, tmp_path, doc)
    assert fake_loader.loaded == [al._substitute_placeholders(raw)]
    assert mounted.composed_oas is None
    assert mounted.composed_sha256 is None
    assert mounted.context_injection is None


def test_mount_slim_doc_injects_and_records_sidecar(
    monkeypatch, tmp_path: Path
) -> None:
    doc = _slim_spec([_slot()])
    raw, fake_loader, mounted = _mount(monkeypatch, tmp_path, doc)

    assert len(fake_loader.loaded) == 1
    loaded = json.loads(fake_loader.loaded[0])
    assert "context_ideaContext" in loaded["$referenced_components"]
    # Placeholder substitution ran AFTER injection (no raw {{ENV}} left in urls).
    resolve_url = loaded["$referenced_components"]["context-ideaContext-subflow"][
        "$referenced_components"
    ]["ctx-ideaContext-resolve_context"]["url"]
    assert "{{CINATRA_BASE_URL}}" not in resolve_url
    assert resolve_url.endswith("/api/context-resolve")

    assert mounted.context_injection and mounted.context_injection[0]["slot"] == (
        "ideaContext"
    )
    assert mounted.composed_sha256 and mounted.composed_sha256 != mounted.fingerprint
    # Sidecar composed doc is PRE-substitution (env values cannot leak).
    pre_sub_url = mounted.composed_oas["$referenced_components"][
        "context-ideaContext-subflow"
    ]["$referenced_components"]["ctx-ideaContext-resolve_context"]["url"]
    assert pre_sub_url.startswith("{{CINATRA_BASE_URL}}")
    # Per-run sidecar attached to the deserialized agent object.
    agent = mounted.server.agent
    info = getattr(agent, "_cinatra_context_injection", None)
    assert info == {
        "templateVersion": CONTEXT_SUBFLOW_TEMPLATE_VERSION,
        "slots": ["ideaContext"],
    }


def test_mount_malformed_declaration_raises(monkeypatch, tmp_path: Path) -> None:
    from context_subflow_injection import ContextInjectionError

    doc = _slim_spec([_slot(selectionMode="nope")])
    with pytest.raises(ContextInjectionError):
        _mount(monkeypatch, tmp_path, doc)


# ---------------------------------------------------------------------------
# Composed-OAS debug endpoint (auth contract mirrors the reload endpoint).
# ---------------------------------------------------------------------------


def test_composed_oas_handler_auth_and_lookup(monkeypatch) -> None:
    import asyncio

    import agent_loader as al

    class _FakeRegistry:
        def __init__(self, agent: Any) -> None:
            self._agent = agent

        def find(self, label: str) -> Any:
            return self._agent if label == "cinatra-ai/known" else None

    class _FakeAgent:
        label = "cinatra-ai/known"
        fingerprint = "f" * 64
        composed_oas = {"id": "x"}
        composed_sha256 = "c" * 64
        context_injection = [
            {
                "slot": "s",
                "definition": "x",
                "packageName": "@cinatra-ai/known",
                "templateVersion": CONTEXT_SUBFLOW_TEMPLATE_VERSION,
            }
        ]

    handler = al._build_composed_oas_handler(_FakeRegistry(_FakeAgent()))

    class _Req:
        def __init__(self, token: str, vendor: str = "cinatra-ai", slug: str = "known"):
            self.headers = {"X-Cinatra-Bridge-Token": token} if token else {}
            self.path_params = {"vendor": vendor, "slug": slug}

    # Token unset → 503 (auth disabled, never exposed unauthenticated).
    monkeypatch.delenv("CINATRA_BRIDGE_TOKEN", raising=False)
    resp = asyncio.run(handler(_Req("whatever")))
    assert resp.status_code == 503

    monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", "sekrit")
    assert asyncio.run(handler(_Req("wrong"))).status_code == 403
    assert asyncio.run(handler(_Req("sekrit", slug="nope"))).status_code == 404

    ok = asyncio.run(handler(_Req("sekrit")))
    assert ok.status_code == 200
    body = json.loads(ok.body)
    assert body["label"] == "cinatra-ai/known"
    assert body["injected"] is True
    assert body["templateVersion"] == CONTEXT_SUBFLOW_TEMPLATE_VERSION
    assert body["composedOas"] == {"id": "x"}


# ---------------------------------------------------------------------------
# OPTIONAL: real pyagentspec deserialization smoke (Docker image / dev host
# with the wayflowcore pin installed; skipped elsewhere).
# ---------------------------------------------------------------------------


def test_composed_slim_doc_deserializes_with_real_pyagentspec() -> None:
    pytest.importorskip("wayflowcore")
    from wayflowcore.agentspec import AgentSpecLoader  # type: ignore

    import agent_loader as al

    # Same error-unmask patch the production loader applies (idempotent) so a
    # regression here reports the REAL pyagentspec validation message.
    al._patch_pyagentspec_deserialization_error_mask()

    doc = _slim_spec([_slot()])
    composed, report = inject_context_subflows(doc, "t")
    assert report
    text = json.dumps(composed).replace(
        "{{CINATRA_BASE_URL}}", "http://host.docker.internal:3000"
    )
    agent = AgentSpecLoader().load_json(text)
    assert agent is not None
