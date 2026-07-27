"""Both-mount-path HITL gate contract guard (cinatra#2140).

The SAME approval gate exists in two encodings, and until now nothing asserted
they agree:

* **STANDALONE** — the agent package's own ``cinatra/oas.json``, mounted by the
  WayFlow container as its own A2A agent at ``/agents/<vendor>/<slug>/``. It is
  authored in the ruled cinatra HITL form: ``component_type:"InputMessageNode"``
  with declared ``inputs`` fed by a ``DataFlowEdge`` (the host ``oas-compiler``
  pins that literal and reads those declared inputs to drive the renderer).
  pyagentspec 26.1.2 REJECTS that form on its own — it derives an
  ``InputMessageNode``'s expected inputs solely from ``{{placeholder}}`` tokens
  in ``message`` — so the container's load-time shim
  ``agent_loader._reconcile_input_message_gates`` (cinatra#1830) reconciles it to
  ``PluginInputMessageNode`` + a synthesized ``message_template`` before
  ``AgentSpecLoader`` ever sees it.

* **ORCHESTRATED** — the same gate inlined as a subflow of
  ``email-outreach-agent``. Those inlined copies declare NO gate ``inputs``, so
  they mount NATIVELY and never touch the shim.

Because the two encodings travel different code, either side can move without
the other noticing — which is exactly how cinatra#2140 was reported (the
standalone form fails a bare ``AgentSpecLoader().load_json()``; the orchestrated
form does not). This module pins BOTH paths against the same ruled contract:

1. each standalone package mounts through the real pre-load pipeline, and the
   shim demonstrably fired on its gate;
2. the same standalone OAS is REJECTED by a bare load, with the documented
   message — so if pyagentspec ever starts accepting declared gate inputs (or an
   author "fixes" the OAS into the native form), this fails visibly;
3. the orchestrator mounts through the pipeline AND bare — its inlined gate
   copies need no shim;
4. every ``InputMessageNode`` in the discovered tree satisfies the ruled
   contract (native, or in a shape the shim can repair, with exactly one
   output);
5. the shim's repairability rules match what the pinned runtime actually does —
   the same case table the host validator encodes as ``OAS-RUNTIME-013``
   (``packages/agents/src/validate-oas-runtime-invariants.ts``). If either side
   moves, one of these fails.

Contract citation: ``docs/internals/workflows/agent-run-hitl-prompt-primitives.md``
§ "Pinned-runtime contract for the gate node (cinatra#1830)".

Runs only where wayflowcore + pyagentspec are installed (i.e. inside the wayflow
image). Skipped otherwise, exactly like the sibling mount guards.
"""

from __future__ import annotations

import copy
import json
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Tuple

import pytest

# --------------------------------------------------------------------------
# Discovery — the same two-level walk the runtime uses, but WITHOUT the
# published-marker gate. This module asserts OAS *shape and mountability*, not
# publish state; marker gating is `test_repo_agents_load`'s business. Keeping
# them decoupled means a freshly cloned (unmarked) extension tree still gets
# checked instead of silently discovering nothing.
# --------------------------------------------------------------------------

_ENV_DIR = os.environ.get("CINATRA_AGENTS_DIR")
_HERE = Path(__file__).resolve()
_REPO_ROOT = _HERE.parents[3] if len(_HERE.parents) > 3 else None
if _ENV_DIR:
    AGENTS_DIR = Path(_ENV_DIR)
elif _REPO_ROOT is not None:
    AGENTS_DIR = _REPO_ROOT / "extensions"
else:
    AGENTS_DIR = Path("/__no_agents_dir__")

try:
    from wayflowcore.agentspec import AgentSpecLoader  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — runs only inside the container
    AgentSpecLoader = None  # type: ignore[assignment]

try:
    import agent_loader  # type: ignore[import-not-found]
except Exception:  # pragma: no cover
    agent_loader = None  # type: ignore[assignment]

try:
    from context_subflow_injection import inject_context_subflows  # type: ignore[import-not-found]
except Exception:  # pragma: no cover
    inject_context_subflows = None  # type: ignore[assignment]

_RUNTIME_AVAILABLE = AgentSpecLoader is not None and agent_loader is not None

pytestmark = pytest.mark.skipif(
    not _RUNTIME_AVAILABLE,
    reason="wayflowcore/agent_loader not importable (run inside the wayflow image)",
)

# Mirrors `_GATE_INPUT_TITLE_RE` in agent_loader.py and `GATE_INPUT_TITLE_RE`
# in packages/agents/src/validate-oas-runtime-invariants.ts.
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

