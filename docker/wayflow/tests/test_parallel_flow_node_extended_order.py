"""Verify the ExtendedParallelFlowNode ordering patch.

Upstream defect: `wayflowcore.serialization._builtins_deserialization_plugin.
convert_to_wayflow` checks `isinstance(comp, AgentSpecParallelFlowNode)`
BEFORE `isinstance(comp, AgentSpecExtendedParallelFlowNode)`. Because
`ExtendedParallelFlowNode` inherits from `ParallelFlowNode`, the parent-class
branch fires first for every Extended instance — the Extended branch (which
reads `flows`, `max_workers`, and runs `_get_rt_nodes_arguments`) is
unreachable. Result: extended fields (`inputs`, `outputs`, declared by the
`parallel_reviews` flow) are silently dropped at runtime.

This test asserts:

1. Patch is idempotent — re-applying it twice is a no-op.
2. For an `AgentSpecExtendedParallelFlowNode` instance, the patched
   `convert_to_wayflow` constructs a `ParallelFlowExecutionStep` using the
   Extended fields (NOT the basic branch). We prove this by installing a
   fake `convert_to_wayflow` on the plugin class BEFORE applying the
   patch, so the patch closes over our spy; an Extended call must NOT
   reach the spy (it must be handled by the patched branch directly).
3. For non-Extended components, the patched method delegates to the
   captured original. We install the spy BEFORE applying the patch so
   the closure captures the spy as `_orig_convert` — this guards the
   closure capture behavior.
4. (Implicit) On layout drift (AttributeError / TypeError inside the
   Extended branch), the patch raises `RuntimeError` rather than
   delegating to the known-bad basic branch.

The test imports the real pyagentspec + wayflowcore packages from the
container image. On a host without those packages the imports raise and
the test skips (mirrors the pattern in `test_deserialization_error_mask`).
"""

from __future__ import annotations

from typing import Any, Tuple

import pytest

import agent_loader


def _import_live_symbols() -> Tuple[Any, Any, Any, Any]:
    """Resolve the wayflowcore + pyagentspec symbols. Skip on hosts where
    either is missing (this test is meaningful only inside the WayFlow
    container image where both are pinned)."""
    try:
        from wayflowcore.serialization import (  # type: ignore[import-not-found]
            _builtins_deserialization_plugin as plugin_mod,
        )
        from pyagentspec.flows.nodes.parallelflownode import (  # type: ignore[import-not-found]
            ParallelFlowNode as AgentSpecParallelFlowNode,
        )
        from wayflowcore.agentspec.components import (  # type: ignore[import-not-found]
            ExtendedParallelFlowNode as AgentSpecExtendedParallelFlowNode,
        )
        from wayflowcore.steps.parallelflowexecutionstep import (  # type: ignore[import-not-found]
            ParallelFlowExecutionStep as RuntimeParallelFlowExecutionStep,
        )
    except ImportError as exc:  # pragma: no cover — host-side fallback
        pytest.skip(f"wayflowcore or pyagentspec not importable: {exc}")
    return (
        plugin_mod,
        AgentSpecParallelFlowNode,
        AgentSpecExtendedParallelFlowNode,
        RuntimeParallelFlowExecutionStep,
    )


def _locate_plugin_cls(plugin_mod: Any) -> Any:
    """Return the `BuiltinsDeserializationPlugin` class, scanning the module
    if the canonical name is missing (defensive against future renames —
    matches the same fallback the patch itself does)."""
    plugin_cls = getattr(plugin_mod, "BuiltinsDeserializationPlugin", None)
    if plugin_cls is None:  # pragma: no cover — wayflowcore layout drift
        for attr in dir(plugin_mod):
            obj = getattr(plugin_mod, attr, None)
            if (
                isinstance(obj, type)
                and "Plugin" in attr
                and hasattr(obj, "convert_to_wayflow")
            ):
                plugin_cls = obj
                break
    assert plugin_cls is not None, "BuiltinsDeserializationPlugin missing"
    return plugin_cls


