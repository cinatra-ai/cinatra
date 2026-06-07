"""Live-class-name guard.

The guard fails the container at startup if the wayflowcore symbols the
loader binds against (the four patched methods + the two step classes named
in `_is_apinode_only_flow`) have moved or been renamed. Without it, a
wayflowcore upgrade can silently break the predicate because the predicate
compares `type(step).__name__` against a hard-coded string set rather than a
class identity.
"""

from __future__ import annotations

import importlib
import sys
import types
from typing import Any, List, Tuple

import pytest

import agent_loader


def test_validate_live_class_names_passes_against_pinned_wayflowcore() -> None:
    """Smoke: every binding in `_LIVE_CLASS_BINDINGS` resolves on the pinned
    wayflowcore (==26.1.1, pyagentspec==26.1.0). Future bumps that drop or
    rename a symbol will fail this test, surfacing the breakage in CI before
    the container is shipped."""
    # Must not raise.
    agent_loader._validate_live_class_names()


def test_validate_live_class_names_raises_with_actionable_message_on_missing_class(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If a future wayflowcore drops a class the loader depends on, the guard
    must (1) raise RuntimeError, (2) name the missing symbol, and (3) name
    the wayflowcore version so the operator can write a targeted bump note."""
    fake_bindings: Tuple[Tuple[str, str, Any], ...] = (
        ("wayflowcore.steps", "ApiCallStep", "_execute_request"),
        ("wayflowcore.steps", "ClassThatDoesNotExist", None),
    )
    monkeypatch.setattr(agent_loader, "_LIVE_CLASS_BINDINGS", fake_bindings)

    with pytest.raises(RuntimeError) as excinfo:
        agent_loader._validate_live_class_names()

    msg = str(excinfo.value)
    assert "ClassThatDoesNotExist" in msg
    assert "wayflowcore" in msg
    # Sanity: the existing class should NOT appear in the missing list.
    # The version line names wayflowcore so we anchor on the bullet style.
    assert "ApiCallStep" not in msg.split("missing", 1)[1] if "missing" in msg else True


def test_validate_live_class_names_raises_on_missing_method(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Method renames are the more subtle failure mode (the class still
    imports, but the patched attribute is gone). The guard must catch this
    and surface the dotted method path."""
    fake_bindings: Tuple[Tuple[str, str, Any], ...] = (
        ("wayflowcore.steps", "ApiCallStep", "method_that_does_not_exist"),
    )
    monkeypatch.setattr(agent_loader, "_LIVE_CLASS_BINDINGS", fake_bindings)

    with pytest.raises(RuntimeError) as excinfo:
        agent_loader._validate_live_class_names()

    assert "ApiCallStep.method_that_does_not_exist" in str(excinfo.value)


def test_validate_live_class_names_collects_all_missing_in_one_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One failed bump should report every break at once, not one per run."""
    fake_bindings: Tuple[Tuple[str, str, Any], ...] = (
        ("wayflowcore.steps", "GoneA", None),
        ("wayflowcore.steps", "GoneB", None),
        ("wayflowcore.steps", "ApiCallStep", "gone_method"),
    )
    monkeypatch.setattr(agent_loader, "_LIVE_CLASS_BINDINGS", fake_bindings)

    with pytest.raises(RuntimeError) as excinfo:
        agent_loader._validate_live_class_names()

    msg = str(excinfo.value)
    assert "GoneA" in msg
    assert "GoneB" in msg
    assert "ApiCallStep.gone_method" in msg


def test_predicate_step_names_are_listed_in_bindings() -> None:
    """Coupling check: the chat-step class names hard-coded in
    `_is_apinode_only_flow` MUST appear in `_LIVE_CLASS_BINDINGS`. Otherwise
    the guard would not catch a wayflowcore rename of those exact classes —
    which is the very bug class this guard exists for."""
    predicate_classes = {"InputMessageStep", "AgentExecutionStep"}
    binding_classes = {cls for _, cls, _ in agent_loader._LIVE_CLASS_BINDINGS}
    missing = predicate_classes - binding_classes
    assert not missing, (
        f"_is_apinode_only_flow names {sorted(missing)} but they are not in "
        f"_LIVE_CLASS_BINDINGS — wayflowcore renames of these classes would "
        f"silently break the predicate without tripping the guard."
    )
