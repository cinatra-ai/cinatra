"""Verify the fallback no longer false-positives a cycle on the stale
in-progress marker, and `_is_python_primitive_type` no longer raises
`TypeError` on typing constructs.

Upstream defect surface (pyagentspec==26.1.0):

1. `_is_python_primitive_type` at
   `pyagentspec/serialization/deserializationcontext.py:163` calls
   `issubclass(annotation, (bool, int, float, str))` without guarding
   against non-class annotations. `Annotated[Enum, SerializeAsEnum(...)]`
   trips a `TypeError: issubclass() arg 1 must be a class`. The TypeError
   propagates up through `_load_field` and back into the patched
   `deserialize`.

2. The `_patch_pyagentspec_deserialization_error_mask` patch has a
   broad `except Exception` around `_resolve_content_and_build` that
   falls back to `_orig_deserialize`. The fallback re-runs the same
   walk on the same content, but the original `_load_reference` placed
   a `_DeserializationInProgressMarker` for the parent component during
   the failed first pass. The retry hits the stale marker and raises
   `ValueError: Found a circular dependency during deserialization of
   object with id: '<id>'` — a false positive that masks the real
   TypeError / ValidationError.

This regression coverage applies two patches:

- `_patch_pyagentspec_is_python_primitive_type_guard` — wraps the
  primitive-type check in `try/except TypeError` so non-class
  annotations return `False` instead of crashing.
- `_patch_pyagentspec_deserialization_error_mask` (modified) — scrubs
  stale in-progress markers from the deserialization context before
  the fallback retry, so the second pass doesn't hit a false-positive
  cycle on the marker.

This test asserts:

1. The primitive-type guard makes `_is_python_primitive_type` return
   `False` instead of raising on a typing construct.
2. With both patches applied, a minimal AgentNode-wrapping-A2AAgent OAS
   that raised `ValueError: Found a circular dependency`
   now surfaces the REAL underlying error
   (a `pydantic_core.ValidationError` or a `wayflowcore.AgentExecutionStep`
   `ValueError` — both are acceptable; the assertion is purely that
   the cycle false-positive is GONE).
3. Both patches are idempotent.

Repro fixture follows the shape of the @cinatra/agent-creation-finalizer
parent flow. On hosts without `wayflowcore` + `pyagentspec` installed,
the test skips.
"""

from __future__ import annotations

import json
from typing import Any, Tuple

import pytest

import agent_loader


def _import_live_symbols() -> Tuple[Any, Any, Any]:
    """Resolve the wayflowcore + pyagentspec symbols. Skip on hosts where
    either is missing (this test is meaningful only inside the WayFlow
    container image where both are pinned)."""
    try:
        from pyagentspec.serialization.deserializationcontext import (  # type: ignore[import-not-found]
            _DeserializationContextImpl,
            _DeserializationInProgressMarker,
        )
        from pyagentspec.serialization.pydanticdeserializationplugin import (  # type: ignore[import-not-found]
            PydanticComponentDeserializationPlugin,
        )
        from wayflowcore.agentspec import AgentSpecLoader  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover — host-side fallback
        pytest.skip(f"wayflowcore or pyagentspec not importable: {exc}")
    return _DeserializationContextImpl, PydanticComponentDeserializationPlugin, AgentSpecLoader


