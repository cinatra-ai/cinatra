"""Verify the pyagentspec deserialization error-mask patch.

Upstream defect: `pyagentspec/serialization/pydanticdeserializationplugin.py`
constructs `InitErrorDetails(type=..., loc=..., input=())` without
`ctx={"error": ValueError(<msg>)}`, so pydantic_core raises a misleading
`TypeError: ValueError: 'error' required in context` whenever a
deserialization produces a `value_error`. Operators see the TypeError but
not the real validation message, which can mask agent mount failures.

This test feeds the patched plugin a forged `value_error` and asserts:

1. The plugin raises `pydantic_core.ValidationError` (the real, useful
   error type), NOT `TypeError`.
2. The original validation message survives in the raised exception.
3. The patch is idempotent — applying it twice changes nothing.
4. The patch leaves non-`value_error` types and zero-error returns alone.

The test imports the real pyagentspec plugin and pydantic_core types and
monkey-patches just enough to inject a deterministic
`(validation_errors, component)` pair without exercising real OAS
deserialization. That keeps the test hermetic and < 1 s.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import pytest

import agent_loader


def _import_plugin_and_types() -> Tuple[Any, Any, Any]:
    """Resolve the live pyagentspec + pydantic_core symbols. Skip if either
    package is missing on the host (the test is meaningful only inside the
    container image where both are pinned)."""
    try:
        from pyagentspec.serialization.pydanticdeserializationplugin import (  # type: ignore[import-not-found]
            PydanticComponentDeserializationPlugin,
        )
        from pydantic_core import (  # type: ignore[import-not-found]
            InitErrorDetails,
            ValidationError,
        )
    except ImportError as exc:  # pragma: no cover — host-side typecheck fallback
        pytest.skip(f"pyagentspec or pydantic_core not importable: {exc}")
    return PydanticComponentDeserializationPlugin, InitErrorDetails, ValidationError


def _forge_value_error(msg: str) -> Any:
    """Forge a single PyAgentSpecErrorDetails-like object with type='value_error'.

    The real `PyAgentSpecErrorDetails` is a NamedTuple/dataclass in pyagentspec;
    our patched code only reads `.type`, `.loc`, `.msg`, `.ctx`, so duck-typed
    SimpleNamespace is enough.
    """
    import types as _types

    return _types.SimpleNamespace(
        type="value_error",
        loc=("dummy",),
        msg=msg,
        ctx=None,
    )


def _install_resolve_stub(
    plugin: Any,
    component_class: type,
    errors: List[Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Replace `_resolve_content_and_build` on a plugin instance so it
    deterministically returns `(component_instance, errors)`."""
    def fake_resolve(
        self: Any,
        serialized_component: Dict[str, Any],
        deserialization_context: Any,
    ) -> Tuple[Any, List[Any]]:
        return component_class(), list(errors)

    monkeypatch.setattr(
        plugin.__class__,
        "_resolve_content_and_build",
        fake_resolve,
        raising=True,
    )


class _DummyComponent:
    """Stand-in for the deserialized component; only its class name matters
    (used as the ValidationError `title`)."""


def test_patch_is_applied_after_invocation() -> None:
    plugin_cls, _, _ = _import_plugin_and_types()
    agent_loader._patch_pyagentspec_deserialization_error_mask()
    assert getattr(plugin_cls, "_cinatra_error_mask_patch_applied", False) is True


def test_patch_is_idempotent() -> None:
    plugin_cls, _, _ = _import_plugin_and_types()
    agent_loader._patch_pyagentspec_deserialization_error_mask()
    deserialize_after_first = plugin_cls.deserialize
    # Re-invocation must NOT wrap the already-wrapped method again.
    agent_loader._patch_pyagentspec_deserialization_error_mask()
    assert plugin_cls.deserialize is deserialize_after_first