# The two agents cinatra#2140 names, with the gate + declared input the pinned
# runtime rejects unreconciled. Keyed by slug so an absent tree (the works-after
# single-fixture mount) skips instead of false-failing.
_STANDALONE_GATE_AGENTS: Dict[str, Tuple[str, str]] = {
    "email-drafting-agent": ("approval_gate", "draftBundle"),
    "email-recipient-selection-agent": ("approval_gate", "confirmedRecipients"),
}
_ORCHESTRATOR = "email-outreach-agent"
#: The orchestrator's INLINED copies of the same two gates. Named explicitly so
#: the orchestrated assertions cannot pass vacuously if the gates disappear, and
#: so an unrelated future declared-input gate elsewhere in the orchestrator does
#: not red this suite.
_ORCHESTRATED_GATE_IDS = ("recipients-review_gate", "drafts-approval_gate")


def _oas_path(slug: str) -> Path:
    return AGENTS_DIR / "cinatra-ai" / slug / "cinatra" / "oas.json"


def _require(slug: str) -> Path:
    path = _oas_path(slug)
    if not path.is_file():
        pytest.skip(f"{slug} not present under {AGENTS_DIR} (shallow/fixture mount)")
    return path


def _discover_oas() -> List[Tuple[str, Path]]:
    """`<agents_dir>/<vendor>/<slug>/cinatra/oas.json`, keyed by disk slug."""
    out: List[Tuple[str, Path]] = []
    if not AGENTS_DIR.is_dir():
        return out
    for vendor in sorted(AGENTS_DIR.iterdir()):
        if vendor.name.startswith(".") or not vendor.is_dir():
            continue
        for slug in sorted(vendor.iterdir()):
            if slug.name.startswith(".") or not slug.is_dir():
                continue
            oas = slug / "cinatra" / "oas.json"
            if oas.is_file():
                out.append((f"{vendor.name}/{slug.name}", oas))
    return out


def _preload(doc: Dict[str, Any], label: str) -> Tuple[str, List[Dict[str, Any]]]:
    """The container's real pre-``load_json`` pipeline: context-subflow
    injection → HITL gate reconcile → env substitution. Returns the substituted
    text plus the gate-reconcile report."""
    working = copy.deepcopy(doc)
    if inject_context_subflows is not None:
        composed, report = inject_context_subflows(working, label)
        if report:
            working = composed
    gate_report = agent_loader._reconcile_input_message_gates(working, label)
    return agent_loader._substitute_placeholders(json.dumps(working)), gate_report


def _bare(doc: Dict[str, Any]) -> str:
    """Env substitution ONLY — no injection, no gate reconcile. This is what a
    consumer that skips the container's pre-load pipeline sees."""
    return agent_loader._substitute_placeholders(json.dumps(doc))


def _iter_gates(doc: Any):
    """Yield every InputMessageNode / PluginInputMessageNode object, at any
    depth — the same walk the shim does, so an inlined subflow gate is reached."""
    if isinstance(doc, dict):
        if doc.get("component_type") in ("InputMessageNode", "PluginInputMessageNode"):
            yield doc
        for value in doc.values():
            yield from _iter_gates(value)
    elif isinstance(doc, list):
        for item in doc:
            yield from _iter_gates(item)


# --------------------------------------------------------------------------
# 1 + 2 — the STANDALONE path.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("slug", sorted(_STANDALONE_GATE_AGENTS))
def test_standalone_package_mounts_through_the_real_pipeline(slug: str) -> None:
    """AC1: each named agent standalone-mounts cleanly at its current pin."""
    doc = json.loads(_require(slug).read_text(encoding="utf-8"))
    gate_id, declared_input = _STANDALONE_GATE_AGENTS[slug]

    substituted, gate_report = _preload(doc, slug)
    reconciled = {entry["node"]: entry for entry in gate_report}
    assert gate_id in reconciled, (
        f"{slug}: expected the loader shim to reconcile gate {gate_id!r}; "
        f"report={gate_report!r}. If the OAS moved to the native (no declared "
        f"inputs) encoding, update _STANDALONE_GATE_AGENTS — do NOT delete this "
        f"assertion, it is what keeps the two encodings honest."
    )
    assert declared_input in reconciled[gate_id]["inputs"]

    assert AgentSpecLoader().load_json(substituted) is not None