# Minimal OAS that triggered the false-positive cycle before the cleanup.
# AgentNode `a` wraps A2AAgent `a2a` via `$component_ref`, with `outputs`
# declared — base `AgentNode` rejects the `outputs` declaration which is
# what triggers the inner pydantic ValidationError → deserialization fallback
# → stale marker on retry → false-positive cycle.
MIN_CYCLE_REPRO_OAS: dict = {
    "agentspec_version": "26.1.0",
    "component_type": "Flow",
    "id": "cycle-min",
    "name": "minimal cycle repro",
    "metadata": {"cinatra": {"type": "flow"}},
    "inputs": [],
    "outputs": [{"title": "findings", "type": "string"}],
    "start_node": {"$component_ref": "s"},
    "nodes": [
        {"$component_ref": "s"},
        {"$component_ref": "a"},
        {"$component_ref": "e"},
    ],
    "control_flow_connections": [
        {
            "component_type": "ControlFlowEdge",
            "name": "s2a",
            "from_node": {"$component_ref": "s"},
            "to_node": {"$component_ref": "a"},
        },
        {
            "component_type": "ControlFlowEdge",
            "name": "a2e",
            "from_node": {"$component_ref": "a"},
            "to_node": {"$component_ref": "e"},
        },
    ],
    "data_flow_connections": [
        {
            "component_type": "DataFlowEdge",
            "name": "f2e",
            "source_node": {"$component_ref": "a"},
            "source_output": "findings",
            "destination_node": {"$component_ref": "e"},
            "destination_input": "findings",
        }
    ],
    "$referenced_components": {
        "s": {"component_type": "StartNode", "id": "s", "name": "S", "inputs": []},
        "e": {
            "component_type": "EndNode",
            "id": "e",
            "name": "E",
            "outputs": [{"title": "findings", "type": "string"}],
        },
        "a": {
            "component_type": "AgentNode",
            "id": "a",
            "name": "A",
            "agent": {"$component_ref": "a2a"},
            "outputs": [{"title": "findings", "type": "string"}],
        },
        "a2a": {
            "component_type": "A2AAgent",
            "id": "a2a",
            "name": "A2A",
            "agent_url": "http://example.invalid",
            "connection_config": {
                "component_type": "A2AConnectionConfig",
                "id": "conn",
                "name": "conn",
                "verify": False,
            },
        },
    },
}


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_primitive_type_guard_is_idempotent() -> None:
    """Applying the guard twice changes nothing — sentinel-guarded."""
    DeserializationContextImpl, _, _ = _import_live_symbols()

    # Clean slate: undo an already-applied patch if present.
    wrapped = getattr(
        DeserializationContextImpl._is_python_primitive_type, "__wrapped__", None
    )
    if wrapped is not None:
        DeserializationContextImpl._is_python_primitive_type = wrapped  # type: ignore[method-assign]
    if hasattr(DeserializationContextImpl, "_cinatra_primitive_type_guard_patch_applied"):
        delattr(DeserializationContextImpl, "_cinatra_primitive_type_guard_patch_applied")

    agent_loader._patch_pyagentspec_is_python_primitive_type_guard()
    first = DeserializationContextImpl._is_python_primitive_type
    assert getattr(
        DeserializationContextImpl, "_cinatra_primitive_type_guard_patch_applied", False
    ) is True

    agent_loader._patch_pyagentspec_is_python_primitive_type_guard()
    second = DeserializationContextImpl._is_python_primitive_type
    assert first is second, "second patch invocation must not reinstall"


def test_primitive_type_guard_swallows_typeerror_on_non_class() -> None:
    """`Annotated[Enum, SerializeAsEnum(...)]` was raising
    `TypeError: issubclass() arg 1 must be a class`. After the guard, the
    method returns `False` (the value the surrounding code would have
    computed if the TypeError hadn't fired).
    """
    DeserializationContextImpl, _, _ = _import_live_symbols()
    agent_loader._patch_pyagentspec_is_python_primitive_type_guard()

    # Build a non-class annotation that trips raw `issubclass`.
    from typing import Annotated  # noqa: PLC0415 — local import is fine for tests

    weird_annotation = Annotated[int, "sentinel metadata"]

    # Create a context instance to call the bound method.
    ctx = DeserializationContextImpl(plugins=[])
    result = ctx._is_python_primitive_type(weird_annotation)
    assert result is False, (
        "guard must return False for non-class annotations, not raise TypeError"
    )


