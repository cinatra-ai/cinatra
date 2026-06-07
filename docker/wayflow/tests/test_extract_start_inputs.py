"""Hermetic contract for `agent_loader._extract_start_inputs`.

Locks in the parse/lift behavior + run-id propagation policy introduced to
fix the silent regression introduced by a prior change: stripping
`cinatra_run_id` from `inputs=` broke the 10 Flow agents that declare it
as a Flow input, and the 13 Flow agents that declare `agent_run_id` never
saw a run id at all because the dispatcher only sends `cinatra_run_id`.

The helper's contract (see its docstring in agent_loader.py):
  - Returns the parsed dict, with `agent_run_id` aliased from
    `cinatra_run_id` when missing.
  - DOES NOT strip `cinatra_run_id` — flows that declare it pick it up
    directly; flows that don't, ignore the extra key.
  - Returns None for any non-text / non-JSON / non-object / empty payload.
"""
from __future__ import annotations

from agent_loader import _extract_start_inputs, _filter_inputs_to_flow_schema


# ---------------------------------------------------------------------------
# Happy-path: JSON object payloads with both run-id naming conventions.
# ---------------------------------------------------------------------------


def test_lifts_simple_inputs() -> None:
    message = {
        "parts": [
            {"kind": "text", "text": '{"url": "https://example.com", "limit": 10}'}
        ]
    }
    assert _extract_start_inputs(message) == {
        "url": "https://example.com",
        "limit": 10,
    }


def test_preserves_cinatra_run_id_for_flows_that_declare_it() -> None:
    """The Flow agents (blog-*, contact-discovery, list-curator,
    company-discovery, trigger-agent, etc.) declare
    `cinatra_run_id` as a top-level Flow input. A prior change stripped it,
    leaving them with the `default: ""` and losing run-id propagation."""
    message = {
        "parts": [
            {"kind": "text", "text": '{"intent": "find AI tools", "cinatra_run_id": "run-abc"}'}
        ]
    }
    result = _extract_start_inputs(message)
    assert result is not None
    assert result["cinatra_run_id"] == "run-abc"


def test_aliases_cinatra_run_id_to_agent_run_id_when_missing() -> None:
    """The Flow agents (auditor-agent, agent-*-reviewer, email-*,
    reviewer-agent) declare `agent_run_id`
    instead of `cinatra_run_id`. The dispatcher only sends
    `cinatra_run_id`, so the loader must alias it across."""
    message = {
        "parts": [
            {"kind": "text", "text": '{"data": {"x": 1}, "cinatra_run_id": "run-xyz"}'}
        ]
    }
    result = _extract_start_inputs(message)
    assert result is not None
    assert result["cinatra_run_id"] == "run-xyz"
    assert result["agent_run_id"] == "run-xyz"


def test_does_not_overwrite_existing_agent_run_id() -> None:
    """If the caller explicitly sent `agent_run_id`, the alias must not
    clobber it — caller intent wins."""
    message = {
        "parts": [
            {
                "kind": "text",
                "text": '{"cinatra_run_id": "run-1", "agent_run_id": "run-2"}',
            }
        ]
    }
    result = _extract_start_inputs(message)
    assert result is not None
    assert result["cinatra_run_id"] == "run-1"
    assert result["agent_run_id"] == "run-2"


def test_does_not_inject_agent_run_id_when_cinatra_run_id_absent() -> None:
    message = {"parts": [{"kind": "text", "text": '{"url": "https://example.com"}'}]}
    result = _extract_start_inputs(message)
    assert result is not None
    assert "agent_run_id" not in result


def test_does_not_alias_when_cinatra_run_id_is_empty_string() -> None:
    """The dispatcher sends `cinatra_run_id: run.id` which is always a
    non-empty UUID. An empty `cinatra_run_id` would indicate a malformed
    caller; do NOT alias empty across — keep behavior conservative."""
    message = {
        "parts": [
            {"kind": "text", "text": '{"cinatra_run_id": "", "data": {}}'}
        ]
    }
    result = _extract_start_inputs(message)
    assert result is not None
    assert "agent_run_id" not in result


def test_lifts_nested_object_value_unchanged() -> None:
    """web-scrape-agent's `outputSchema` is `{type:"object", properties:{...}}`.
    The helper must preserve nested objects, not flatten or stringify them."""
    nested = {
        "outputSchema": {"type": "object", "properties": {"name": {"type": "string"}}},
        "seedUrls": ["https://example.com"],
    }
    import json

    message = {"parts": [{"kind": "text", "text": json.dumps(nested)}]}
    result = _extract_start_inputs(message)
    assert result == nested


# ---------------------------------------------------------------------------
# Fallback paths: helper returns None so caller uses messages-only.
# ---------------------------------------------------------------------------


def test_returns_none_for_no_message() -> None:
    assert _extract_start_inputs(None) is None


def test_returns_none_for_message_without_parts() -> None:
    assert _extract_start_inputs({"role": "user"}) is None


def test_returns_none_for_empty_parts_array() -> None:
    assert _extract_start_inputs({"parts": []}) is None


def test_returns_none_for_non_text_part() -> None:
    """Binary / image / file parts must fall back to messages-only — the
    helper does not try to deserialize them."""
    message = {"parts": [{"kind": "image", "url": "https://example.com/x.png"}]}
    assert _extract_start_inputs(message) is None


