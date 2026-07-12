"""cinatra#1194 — loader-owned context-subflow injection.

Agent authors declare only ``metadata.cinatra.contextSlots``; the loader
injects the canonical 8-node context-resolution subflow at mount time from
the single in-repo template (``context_subflow_template.json``) that versions
together with the server routes it calls (/api/context-resolve,
/api/context-finalize) and the server-side verifier
(src/lib/artifacts/context-attestation.ts — the declaration re-anchor keys
off the SAME deterministic id grammar rendered here).

Replaces the hand-copied per-agent subflow (``context-<slotId>-subflow`` +
the ``author-placed-context-resolution-for-<slotId>`` marker FlowNode) whose
copied grammar had no generator, validator, or lint — an authoring error
surfaced only as an undiagnosable runtime 403, and a server-route change
required re-releasing every agent in lockstep.

Legacy compatibility: a definition that already carries a marker (author-
placed OR loader-injected) for a declared slot is left untouched — the four
first-party leaf agents and every compiled orchestrator keep mounting
byte-identically until their owner-gated re-release to the slim format.

Fail posture (converged with Codex, 2026-07-10):
  - absent / null / empty ``contextSlots`` → no-op;
  - PRESENT-but-malformed declaration → ``ContextInjectionError`` → the
    agent's mount fails loudly (recorded in /.health failed_agents). The
    declaration is executable loader input here, not a read-only discovery
    hint, so the TS reader's fail-quiet [] posture does NOT apply;
  - any error injecting a VALID declaration (id collision anywhere in the
    document, missing/ambiguous owner package, unsupported definition shape,
    no start successors, consumer ambiguity, zero consumers) → mount error.

All ids follow the EXISTING grammar (``context-<slotId>-subflow``,
``context_<slotId>``, ``ctx-<slotId>-<kind>``): the runtime attestation
minter signs the executing ApiCallStep's OWN id, and the server re-anchors
that id either to the legacy marker structure or — for declaration-only
specs on the run-token path — to this grammar + the declaration.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

#: Bumped whenever the template content changes. Logged at mount and per run,
#: exposed on the composed-OAS debug view, so an operator can always tell
#: WHICH template produced the graph a run executed.
CONTEXT_SUBFLOW_TEMPLATE_VERSION = "1"

AUTHOR_PLACED_PURPOSE_PREFIX = "author-placed-context-resolution-for-"
LOADER_INJECTED_PURPOSE_PREFIX = "loader-injected-context-resolution-for-"

_SLOT_TOKEN = "__SLOT__"
_TEMPLATE_PATH = Path(__file__).resolve().parent / "context_subflow_template.json"

_SELECTION_MODES = {"interactive", "autonomous"}
_RESOLUTION_MODES = {"override", "accumulate"}
_ALLOWED_SLOT_KEYS = {
    "slotId",
    "acceptedArtifactExtensions",
    "selectionMode",
    "resolutionMode",
    "minItems",
    "maxItems",
    "readableOnly",
}


class ContextInjectionError(ValueError):
    """A declared context slot could not be injected — the mount must fail."""


# ---------------------------------------------------------------------------
# Template rendering.
# ---------------------------------------------------------------------------

_template_cache: Optional[Dict[str, Any]] = None


def _load_template() -> Dict[str, Any]:
    global _template_cache
    if _template_cache is None:
        with open(_TEMPLATE_PATH, "r", encoding="utf-8") as fh:
            _template_cache = json.load(fh)
    return _template_cache


def _render(value: Any, slot_id: str) -> Any:
    """Recursively substitute the slot token through the parsed template.

    Structured object walk (never textual JSON replacement) so a slot id
    containing JSON metacharacters cannot corrupt the document.
    """
    if isinstance(value, str):
        return value.replace(_SLOT_TOKEN, slot_id)
    if isinstance(value, list):
        return [_render(item, slot_id) for item in value]
    if isinstance(value, dict):
        return {_render(k, slot_id): _render(v, slot_id) for k, v in value.items()}
    return value


def _assert_fully_rendered(value: Any) -> None:
    if isinstance(value, str):
        if _SLOT_TOKEN in value:
            raise ContextInjectionError(
                "context-subflow template rendering left an unsubstituted "
                f"{_SLOT_TOKEN} placeholder"
            )
        return
    if isinstance(value, list):
        for item in value:
            _assert_fully_rendered(item)
        return
    if isinstance(value, dict):
        for k, v in value.items():
            _assert_fully_rendered(k)
            _assert_fully_rendered(v)


def _validate_slot_id(slot_id: Any) -> str:
    if not isinstance(slot_id, str) or not slot_id:
        raise ContextInjectionError("contextSlots entry has a missing/empty slotId")
    if _SLOT_TOKEN in slot_id:
        raise ContextInjectionError(
            f"slotId {slot_id!r} contains the reserved template token"
        )
    return slot_id


def build_context_subflow(slot_id: str) -> Dict[str, Any]:
    """Render the canonical context-resolution subflow definition for a slot.

    Byte-parity with the hand-authored format is asserted by
    tests/test_context_subflow_injection.py against the checked-in fixture.
    """
    _validate_slot_id(slot_id)
    rendered = _render(copy.deepcopy(_load_template()["subflow"]), slot_id)
    _assert_fully_rendered(rendered)
    return rendered


def build_context_flow_node(slot_id: str) -> Dict[str, Any]:
    """Render the loader-injected owner FlowNode for a slot.

    Differs from the legacy author-placed marker ONLY in
    ``metadata.cinatra.purpose`` (``loader-injected-…``) plus a
    ``templateVersion`` stamp — provenance is explicit in the composed-OAS
    debug view, and the injector's own idempotency check recognizes it.
    """
    _validate_slot_id(slot_id)
    rendered = _render(copy.deepcopy(_load_template()["flow_node"]), slot_id)
    _assert_fully_rendered(rendered)
    rendered["metadata"]["cinatra"]["templateVersion"] = (
        CONTEXT_SUBFLOW_TEMPLATE_VERSION
    )
    return rendered


def _injected_component_ids(slot_id: str) -> List[str]:
    """Every id the injection of ``slot_id`` introduces (collision set)."""
    kinds = [
        "start",
        "resolve_context",
        "select_mode",
        "emit_context_payload",
        "context_select_gate",
        "finalize_interactive",
        "finalize_autonomous",
        "end",
    ]
    return [
        f"context-{slot_id}-subflow",
        f"context_{slot_id}",
        *[f"ctx-{slot_id}-{kind}" for kind in kinds],
    ]


# ---------------------------------------------------------------------------
# Declaration reading (STRICT — executable loader input, mirrors the TS
# reader's schema but fails LOUD instead of quiet).
# ---------------------------------------------------------------------------


def _metadata_cinatra(node: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    meta = node.get("metadata")
    if not isinstance(meta, dict):
        return None
    cin = meta.get("cinatra")
    return cin if isinstance(cin, dict) else None


def _is_flow_definition(node: Dict[str, Any]) -> bool:
    """Mirror of the server walkers' isFlowDefinition."""
    return isinstance(node.get("id"), str) and (
        isinstance(node.get("$referenced_components"), dict)
        or isinstance(node.get("start_node"), (str, dict))
        or isinstance(node.get("nodes"), list)
    )