@pytest.mark.parametrize("slug", sorted(_STANDALONE_GATE_AGENTS))
def test_standalone_authored_form_is_rejected_without_the_shim(slug: str) -> None:
    """Pins the pinned-runtime half of the contract: the authored declared-input
    gate is REJECTED by a bare load. This is the failure cinatra#2140 reported —
    it is what a mount path that skips the container's pre-load pipeline sees,
    and it is expected, not a defect in the OAS."""
    doc = json.loads(_require(slug).read_text(encoding="utf-8"))
    _gate_id, declared_input = _STANDALONE_GATE_AGENTS[slug]

    agent_loader._patch_pyagentspec_deserialization_error_mask()
    with pytest.raises(Exception) as excinfo:
        AgentSpecLoader().load_json(_bare(doc))
    message = str(excinfo.value)
    assert "did not expect any properties" in message, message
    assert declared_input in message, message


# --------------------------------------------------------------------------
# 3 — the ORCHESTRATED path.
# --------------------------------------------------------------------------


def test_orchestrator_mounts_through_the_real_pipeline() -> None:
    doc = json.loads(_require(_ORCHESTRATOR).read_text(encoding="utf-8"))
    substituted, _report = _preload(doc, _ORCHESTRATOR)
    assert AgentSpecLoader().load_json(substituted) is not None


def test_orchestrated_inlined_gates_need_no_shim() -> None:
    """The orchestrator's inlined copies of the same gates use the NATIVE (no
    declared inputs) encoding, so they mount without the shim. Asserting this
    explicitly is what makes a future drift on EITHER side visible: if the
    inlined copies grow declared inputs, this fails here; if the standalone
    packages lose theirs, the standalone tests above fail."""
    doc = json.loads(_require(_ORCHESTRATOR).read_text(encoding="utf-8"))

    # The gates must actually BE there — otherwise deleting them would make
    # every assertion below pass vacuously.
    present = {
        gate.get("id")
        for gate in _iter_gates(doc)
        if gate.get("id") in _ORCHESTRATED_GATE_IDS
    }
    assert present == set(_ORCHESTRATED_GATE_IDS), (
        f"{_ORCHESTRATOR} no longer inlines {sorted(set(_ORCHESTRATED_GATE_IDS) - present)}. "
        "The orchestrated encoding of the #2140 gates is what this suite pins "
        "against the standalone one — re-point _ORCHESTRATED_GATE_IDS deliberately."
    )

    _substituted, gate_report = _preload(doc, _ORCHESTRATOR)
    drifted = [
        entry for entry in gate_report if entry["node"] in _ORCHESTRATED_GATE_IDS
    ]
    assert drifted == [], (
        f"{_ORCHESTRATOR}'s inlined gates now need the reconcile shim "
        f"({drifted!r}) — the orchestrated encoding drifted toward the "
        "standalone one. Reconcile the two deliberately, then update this test."
    )

    assert AgentSpecLoader().load_json(_bare(doc)) is not None


# --------------------------------------------------------------------------
# 4 — tree-wide: the same rule the host validator (OAS-RUNTIME-013) enforces.
# --------------------------------------------------------------------------


def _contract_violations(doc: Any) -> List[str]:
    problems: List[str] = []
    for gate in _iter_gates(doc):
        label = gate.get("id") or gate.get("name") or "<unnamed>"
        if gate.get("component_type") == "PluginInputMessageNode":
            problems.append(
                f"{label}: authored as PluginInputMessageNode — the host compiler "
                f"pins the InputMessageNode literal, so the gate is invisible to it"
            )
            continue
        # Only an EXPLICIT outputs array is judged: an ABSENT field is defaulted
        # by the runtime and mounts (the host compiler rejects it separately).
        outputs = gate.get("outputs")
        if isinstance(outputs, list):
            if len(outputs) > 1:
                problems.append(f"{label}: {len(outputs)} outputs (a gate returns exactly one)")
            elif not outputs:
                problems.append(f"{label}: empty outputs[] (a gate returns exactly one string)")
            else:
                only = outputs[0]
                declared_type = only.get("type") if isinstance(only, dict) else None
                if isinstance(declared_type, str) and declared_type != "string":
                    problems.append(
                        f"{label}: single output declared as type {declared_type!r} "
                        f"(the resume payload must be a string)"
                    )
        inputs = gate.get("inputs")
        if not isinstance(inputs, list) or not inputs:
            continue  # native encoding — nothing for the shim to repair
        # Python truthiness on purpose — this IS the shim's own test, and a falsy
        # message_template is overwritten by the synthesized one (still mounts).
        if gate.get("message_template"):
            problems.append(
                f"{label}: declares inputs AND a truthy author-supplied "
                f"message_template (the shim skips an already-templated gate)"
            )
            continue
        titles = [i.get("title") if isinstance(i, dict) else None for i in inputs]
        if not all(isinstance(t, str) and _IDENT.fullmatch(t) for t in titles):
            problems.append(f"{label}: input titles are not all plain identifiers ({titles!r})")
            continue
        if len(set(titles)) != len(titles):
            problems.append(f"{label}: duplicate input titles ({titles!r})")
    return problems