def _reset_patch_sentinel(plugin_cls: Any) -> None:
    """Restore the original `convert_to_wayflow` + clear the sentinel so each
    test starts from a clean slate. Idempotent."""
    wrapped = getattr(plugin_cls.convert_to_wayflow, "__wrapped__", None)
    if wrapped is not None:
        plugin_cls.convert_to_wayflow = wrapped  # type: ignore[method-assign]
    if hasattr(plugin_cls, "_cinatra_parallel_extended_patch_applied"):
        delattr(plugin_cls, "_cinatra_parallel_extended_patch_applied")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_patch_is_idempotent() -> None:
    """Applying the patch twice changes nothing — sentinel-guarded."""
    plugin_mod, _, _, _ = _import_live_symbols()
    plugin_cls = _locate_plugin_cls(plugin_mod)
    _reset_patch_sentinel(plugin_cls)

    agent_loader._patch_parallel_flow_node_extended_order()
    first = plugin_cls.convert_to_wayflow
    assert getattr(plugin_cls, "_cinatra_parallel_extended_patch_applied", False) is True

    agent_loader._patch_parallel_flow_node_extended_order()
    second = plugin_cls.convert_to_wayflow
    assert first is second, "second patch invocation must not reinstall"


def test_extended_branch_handles_extended_instances_directly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """For an ExtendedParallelFlowNode instance, the patched method must
    construct the runtime step itself via the Extended-shape branch.

    Install the spy BEFORE applying the patch so the patch's closure
    captures the spy as `_orig_convert`. If the patched method
    incorrectly delegated Extended instances to upstream, `spy_calls`
    would record an entry. The assertion that `spy_calls` is empty
    proves the Extended branch ran inline.
    """
    (
        plugin_mod,
        _AgentSpecParallelFlowNode,
        AgentSpecExtendedParallelFlowNode,
        RuntimeParallelFlowExecutionStep,
    ) = _import_live_symbols()
    plugin_cls = _locate_plugin_cls(plugin_mod)
    _reset_patch_sentinel(plugin_cls)

    spy_calls: list[Any] = []

    def _spy_orig(self: Any, *args: Any, **kwargs: Any) -> Any:
        spy_calls.append((args, kwargs))
        raise AssertionError(
            "patched convert_to_wayflow delegated Extended instance to upstream — "
            "this is the elif-ordering bug the patch is supposed to fix"
        )

    # Install spy BEFORE applying the patch — the patch closes over the
    # currently-bound `convert_to_wayflow`, so this spy becomes
    # `_orig_convert` inside the patched function.
    monkeypatch.setattr(plugin_cls, "convert_to_wayflow", _spy_orig, raising=False)
    agent_loader._patch_parallel_flow_node_extended_order()

    # Minimal Extended instance — bypass pydantic validation since we only
    # need the .flows / .max_workers / isinstance properties.
    extended = AgentSpecExtendedParallelFlowNode.model_construct(  # type: ignore[attr-defined]
        flows=[],
        max_workers=2,
    )

    class _Ctx:
        def convert(self, comp: Any, tool_registry: Any, converted: Any) -> Any:
            return comp

    def _fake_rt_args(self: Any, comp: Any, metadata_info: Any) -> dict[str, Any]:
        return {"name": "test_parallel_step"}

    monkeypatch.setattr(plugin_cls, "_get_rt_nodes_arguments", _fake_rt_args)
    plugin = plugin_cls()
    result = plugin.convert_to_wayflow(extended, _Ctx(), None, {}, None)

    assert isinstance(result, RuntimeParallelFlowExecutionStep), (
        f"expected ParallelFlowExecutionStep, got {type(result).__name__}"
    )
    # `max_workers` came from the Extended instance, not the basic branch's
    # hardcoded `None`. Wayflowcore stores it as a private attr on some
    # versions and a public attr on others; either is acceptable.
    actual_max = getattr(result, "max_workers", None)
    if actual_max is None:
        actual_max = getattr(result, "_max_workers", None)
    assert actual_max == 2, (
        f"Extended max_workers=2 was not propagated to runtime step (got {actual_max!r})"
    )
    assert spy_calls == [], (
        "patched method must not delegate Extended instances — "
        "Extended branch must construct the step inline"
    )