def _is_integral_number(value: Any) -> bool:
    """JSON-numeric-literal parity with the canonical zod schema (Codex
    round-1): ``z.number().int()`` accepts ``1.0`` / ``1e0`` (Number.isInteger
    is true), but ``json.loads`` surfaces those as ``float``. Accept ints and
    integral floats; reject bools (a Python ``bool`` IS an ``int``) and
    non-integral / non-finite floats."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and value.is_integer()


def _validate_declared_slots(raw: Any, where: str) -> List[Dict[str, Any]]:
    """Strictly validate a PRESENT contextSlots value.

    Mirrors packages/extensions/src/agent-context-slots-reader.ts
    (strict keys, enum modes, minItems<=maxItems) plus loader-level
    duplicate-slotId rejection. Raises ContextInjectionError on ANY
    malformation — a present declaration is executable input.
    """
    if not isinstance(raw, list):
        raise ContextInjectionError(
            f"{where}: metadata.cinatra.contextSlots must be an array"
        )
    slots: List[Dict[str, Any]] = []
    seen: set = set()
    for i, entry in enumerate(raw):
        loc = f"{where}: contextSlots[{i}]"
        if not isinstance(entry, dict):
            raise ContextInjectionError(f"{loc} is not an object")
        unknown = set(entry.keys()) - _ALLOWED_SLOT_KEYS
        if unknown:
            raise ContextInjectionError(
                f"{loc} has unknown key(s): {sorted(unknown)}"
            )
        slot_id = _validate_slot_id(entry.get("slotId"))
        if slot_id in seen:
            raise ContextInjectionError(f"{loc}: duplicate slotId {slot_id!r}")
        seen.add(slot_id)
        exts = entry.get("acceptedArtifactExtensions")
        if (
            not isinstance(exts, list)
            or not exts
            or not all(isinstance(e, str) and e for e in exts)
        ):
            raise ContextInjectionError(
                f"{loc}: acceptedArtifactExtensions must be a non-empty "
                "array of non-empty strings"
            )
        if entry.get("selectionMode") not in _SELECTION_MODES:
            raise ContextInjectionError(f"{loc}: invalid selectionMode")
        if entry.get("resolutionMode") not in _RESOLUTION_MODES:
            raise ContextInjectionError(f"{loc}: invalid resolutionMode")
        # Optional-field semantics mirror zod `.optional()` exactly (Codex
        # round-2): an ABSENT key is fine, but a PRESENT key must validate —
        # an explicit JSON `null` is invalid, so key presence is checked
        # separately from the value (`entry.get` would conflate the two).
        min_items = entry.get("minItems")
        if "minItems" in entry and (
            not _is_integral_number(min_items) or min_items < 0
        ):
            raise ContextInjectionError(f"{loc}: invalid minItems")
        max_items = entry.get("maxItems")
        if "maxItems" in entry and (
            not _is_integral_number(max_items) or max_items < 1
        ):
            raise ContextInjectionError(f"{loc}: invalid maxItems")
        if (
            _is_integral_number(min_items)
            and _is_integral_number(max_items)
            and min_items > max_items
        ):
            raise ContextInjectionError(f"{loc}: minItems must be <= maxItems")
        if "readableOnly" in entry and not isinstance(
            entry["readableOnly"], bool
        ):
            raise ContextInjectionError(f"{loc}: invalid readableOnly")
        slots.append(entry)
    return slots


# ---------------------------------------------------------------------------
# Document scanning.
# ---------------------------------------------------------------------------


def _collect_all_ids(doc: Any) -> set:
    """Every ``id`` string and every $referenced_components key in the tree."""
    ids: set = set()

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        node_id = node.get("id")
        if isinstance(node_id, str):
            ids.add(node_id)
        refs = node.get("$referenced_components")
        if isinstance(refs, dict):
            ids.update(k for k in refs.keys() if isinstance(k, str))
        for value in node.values():
            walk(value)

    walk(doc)
    return ids


def _definition_local_marker_slots(definition: Dict[str, Any]) -> set:
    """Slot ids carrying a context-resolution marker DIRECTLY owned by this
    definition.

    Definition-LOCAL: the scan does NOT descend into nested Flow definitions,
    so a composed child's own marker for slot S can never suppress the
    parent definition's injection of its own S (Codex round-0, decision 3).
    Both marker families (author-placed + loader-injected) count.
    """
    slots: set = set()

    def scan(node: Any, is_definition_root: bool) -> None:
        if isinstance(node, list):
            for item in node:
                scan(item, False)
            return
        if not isinstance(node, dict):
            return
        if not is_definition_root and _is_flow_definition(node):
            return  # nested definition boundary — its markers are its own
        cin = _metadata_cinatra(node)
        purpose = cin.get("purpose") if cin else None
        if isinstance(purpose, str):
            for prefix in (
                AUTHOR_PLACED_PURPOSE_PREFIX,
                LOADER_INJECTED_PURPOSE_PREFIX,
            ):
                if purpose.startswith(prefix):
                    slot = purpose[len(prefix):]
                    if slot:
                        slots.add(slot)
        for value in node.values():
            scan(value, False)

    scan(definition, True)
    return slots


def _find_declaration_carriers(
    doc: Dict[str, Any],
) -> List[Tuple[Dict[str, Any], Any]]:
    """(definition, raw contextSlots) pairs, root document included.

    A carrier is a Flow definition whose OWN metadata.cinatra carries a
    PRESENT (non-null) contextSlots value. Validation happens at the caller
    so absent/null stays a no-op while present-but-malformed fails the mount.
    """
    carriers: List[Tuple[Dict[str, Any], Any]] = []
    seen: set = set()

    def consider(node: Dict[str, Any]) -> None:
        cin = _metadata_cinatra(node)
        if cin is None or "contextSlots" not in cin:
            return
        raw = cin.get("contextSlots")
        if raw is None:
            return
        if id(node) not in seen:
            seen.add(id(node))
            carriers.append((node, raw))

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        if _is_flow_definition(node):
            consider(node)
        for value in node.values():
            walk(value)

    # The root document is itself the top-level Flow definition.
    if isinstance(doc, dict):
        consider(doc)
    for value in doc.values():
        walk(value)
    return carriers


def _resolve_owner_package(
    doc: Dict[str, Any], definition: Dict[str, Any], def_label: str
) -> str:
    """The package owning ``definition``'s slots.

    Sources, cross-checked (Codex round-0, decision 4): the definition's own
    metadata.cinatra.packageName, and the packageName of every FlowNode in
    the document referencing the definition via subflow.$component_ref.
    Disagreement, absence, or ambiguity → mount error.
    """
    candidates: set = set()
    cin = _metadata_cinatra(definition)
    own = cin.get("packageName") if cin else None
    if isinstance(own, str) and own:
        candidates.add(own)

    def_id = definition.get("id")
    referencer_packages: set = set()

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        subflow = node.get("subflow")
        ref = subflow.get("$component_ref") if isinstance(subflow, dict) else None
        if isinstance(ref, str) and ref == def_id:
            node_cin = _metadata_cinatra(node)
            pkg = node_cin.get("packageName") if node_cin else None
            if isinstance(pkg, str) and pkg:
                referencer_packages.add(pkg)
        for value in node.values():
            walk(value)

    if isinstance(def_id, str):
        walk(doc)
    candidates.update(referencer_packages)

    if not candidates:
        raise ContextInjectionError(
            f"{def_label}: cannot determine the owner package for declared "
            "contextSlots (no metadata.cinatra.packageName on the definition "
            "and no package-named FlowNode references it)"
        )
    if len(candidates) > 1:
        raise ContextInjectionError(
            f"{def_label}: ambiguous owner package for declared contextSlots: "
            f"{sorted(candidates)}"
        )
    return next(iter(candidates))


# ---------------------------------------------------------------------------
# Graph surgery.
# ---------------------------------------------------------------------------


def _component_ref(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        ref = value.get("$component_ref")
        return ref if isinstance(ref, str) else None
    return value if isinstance(value, str) else None


def _ensure_input(
    definition: Dict[str, Any],
    start_def: Dict[str, Any],
    title: str,
    default: Optional[str],
    def_label: str,
) -> None:
    """Ensure ``title`` exists on the definition + StartNode input schemas.

    Reuse a compatible existing input untouched; ADD a missing one (string,
    hidden, with ``default``); FAIL on an incompatible existing definition
    (non-string type, or — for the injector-owned slot-parameter inputs where
    ``default`` is not None — a diverging default).
    """
    for inputs_owner in (definition, start_def):
        inputs = inputs_owner.setdefault("inputs", [])
        if not isinstance(inputs, list):
            raise ContextInjectionError(
                f"{def_label}: 'inputs' is not an array"
            )
        existing = None
        for entry in inputs:
            if isinstance(entry, dict) and entry.get("title") == title:
                existing = entry
                break
        if existing is not None:
            if existing.get("type") != "string":
                raise ContextInjectionError(
                    f"{def_label}: existing input '{title}' has "
                    f"type {existing.get('type')!r}; the injected context "
                    "subflow requires a string"
                )
            if default is not None and existing.get("default") != default:
                raise ContextInjectionError(
                    f"{def_label}: existing input '{title}' has "
                    f"default {existing.get('default')!r}, expected {default!r}"
                )
            continue
        new_entry: Dict[str, Any] = {"title": title, "type": "string"}
        if default is not None:
            new_entry["default"] = default
        else:
            new_entry["default"] = ""
        inputs.append(new_entry)
    # Mark hidden on the StartNode metadata (create the path as needed).
    meta = start_def.setdefault("metadata", {})
    cin = meta.setdefault("cinatra", {}) if isinstance(meta, dict) else None
    if isinstance(cin, dict):
        hidden = cin.setdefault("hidden", [])
        if isinstance(hidden, list) and title not in hidden:
            hidden.append(title)


def _consumer_edges_for_slot(
    definition: Dict[str, Any],
    slot_id: str,
    single_slot: bool,
    injected_ids: set,
    def_label: str,
) -> List[Dict[str, Any]]:
    """DataFlowEdges wiring the injected FlowNode's contextSlotBindings output
    into consumer inputs.

    A consumer is an EXECUTABLE component referenced from the definition's
    ``nodes`` list (never an inert nested definition) declaring an input
    titled ``contextSlotBindings`` (bare — allowed only when the definition
    declares exactly one slot) or ``<slotId>ContextSlotBindings`` (always).
    Zero consumers for a declared slot is a mount error; so is a component
    exposing both the bare and the qualified name, or an existing edge
    already feeding the target input.
    """
    refs = definition.get("$referenced_components")
    nodes = definition.get("nodes")
    if not isinstance(refs, dict) or not isinstance(nodes, list):
        raise ContextInjectionError(
            f"{def_label}: unsupported definition shape (expected "
            "$referenced_components object + nodes array)"
        )
    node_ids = {
        r for r in (_component_ref(entry) for entry in nodes) if r is not None
    }
    qualified = f"{slot_id}ContextSlotBindings"

    existing_targets = set()
    dfc = definition.get("data_flow_connections")
    if isinstance(dfc, list):
        for edge in dfc:
            if isinstance(edge, dict):
                dst = _component_ref(edge.get("destination_node"))
                dst_input = edge.get("destination_input")
                if isinstance(dst, str) and isinstance(dst_input, str):
                    existing_targets.add((dst, dst_input))

    edges: List[Dict[str, Any]] = []
    for comp_id, comp in refs.items():
        if comp_id in injected_ids or comp_id not in node_ids:
            continue
        if not isinstance(comp, dict):
            continue
        if _is_flow_definition(comp) and comp.get("component_type") == "Flow":
            continue  # inert nested definition, not an executable node
        inputs = comp.get("inputs")
        if not isinstance(inputs, list):
            continue
        titles = {
            e.get("title")
            for e in inputs
            if isinstance(e, dict) and isinstance(e.get("title"), str)
        }
        has_bare = "contextSlotBindings" in titles
        has_qualified = qualified in titles
        if has_bare and has_qualified:
            raise ContextInjectionError(
                f"{def_label}: component '{comp_id}' declares BOTH "
                f"'contextSlotBindings' and '{qualified}' — ambiguous"
            )
        target_input: Optional[str] = None
        if has_qualified:
            target_input = qualified
        elif has_bare:
            if not single_slot:
                raise ContextInjectionError(
                    f"{def_label}: component '{comp_id}' declares the bare "
                    "'contextSlotBindings' input but the definition declares "
                    "multiple context slots — use "
                    "'<slotId>ContextSlotBindings'"
                )
            target_input = "contextSlotBindings"
        if target_input is None:
            continue
        if (comp_id, target_input) in existing_targets:
            raise ContextInjectionError(
                f"{def_label}: input '{target_input}' on component "
                f"'{comp_id}' already has a data-flow edge — refusing to "
                "double-wire"
            )
        edges.append(
            {
                "component_type": "DataFlowEdge",
                "name": f"context_{slot_id}_bindings_to_{comp_id}",
                "source_node": {"$component_ref": f"context_{slot_id}"},
                "source_output": "contextSlotBindings",
                "destination_node": {"$component_ref": comp_id},
                "destination_input": target_input,
            }
        )
    if not edges:
        accepted = (
            "'contextSlotBindings'"
            if single_slot
            else f"'{qualified}' (multi-slot definition)"
        )
        raise ContextInjectionError(
            f"{def_label}: declared context slot '{slot_id}' has no consumer "
            f"— no executable node declares a {accepted} input"
        )
    return edges


def _inject_into_definition(
    doc: Dict[str, Any],
    definition: Dict[str, Any],
    slots: List[Dict[str, Any]],
    all_ids: set,
) -> List[Dict[str, Any]]:
    """Inject every not-yet-carried declared slot into one Flow definition.

    Returns report entries. Mutates ``definition`` (a deep copy owned by the
    caller) and updates ``all_ids`` with the injected ids.
    """
    def_id = definition.get("id")
    def_label = f"definition '{def_id}'" if isinstance(def_id, str) else "root flow"

    marker_slots = _definition_local_marker_slots(definition)
    pending = [s for s in slots if s["slotId"] not in marker_slots]
    if not pending:
        return []

    owner_package = _resolve_owner_package(doc, definition, def_label)

    refs = definition.get("$referenced_components")
    nodes = definition.get("nodes")
    cfc = definition.get("control_flow_connections")
    start_ref = _component_ref(definition.get("start_node"))
    if (
        not isinstance(refs, dict)
        or not isinstance(nodes, list)
        or not isinstance(cfc, list)
        or not isinstance(start_ref, str)
    ):
        raise ContextInjectionError(
            f"{def_label}: unsupported definition shape for context-subflow "
            "injection (need $referenced_components/nodes/"
            "control_flow_connections/start_node)"
        )
    start_def = refs.get(start_ref)
    if not isinstance(start_def, dict):
        raise ContextInjectionError(
            f"{def_label}: start node '{start_ref}' is not defined in "
            "$referenced_components"
        )
    dfc = definition.setdefault("data_flow_connections", [])
    if not isinstance(dfc, list):
        raise ContextInjectionError(
            f"{def_label}: data_flow_connections is not an array"
        )

    original_start_edges = [
        e
        for e in cfc
        if isinstance(e, dict) and _component_ref(e.get("from_node")) == start_ref
    ]
    if not original_start_edges:
        raise ContextInjectionError(
            f"{def_label}: start node '{start_ref}' has no outgoing control "
            "edges — nowhere to splice the context subflow"
        )

    # Collision check across the WHOLE document for every id we will add.
    injected_ids: set = set()
    for slot in pending:
        for new_id in _injected_component_ids(slot["slotId"]):
            if new_id in all_ids or new_id in injected_ids:
                raise ContextInjectionError(
                    f"{def_label}: injected component id '{new_id}' collides "
                    "with an existing id in the document"
                )
            injected_ids.add(new_id)

    single_slot = len(slots) == 1
    report: List[Dict[str, Any]] = []
    consumer_edges: List[Dict[str, Any]] = []
    prev_node_id = start_ref
    for slot in pending:
        slot_id = slot["slotId"]
        subflow_def = build_context_subflow(slot_id)
        flow_node = build_context_flow_node(slot_id)
        node_id = flow_node["id"]  # context_<slotId>

        refs[subflow_def["id"]] = subflow_def
        refs[node_id] = flow_node
        nodes.append({"$component_ref": node_id})

        # Chain: start → ctx1 → … → ctxN (original successors retargeted below).
        cfc.append(
            {
                "component_type": "ControlFlowEdge",
                "name": f"{node_id}_entry",
                "from_node": {"$component_ref": prev_node_id},
                "to_node": {"$component_ref": node_id},
            }
        )
        prev_node_id = node_id

        # Hidden inputs feeding the subflow (hand-format parity).
        _ensure_input(definition, start_def, "cinatra_run_id", None, def_label)
        _ensure_input(definition, start_def, "projectId", None, def_label)
        _ensure_input(
            definition,
            start_def,
            f"{slot_id}ParentPackageName",
            owner_package,
            def_label,
        )
        _ensure_input(definition, start_def, f"{slot_id}SlotId", slot_id, def_label)

        for source_output, destination_input in (
            ("cinatra_run_id", "parentRunId"),
            (f"{slot_id}ParentPackageName", "parentPackageName"),
            (f"{slot_id}SlotId", "slotId"),
            ("projectId", "projectId"),
        ):
            dfc.append(
                {
                    "component_type": "DataFlowEdge",
                    "name": f"{node_id}_dfe_{destination_input}",
                    "source_node": {"$component_ref": start_ref},
                    "source_output": source_output,
                    "destination_node": {"$component_ref": node_id},
                    "destination_input": destination_input,
                }
            )

        consumer_edges.extend(
            _consumer_edges_for_slot(
                definition, slot_id, single_slot, injected_ids, def_label
            )
        )
        report.append(
            {
                "slot": slot_id,
                "definition": def_id if isinstance(def_id, str) else "<root>",
                "packageName": owner_package,
                "templateVersion": CONTEXT_SUBFLOW_TEMPLATE_VERSION,
            }
        )

    # Retarget the original start successors to run AFTER the last injected
    # context node (all other edge attributes preserved).
    for edge in original_start_edges:
        edge["from_node"] = {"$component_ref": prev_node_id}

    dfc.extend(consumer_edges)
    all_ids.update(injected_ids)
    return report


# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------


def inject_context_subflows(
    doc: Dict[str, Any], label: str
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Inject the canonical context subflow for every declared-but-not-carried
    slot in ``doc`` (the parsed, PRE-placeholder-substitution OAS).

    Returns ``(document, report)``. When no slot needed injection the ORIGINAL
    ``doc`` object is returned untouched with an empty report — the caller
    keeps the raw-text mount path byte-identical. When injection applies, the
    returned document is a deep copy; ``doc`` itself is never mutated.

    Raises ContextInjectionError on any malformed declaration or impossible
    injection (the caller records a per-agent mount failure).
    """
    if not isinstance(doc, dict):
        return doc, []

    carriers = _find_declaration_carriers(doc)
    validated: List[Tuple[Dict[str, Any], List[Dict[str, Any]]]] = []
    for definition, raw in carriers:
        def_id = definition.get("id")
        def_label = (
            f"{label}: definition '{def_id}'"
            if isinstance(def_id, str)
            else f"{label}: root flow"
        )
        slots = _validate_declared_slots(raw, def_label)
        if slots:
            validated.append((definition, slots))
    if not validated:
        return doc, []

    # Anything to actually inject? (Definition-local marker check on the
    # ORIGINAL doc so a fully-legacy spec never pays the deepcopy.)
    needs_injection = any(
        any(
            s["slotId"] not in _definition_local_marker_slots(definition)
            for s in slots
        )
        for definition, slots in validated
    )
    if not needs_injection:
        return doc, []

    composed = copy.deepcopy(doc)
    # Re-find carriers on the copy (same traversal order — deterministic).
    copy_carriers = _find_declaration_carriers(composed)
    all_ids = _collect_all_ids(composed)
    report: List[Dict[str, Any]] = []
    for definition, raw in copy_carriers:
        def_id = definition.get("id")
        def_label = (
            f"{label}: definition '{def_id}'"
            if isinstance(def_id, str)
            else f"{label}: root flow"
        )
        slots = _validate_declared_slots(raw, def_label)
        if not slots:
            continue
        report.extend(_inject_into_definition(composed, definition, slots, all_ids))
    return composed, report