def test_every_discovered_gate_satisfies_the_ruled_contract() -> None:
    discovered = _discover_oas()
    if not discovered:
        pytest.skip(f"no oas.json discovered under {AGENTS_DIR}")
    failures: List[str] = []
    for label, path in discovered:
        doc = json.loads(path.read_text(encoding="utf-8"))
        for problem in _contract_violations(doc):
            failures.append(f"{label}: {problem}")
    assert not failures, (
        "HITL gate(s) the pinned WayFlow runtime cannot mount:\n  "
        + "\n  ".join(failures)
        + "\nSame rule as OAS-RUNTIME-013 in "
        "packages/agents/src/validate-oas-runtime-invariants.ts."
    )


# --------------------------------------------------------------------------
# 5 — the repairability case table, asserted against the REAL runtime.
#
# The host validator encodes this table as OAS-RUNTIME-013. If pyagentspec (or
# the shim) ever changes what it accepts, these fail here first — which is the
# signal to move the host rule in lockstep rather than let the two drift.
# --------------------------------------------------------------------------

_PROBE_FLOW: Dict[str, Any] = {
    "agentspec_version": "26.1.0",
    "component_type": "Flow",
    "id": "probe_flow",
    "name": "Probe flow",
    "metadata": {"cinatra": {"packageName": "@cinatra-ai/probe-agent"}},
    "inputs": [{"title": "seed", "type": "string"}],
    "outputs": [{"title": "userResponse", "type": "string"}],
    "start_node": {"$component_ref": "start"},
    "nodes": [
        {"$component_ref": "start"},
        {"$component_ref": "gate"},
        {"$component_ref": "end"},
    ],
    "control_flow_connections": [
        {
            "component_type": "ControlFlowEdge",
            "name": "s2g",
            "from_node": {"$component_ref": "start"},
            "to_node": {"$component_ref": "gate"},
        },
        {
            "component_type": "ControlFlowEdge",
            "name": "g2e",
            "from_node": {"$component_ref": "gate"},
            "to_node": {"$component_ref": "end"},
        },
    ],
    "data_flow_connections": [
        {
            "component_type": "DataFlowEdge",
            "name": "s2g_seed",
            "source_node": {"$component_ref": "start"},
            "source_output": "seed",
            "destination_node": {"$component_ref": "gate"},
            "destination_input": "payload",
        },
        {
            "component_type": "DataFlowEdge",
            "name": "g2e_userResponse",
            "source_node": {"$component_ref": "gate"},
            "source_output": "userResponse",
            "destination_node": {"$component_ref": "end"},
            "destination_input": "userResponse",
        },
    ],
    "$referenced_components": {
        "start": {
            "component_type": "StartNode",
            "id": "start",
            "name": "Start",
            "inputs": [{"title": "seed", "type": "string"}],
        },
        "end": {
            "component_type": "EndNode",
            "id": "end",
            "name": "End",
            "outputs": [{"title": "userResponse", "type": "string"}],
        },
        "gate": {
            "component_type": "InputMessageNode",
            "id": "gate",
            "name": "Gate",
            "inputs": [{"title": "payload", "type": "string"}],
            "outputs": [{"title": "userResponse", "type": "string"}],
        },
    },
}


def _probe(mutate=None, *, reconcile: bool = True) -> Tuple[bool, str]:
    doc = copy.deepcopy(_PROBE_FLOW)
    if mutate is not None:
        mutate(doc)
    if reconcile:
        agent_loader._reconcile_input_message_gates(doc, "probe")
    agent_loader._patch_pyagentspec_deserialization_error_mask()
    try:
        AgentSpecLoader().load_json(agent_loader._substitute_placeholders(json.dumps(doc)))
        return True, ""
    except Exception as exc:  # noqa: BLE001 — the message IS the assertion
        return False, str(exc)


def test_canonical_declared_input_gate_mounts_only_with_the_shim() -> None:
    ok, _ = _probe()
    assert ok, "the canonical authored gate form must mount after the reconcile shim"
    ok_bare, message = _probe(reconcile=False)
    assert not ok_bare
    assert "did not expect any properties" in message and "payload" in message, message