def test_returns_none_for_part_with_non_string_text() -> None:
    """Defensive: a malformed part where `text` is e.g. a dict."""
    message = {"parts": [{"kind": "text", "text": {"not": "a string"}}]}
    assert _extract_start_inputs(message) is None


def test_returns_none_for_conversational_text() -> None:
    """A real chat agent sends free-text user prompts, not JSON. The
    helper must NOT try to crowbar the text into inputs — fall back so
    the conversation message reaches the agent unmodified."""
    message = {"parts": [{"kind": "text", "text": "Hello, what's the weather?"}]}
    assert _extract_start_inputs(message) is None


def test_returns_none_for_json_array() -> None:
    """JSON arrays / scalars are not dicts → not a valid inputs payload."""
    message = {"parts": [{"kind": "text", "text": '["a", "b"]'}]}
    assert _extract_start_inputs(message) is None


def test_returns_none_for_json_scalar() -> None:
    message = {"parts": [{"kind": "text", "text": '"just a string"'}]}
    assert _extract_start_inputs(message) is None


def test_returns_none_for_empty_object() -> None:
    """The dispatcher sends `{"cinatra_run_id": run.id}` even when
    `inputParams` is empty. The prior filter then produced `{}` — falsy,
    so caller fell back to messages-only. With our new policy we KEEP
    `cinatra_run_id`, so an empty caller payload yields `{cinatra_run_id:
    "run-..."}` which is truthy; this guard only fires for genuinely
    empty JSON `{}`. Either way, an empty dict means no useful inputs to
    lift — return None so caller falls back."""
    message = {"parts": [{"kind": "text", "text": "{}"}]}
    assert _extract_start_inputs(message) is None


def test_returns_none_for_invalid_json() -> None:
    message = {"parts": [{"kind": "text", "text": "{not valid json"}]}
    assert _extract_start_inputs(message) is None


# ---------------------------------------------------------------------------
# _filter_inputs_to_flow_schema — keep only keys the Flow's StartNode declares.
#
# WayFlow raises `ValueError: Input 'X' passed to start conversation is not
# an expected input of the Flow` for ANY unknown key. The dispatcher always
# sends `cinatra_run_id`; the alias above adds `agent_run_id`. Each Flow
# declares ONE of the two — filtering against the schema makes both safe.
# ---------------------------------------------------------------------------


class _FakeAssistant:
    """Minimal stand-in for wayflowcore.Flow exposing only the attribute
    `_filter_inputs_to_flow_schema` needs (`input_descriptors_dict`)."""

    def __init__(self, declared_names):
        self.input_descriptors_dict = {n: object() for n in declared_names}


def test_filter_keeps_cinatra_run_id_for_blog_idea_generator_style_flow() -> None:
    """blog-idea-generator-agent declares `cinatra_run_id` but NOT
    `agent_run_id`. Filter must keep `cinatra_run_id` and drop the alias
    added by _extract_start_inputs."""
    inputs = {
        "brief": "AI tools",
        "cinatra_run_id": "run-1",
        "agent_run_id": "run-1",  # added by alias logic
    }
    assistant = _FakeAssistant(["brief", "cinatra_run_id"])
    result = _filter_inputs_to_flow_schema(inputs, assistant)
    assert result == {"brief": "AI tools", "cinatra_run_id": "run-1"}


def test_filter_keeps_agent_run_id_for_auditor_agent_style_flow() -> None:
    """auditor-agent declares `agent_run_id` but NOT `cinatra_run_id`.
    Filter must drop `cinatra_run_id` and keep the alias."""
    inputs = {
        "data": {"foo": "bar"},
        "cinatra_run_id": "run-1",
        "agent_run_id": "run-1",  # added by alias logic
    }
    assistant = _FakeAssistant(["data", "agent_run_id"])
    result = _filter_inputs_to_flow_schema(inputs, assistant)
    assert result == {"data": {"foo": "bar"}, "agent_run_id": "run-1"}


def test_filter_returns_input_unchanged_for_assistant_without_schema() -> None:
    """Defensive: older wayflowcore / non-Flow assistants may not expose
    `input_descriptors_dict`. Don't silently drop inputs in that case —
    the caller's TypeError / ValueError handlers cover any drift."""
    inputs = {"a": 1, "b": 2}

    class _NoSchema:
        pass

    assert _filter_inputs_to_flow_schema(inputs, _NoSchema()) == inputs


def test_filter_returns_none_for_none_input() -> None:
    assistant = _FakeAssistant(["a"])
    assert _filter_inputs_to_flow_schema(None, assistant) is None


def test_filter_returns_empty_for_empty_input() -> None:
    assistant = _FakeAssistant(["a"])
    assert _filter_inputs_to_flow_schema({}, assistant) == {}


def test_filter_returns_empty_when_no_keys_match() -> None:
    """All caller keys are unknown to the Flow — filter strips them all.
    The downstream call site treats an empty dict as 'fall back to
    messages-only' so the Flow's defaults can apply."""
    inputs = {"random_key": "ignored"}
    assistant = _FakeAssistant(["data"])
    assert _filter_inputs_to_flow_schema(inputs, assistant) == {}