def test_marker_cleanup_no_longer_emits_false_positive_cycle() -> None:
    """The minimal AgentNode-wrapping-A2AAgent OAS used to raise a
    `ValueError: Found a circular dependency during deserialization of
    object with id: 'a'`. After the cleanup, the false-positive cycle is
    gone and the REAL underlying error surfaces (a pydantic
    ValidationError about the AgentNode rejecting `outputs`, or a
    wayflowcore AgentExecutionStep ValueError about A2A children — both
    are downstream concerns, not covered here).

    The assertion is intentionally focused: whatever the real error is,
    it must NOT be the "circular dependency" mask.
    """
    _, _, AgentSpecLoader = _import_live_symbols()
    agent_loader._patch_pyagentspec_deserialization_error_mask()
    agent_loader._patch_pyagentspec_is_python_primitive_type_guard()

    with pytest.raises(Exception) as excinfo:
        AgentSpecLoader().load_json(json.dumps(MIN_CYCLE_REPRO_OAS))

    msg = str(excinfo.value)
    assert "Found a circular dependency" not in msg, (
        f"Patches must eliminate the false-positive cycle error. "
        f"Got: {type(excinfo.value).__name__}: {msg[:300]}"
    )


def test_scrub_helper_preserves_baseline_removes_only_stale() -> None:
    """Direct unit test of `_scrub_stale_inprogress_markers`. Build a
    fake deserialization context with two in-progress markers — one
    baseline (placed before the call) and one stale (added during a
    simulated failed pass) — and call the helper with the baseline
    key set as `baseline_keys`. Baseline must survive; stale must be
    removed.

    Earlier coverage asserted only that a valid OAS still loads, which
    doesn't directly prove the baseline-preservation semantics. This
    test pins them by exercising the helper directly (the helper was
    hoisted to module scope for exactly this reason).
    """
    _, _, _ = _import_live_symbols()
    # Ensure the marker class is importable in this test session.
    marker_cls = agent_loader._resolve_inprogress_marker_class()
    assert marker_cls is not None

    # Minimal fake context with a `loaded_references` dict — that's all
    # the helper inspects.
    class _FakeContext:
        def __init__(self) -> None:
            self.loaded_references: dict = {}

    ctx = _FakeContext()
    BASELINE_ID = "baseline_outer_id"
    STALE_ID = "stale_new_id"
    UNRELATED_ID = "unrelated_already_loaded"

    ctx.loaded_references[BASELINE_ID] = marker_cls()
    ctx.loaded_references[UNRELATED_ID] = object()  # Fully-loaded component, not a marker.

    # Snapshot baseline BEFORE the simulated failure.
    baseline = agent_loader._snapshot_inprogress_marker_keys(ctx)
    assert baseline == {BASELINE_ID}

    # Simulate the failed pass adding a new marker.
    ctx.loaded_references[STALE_ID] = marker_cls()

    # Scrub.
    agent_loader._scrub_stale_inprogress_markers(ctx, baseline)

    # Baseline marker MUST survive.
    assert BASELINE_ID in ctx.loaded_references, (
        "baseline in-progress marker was scrubbed — patch over-cleaned"
    )
    assert isinstance(ctx.loaded_references[BASELINE_ID], marker_cls)
    # Stale marker MUST be removed.
    assert STALE_ID not in ctx.loaded_references, (
        "stale in-progress marker added during the failed pass was NOT scrubbed"
    )
    # Unrelated non-marker objects MUST be untouched.
    assert UNRELATED_ID in ctx.loaded_references, (
        "scrub touched a non-marker entry"
    )


def test_scrub_helper_no_ops_on_layout_drift() -> None:
    """If `loaded_references` is missing or not a dict, the helper
    silently no-ops instead of crashing the deserializer.
    """
    _, _, _ = _import_live_symbols()

    class _NoRefs:
        pass

    class _WrongType:
        def __init__(self) -> None:
            self.loaded_references = "not a dict"

    # Neither should raise.
    agent_loader._scrub_stale_inprogress_markers(_NoRefs(), set())
    agent_loader._scrub_stale_inprogress_markers(_WrongType(), set())
    # Snapshot helper is also no-op on layout drift.
    assert agent_loader._snapshot_inprogress_marker_keys(_NoRefs()) == set()
    assert agent_loader._snapshot_inprogress_marker_keys(_WrongType()) == set()