def test_non_identifier_input_title_is_unmountable() -> None:
    def mutate(doc: Dict[str, Any]) -> None:
        doc["$referenced_components"]["gate"]["inputs"] = [{"title": "pay-load", "type": "string"}]
        doc["data_flow_connections"][0]["destination_input"] = "pay-load"

    ok, message = _probe(mutate)
    assert not ok and "did not expect any properties" in message, message


def test_duplicate_input_titles_are_unmountable() -> None:
    def mutate(doc: Dict[str, Any]) -> None:
        doc["$referenced_components"]["gate"]["inputs"] = [
            {"title": "payload", "type": "string"},
            {"title": "payload", "type": "string"},
        ]

    ok, message = _probe(mutate)
    assert not ok and "same title" in message, message


def test_author_supplied_message_template_blocks_the_shim() -> None:
    def mutate(doc: Dict[str, Any]) -> None:
        doc["$referenced_components"]["gate"]["message_template"] = "hello"

    ok, message = _probe(mutate)
    assert not ok and "did not expect any properties" in message, message


@pytest.mark.parametrize("falsy", [None, False, 0, "", [], {}], ids=repr)
def test_falsy_message_template_is_overwritten_and_still_mounts(falsy: Any) -> None:
    """Deliberate NON-blocker: the shim's "already templated?" test is Python
    truthiness (``bool(obj.get("message_template"))``), so a falsy value is
    OVERWRITTEN and the gate mounts. The host rule (OAS-RUNTIME-013) mirrors this
    with an explicit Python-truthiness helper rather than JS truthiness — this is
    the case table that keeps the two honest."""
    def mutate(doc: Dict[str, Any]) -> None:
        doc["$referenced_components"]["gate"]["message_template"] = falsy

    ok, message = _probe(mutate)
    assert ok, message


def test_empty_outputs_gate_is_unmountable() -> None:
    def mutate(doc: Dict[str, Any]) -> None:
        doc["$referenced_components"]["gate"]["outputs"] = []
        doc["data_flow_connections"] = [doc["data_flow_connections"][0]]
        doc["outputs"] = []
        doc["$referenced_components"]["end"]["outputs"] = []

    ok, message = _probe(mutate)
    assert not ok and "user_provided_input" in message, message


def test_non_string_single_output_is_unmountable() -> None:
    def mutate(doc: Dict[str, Any]) -> None:
        typed = [{"title": "userResponse", "type": "object"}]
        doc["$referenced_components"]["gate"]["outputs"] = typed
        doc["$referenced_components"]["end"]["outputs"] = typed
        doc["outputs"] = typed

    ok, message = _probe(mutate)
    assert not ok and "Expected an output of type string" in message, message


def test_absent_outputs_field_still_mounts() -> None:
    """Deliberate NON-blocker on the MOUNT rule: pyagentspec defaults an absent
    ``outputs`` field, so OAS-RUNTIME-013 must not claim it is unmountable. (The
    host compiler rejects it separately as MISSING_INPUT_MESSAGE_OUTPUT.)"""
    def mutate(doc: Dict[str, Any]) -> None:
        doc["$referenced_components"]["gate"].pop("outputs", None)
        doc["data_flow_connections"] = [doc["data_flow_connections"][0]]
        doc["outputs"] = []
        doc["$referenced_components"]["end"]["outputs"] = []

    ok, message = _probe(mutate)
    assert ok, message


def test_declared_inputs_alongside_a_message_still_mount() -> None:
    """Deliberate NON-blocker: a `message` (unlike `message_template`) does not
    stop the shim, so the host rule must not reject it either."""
    def mutate(doc: Dict[str, Any]) -> None:
        doc["$referenced_components"]["gate"]["message"] = "Please review {{ payload }}"

    ok, message = _probe(mutate)
    assert ok, message


def test_multi_output_gate_is_unmountable_on_both_encodings() -> None:
    def with_inputs(doc: Dict[str, Any]) -> None:
        doc["$referenced_components"]["gate"]["outputs"] = [
            {"title": "userResponse", "type": "string"},
            {"title": "excludedIds", "type": "string"},
        ]

    ok, message = _probe(with_inputs)
    assert not ok and "excludedIds" in message, message

    def native(doc: Dict[str, Any]) -> None:
        gate = doc["$referenced_components"]["gate"]
        gate.pop("inputs", None)
        doc["data_flow_connections"].pop(0)
        gate["outputs"] = [
            {"title": "userResponse", "type": "string"},
            {"title": "excludedIds", "type": "string"},
        ]

    ok_native, message_native = _probe(native)
    assert not ok_native and "excludedIds" in message_native, message_native