def test_non_extended_components_delegate_to_original_via_closure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """For any non-Extended component, the patched method must call the
    closed-over original `convert_to_wayflow` so the upstream elif chain
    runs intact.

    Install the spy as `convert_to_wayflow` BEFORE applying the patch —
    the patch's closure captures it as `_orig_convert`. Calling the
    patched method with a non-Extended component must invoke the spy
    exactly once with the forwarded args.
    """
    plugin_mod, _, _, _ = _import_live_symbols()
    plugin_cls = _locate_plugin_cls(plugin_mod)
    _reset_patch_sentinel(plugin_cls)

    seen: list[Tuple[Any, ...]] = []
    sentinel_result = object()

    def _spy_orig(self: Any, *args: Any, **kwargs: Any) -> Any:
        seen.append((args, kwargs))
        return sentinel_result

    # Install BEFORE patching — closure capture.
    monkeypatch.setattr(plugin_cls, "convert_to_wayflow", _spy_orig, raising=False)
    agent_loader._patch_parallel_flow_node_extended_order()

    # A plain object (NOT an ExtendedParallelFlowNode) must go through the
    # delegation path that hits the closed-over spy.
    other = object()
    plugin = plugin_cls()
    result = plugin.convert_to_wayflow(other, None, None, {}, None)

    assert result is sentinel_result, (
        "non-Extended component must delegate to upstream (closed-over) original"
    )
    assert len(seen) == 1, f"expected exactly one delegation, got {len(seen)}"
    forwarded_args, _forwarded_kwargs = seen[0]
    assert forwarded_args[0] is other, "delegated call must forward the component"


def test_extended_layout_drift_raises_rather_than_falling_back(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If the Extended class layout drifts (the Extended branch raises
    AttributeError / TypeError inside our patched code), we MUST NOT
    delegate to the original `convert_to_wayflow` —
    that path is the known-bad basic-class branch which silently strips
    the Extended fields. The patch must raise RuntimeError instead so
    the regression surfaces loudly.
    """
    (
        plugin_mod,
        _,
        AgentSpecExtendedParallelFlowNode,
        _RuntimeParallelFlowExecutionStep,
    ) = _import_live_symbols()
    plugin_cls = _locate_plugin_cls(plugin_mod)
    _reset_patch_sentinel(plugin_cls)

    delegate_calls: list[Any] = []

    def _spy_orig(self: Any, *args: Any, **kwargs: Any) -> Any:
        delegate_calls.append(args)
        return object()  # would be silently wrong — we must not get here

    monkeypatch.setattr(plugin_cls, "convert_to_wayflow", _spy_orig, raising=False)
    agent_loader._patch_parallel_flow_node_extended_order()

    extended = AgentSpecExtendedParallelFlowNode.model_construct(  # type: ignore[attr-defined]
        flows=[],
        max_workers=2,
    )

    # Force a layout-drift scenario: monkey-patch `_get_rt_nodes_arguments`
    # to raise AttributeError, simulating a future wayflowcore release that
    # renames or removes the helper. The Extended branch's `try` must
    # catch this and re-raise as RuntimeError.
    def _broken_rt_args(self: Any, comp: Any, metadata_info: Any) -> dict[str, Any]:
        raise AttributeError("synthetic layout drift")

    monkeypatch.setattr(plugin_cls, "_get_rt_nodes_arguments", _broken_rt_args)

    class _Ctx:
        def convert(self, comp: Any, tool_registry: Any, converted: Any) -> Any:
            return comp

    plugin = plugin_cls()
    with pytest.raises(RuntimeError, match="patch failed to construct"):
        plugin.convert_to_wayflow(extended, _Ctx(), None, {}, None)

    assert delegate_calls == [], (
        "patch must NOT delegate Extended instances to the known-bad basic "
        "branch on layout drift — it must raise instead"
    )