def test_value_error_is_unmasked(monkeypatch: pytest.MonkeyPatch) -> None:
    """A forged `value_error` must surface as ValidationError carrying the
    original message — NOT TypeError."""
    plugin_cls, _, ValidationError = _import_plugin_and_types()
    agent_loader._patch_pyagentspec_deserialization_error_mask()

    plugin = plugin_cls(component_types_and_models={})
    _install_resolve_stub(
        plugin,
        component_class=_DummyComponent,
        errors=[_forge_value_error("real-validation-message")],
        monkeypatch=monkeypatch,
    )

    with pytest.raises(ValidationError) as excinfo:
        plugin.deserialize({}, None)

    # The real message must survive — operators must be able to grep this
    # in container logs.
    rendered = str(excinfo.value)
    assert "real-validation-message" in rendered, (
        f"Expected real validation message to surface, got:\n{rendered}"
    )


def test_zero_errors_returns_component(monkeypatch: pytest.MonkeyPatch) -> None:
    """When validation_errors is empty, the patched method must return the
    component unchanged (no spurious ValidationError raise)."""
    plugin_cls, _, _ = _import_plugin_and_types()
    agent_loader._patch_pyagentspec_deserialization_error_mask()

    plugin = plugin_cls(component_types_and_models={})
    _install_resolve_stub(
        plugin,
        component_class=_DummyComponent,
        errors=[],
        monkeypatch=monkeypatch,
    )

    result = plugin.deserialize({}, None)
    assert isinstance(result, _DummyComponent)


def test_non_value_error_passes_through_without_ctx_injection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Errors with type != "value_error" (e.g. "missing", "string_type")
    must NOT receive a ctx injection. They must still surface as
    ValidationError so the deserialize contract is unchanged.

    Asserts BOTH:
      1. ValidationError is raised (deserialize contract unchanged).
      2. No `ctx={"error": ...}` is injected on the resulting error
         entry — observable via `ValidationError.errors()`, which
         exposes per-entry `ctx` dicts in pydantic v2."""
    plugin_cls, _, ValidationError = _import_plugin_and_types()
    agent_loader._patch_pyagentspec_deserialization_error_mask()

    import types as _types

    err = _types.SimpleNamespace(
        type="missing",
        loc=("required_field",),
        msg="Field required",
        ctx=None,
    )

    plugin = plugin_cls(component_types_and_models={})
    _install_resolve_stub(
        plugin,
        component_class=_DummyComponent,
        errors=[err],
        monkeypatch=monkeypatch,
    )

    with pytest.raises(ValidationError) as excinfo:
        plugin.deserialize({}, None)

    # 1. Real error message surfaces.
    rendered = str(excinfo.value)
    assert "required_field" in rendered or "Field required" in rendered

    # 2. No ctx injection — the resulting ValidationError entry's `ctx`
    # is absent (or empty), proving we did NOT add `error=ValueError(...)`
    # for the non-value_error case.
    entries = excinfo.value.errors()
    assert len(entries) == 1
    entry_ctx = entries[0].get("ctx")
    assert not entry_ctx or "error" not in entry_ctx, (
        f"Expected no ctx['error'] injection on non-value_error, "
        f"got entry={entries[0]!r}"
    )


def test_existing_ctx_error_is_preserved(monkeypatch: pytest.MonkeyPatch) -> None:
    """If pyagentspec ever starts passing `ctx['error']` itself, the patch
    must not overwrite it. Verified by forging a value_error whose `ctx`
    already carries a distinguishable ValueError instance."""
    plugin_cls, _, ValidationError = _import_plugin_and_types()
    agent_loader._patch_pyagentspec_deserialization_error_mask()

    import types as _types

    sentinel_msg = "preserved-by-upstream"
    err = _types.SimpleNamespace(
        type="value_error",
        loc=("dummy",),
        msg="ignored-fallback",
        ctx={"error": ValueError(sentinel_msg)},
    )

    plugin = plugin_cls(component_types_and_models={})
    _install_resolve_stub(
        plugin,
        component_class=_DummyComponent,
        errors=[err],
        monkeypatch=monkeypatch,
    )

    with pytest.raises(ValidationError) as excinfo:
        plugin.deserialize({}, None)

    assert sentinel_msg in str(excinfo.value)
    assert "ignored-fallback" not in str(excinfo.value)
