"""Hermetic contract for ``agent_loader._extract_endnode_outputs``.

Locks the helper's behavior independent of a live wayflowcore install. The
canonical wayflowcore 26.1.x attribute path is ``FinishedStatus.output_values``;
this test uses stub objects that mirror the three fallback paths and confirms
filtering against ``assistant.output_descriptors_dict`` + dropping of
non-JSONable values.

The synthetic A2A DataPart message that ``_patched_run_task`` appends on
FinishedStatus carries the extracted dict under
``__cinatra_endnode_outputs__`` so the Cinatra dispatcher can persist
structured EndNode outputs into ``agent_runs.step_results[0].output_data``
without parsing the lossy text history.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional

import pytest

from agent_loader import (
    CINATRA_ENDNODE_OUTPUTS_SENTINEL,
    _extract_endnode_outputs,
    _is_jsonable,
)


# ---------------------------------------------------------------------------
# Stub fixtures — keep contract tests independent of wayflowcore imports.
# ---------------------------------------------------------------------------


@dataclass
class _FakeStatus:
    """Mimics ``FinishedStatus.output_values: Dict[str, Any]`` only."""

    output_values: Optional[Dict[str, Any]] = None
    complete_step: Any = None  # for the fallback path


@dataclass
class _FakeFlowRun:
    output_values: Optional[Dict[str, Any]] = None


@dataclass
class _FakeConversation:
    flow_run: Any = None


@dataclass
class _FakeFlow:
    output_descriptors_dict: Optional[Dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Sentinel constant — matches the TS-side
# `packages/agents/src/execution.ts:CINATRA_ENDNODE_OUTPUTS_SENTINEL`.
# Keep both sides in sync.
# ---------------------------------------------------------------------------


def test_sentinel_constant_value() -> None:
    assert CINATRA_ENDNODE_OUTPUTS_SENTINEL == "__cinatra_endnode_outputs__"


# ---------------------------------------------------------------------------
# Canonical path: FinishedStatus.output_values.
# ---------------------------------------------------------------------------


def test_extracts_from_status_output_values_canonical() -> None:
    status = _FakeStatus(output_values={"transcript": "Hello", "kind": "audio"})
    conversation = _FakeConversation()
    flow = _FakeFlow(output_descriptors_dict={"transcript": None, "kind": None})
    result = _extract_endnode_outputs(status, conversation, flow)
    assert result == {"transcript": "Hello", "kind": "audio"}


def test_extracts_when_no_output_descriptors_dict_available() -> None:
    """No descriptor dict => no filtering applied (defensive)."""
    status = _FakeStatus(output_values={"transcript": "Hi", "extra": "shouldStay"})
    conversation = _FakeConversation()
    flow = _FakeFlow(output_descriptors_dict=None)
    result = _extract_endnode_outputs(status, conversation, flow)
    assert result == {"transcript": "Hi", "extra": "shouldStay"}


# ---------------------------------------------------------------------------
# Filtering: only declared keys survive when output_descriptors_dict is set.
# ---------------------------------------------------------------------------


def test_filters_to_declared_output_descriptor_keys() -> None:
    status = _FakeStatus(
        output_values={
            "transcript": "x",
            "kind": "audio",
            "internalState": "should-be-dropped",
        }
    )
    conversation = _FakeConversation()
    flow = _FakeFlow(output_descriptors_dict={"transcript": None, "kind": None})
    result = _extract_endnode_outputs(status, conversation, flow)
    assert result == {"transcript": "x", "kind": "audio"}
    assert "internalState" not in result


# ---------------------------------------------------------------------------
# Fallback paths: complete_step.values, conversation.flow_run.output_values.
# ---------------------------------------------------------------------------


def test_falls_back_to_complete_step_values() -> None:
    @dataclass
    class _CompleteStep:
        values: Optional[Dict[str, Any]] = None

    status = _FakeStatus(output_values=None, complete_step=_CompleteStep(values={"transcript": "fallback"}))
    conversation = _FakeConversation()
    flow = _FakeFlow(output_descriptors_dict={"transcript": None})
    result = _extract_endnode_outputs(status, conversation, flow)
    assert result == {"transcript": "fallback"}


def test_falls_back_to_conversation_flow_run_output_values() -> None:
    status = _FakeStatus(output_values=None)
    conversation = _FakeConversation(flow_run=_FakeFlowRun(output_values={"transcript": "from_flow_run"}))
    flow = _FakeFlow(output_descriptors_dict={"transcript": None})
    result = _extract_endnode_outputs(status, conversation, flow)
    assert result == {"transcript": "from_flow_run"}


def test_picks_canonical_path_over_fallbacks_when_present() -> None:
    """If status.output_values is non-empty, fallbacks must NOT win — even when present."""
    @dataclass
    class _CompleteStep:
        values: Optional[Dict[str, Any]] = None

    status = _FakeStatus(
        output_values={"transcript": "canonical"},
        complete_step=_CompleteStep(values={"transcript": "fallback"}),
    )
    conversation = _FakeConversation(flow_run=_FakeFlowRun(output_values={"transcript": "fallback2"}))
    flow = _FakeFlow(output_descriptors_dict={"transcript": None})
    result = _extract_endnode_outputs(status, conversation, flow)
    assert result == {"transcript": "canonical"}


# ---------------------------------------------------------------------------
# Empty / missing paths.
# ---------------------------------------------------------------------------


def test_returns_empty_dict_when_no_output_values_anywhere() -> None:
    status = _FakeStatus(output_values=None)
    conversation = _FakeConversation()
    flow = _FakeFlow(output_descriptors_dict={"transcript": None})
    result = _extract_endnode_outputs(status, conversation, flow)
    assert result == {}


def test_returns_empty_dict_when_output_values_is_empty_dict() -> None:
    status = _FakeStatus(output_values={})
    conversation = _FakeConversation()
    flow = _FakeFlow(output_descriptors_dict={"transcript": None})
    result = _extract_endnode_outputs(status, conversation, flow)
    assert result == {}


def test_returns_empty_dict_when_status_has_no_output_values_attr() -> None:
    """Defensive — status object with no relevant attrs at all."""
    class _MinimalStatus:  # noqa: D401 — fixture class
        pass

    flow = _FakeFlow(output_descriptors_dict={"transcript": None})
    result = _extract_endnode_outputs(_MinimalStatus(), _FakeConversation(), flow)
    assert result == {}


# ---------------------------------------------------------------------------
# JSONability filter — non-jsonable values get dropped silently.
# ---------------------------------------------------------------------------


def test_drops_non_jsonable_values_silently() -> None:
    class _NotJsonable:
        def __init__(self) -> None:
            self.x = 1

    status = _FakeStatus(
        output_values={
            "transcript": "ok",
            "byte_blob": b"raw bytes",
            "object": _NotJsonable(),
        }
    )
    flow = _FakeFlow(output_descriptors_dict={"transcript": None, "byte_blob": None, "object": None})
    result = _extract_endnode_outputs(status, _FakeConversation(), flow)
    assert result == {"transcript": "ok"}


def test_is_jsonable_truth_table() -> None:
    assert _is_jsonable(None) is True
    assert _is_jsonable(True) is True
    assert _is_jsonable(0) is True
    assert _is_jsonable(0.5) is True
    assert _is_jsonable("hello") is True
    assert _is_jsonable([1, "a", None]) is True
    assert _is_jsonable({"a": 1, "b": [None]}) is True
    # Non-jsonable
    assert _is_jsonable(b"bytes") is False
    assert _is_jsonable({1: "non-str-key"}) is False
    assert _is_jsonable({"k": object()}) is False
    assert _is_jsonable(set()) is False


# ---------------------------------------------------------------------------
# Nested structures — list/dict containers preserved verbatim.
# ---------------------------------------------------------------------------


def test_preserves_nested_lists_and_dicts() -> None:
    nested = {
        "items": [
            {"name": "alice", "url": "https://example.com/a"},
            {"name": "bob", "url": "https://example.com/b"},
        ],
        "failures": [],
        "extractionNotes": "n=2",
    }
    status = _FakeStatus(output_values=nested)
    flow = _FakeFlow(output_descriptors_dict={"items": None, "failures": None, "extractionNotes": None})
    result = _extract_endnode_outputs(status, _FakeConversation(), flow)
    assert result == nested


# ---------------------------------------------------------------------------
# Defensive: malformed shapes must NOT raise.
# ---------------------------------------------------------------------------


def test_does_not_raise_on_malformed_status_shape() -> None:
    @dataclass
    class _Weird:
        output_values: int = 42  # wrong type — should be ignored

    flow = _FakeFlow(output_descriptors_dict={"x": None})
    result = _extract_endnode_outputs(_Weird(), _FakeConversation(), flow)
    assert result == {}


def test_skips_non_string_keys() -> None:
    """Non-str dict keys in output_values are dropped (json-incompatible)."""
    status = _FakeStatus(output_values={"good": "v1", 42: "v2"})  # type: ignore[dict-item]
    flow = _FakeFlow(output_descriptors_dict=None)
    result = _extract_endnode_outputs(status, _FakeConversation(), flow)
    assert result == {"good": "v1"}
