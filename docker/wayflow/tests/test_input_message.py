"""Regression coverage for input_message.py credential stripping.

These tests guard against credential leaks in executor outputs.
"""
import asyncio

from cinatra_executors.input_message import CinatraInputMessageNodeExecutor


def test_invoke_strips_credential_fields() -> None:
    executor = CinatraInputMessageNodeExecutor()
    inputs = {"campaignId": "abc", "bearer_token": "secret", "api_key": "leak"}
    result = asyncio.run(executor._invoke_step_async(inputs, conversation=None))
    assert result.outputs == {"campaignId": "abc"}
    assert "bearer_token" not in result.outputs
    assert "api_key" not in result.outputs


def test_invoke_strips_nested_credential_fields() -> None:
    """Credential keys nested inside dicts or arrays MUST also be stripped."""
    executor = CinatraInputMessageNodeExecutor()
    inputs = {
        "campaignId": "abc",
        "connectionConfig": {"bearer_token": "nested-secret", "endpoint": "http://example.com"},
        "steps": [{"api_key": "step-key", "action": "send"}],
    }
    result = asyncio.run(executor._invoke_step_async(inputs, conversation=None))
    assert result.outputs["connectionConfig"] == {"endpoint": "http://example.com"}
    assert result.outputs["steps"] == [{"action": "send"}]
    assert "bearer_token" not in result.outputs["connectionConfig"]
    assert "api_key" not in result.outputs["steps"][0]


# agent_loader._substitute_placeholders verification.

def test_substitute_placeholders_replaces_cinatra_base_url(monkeypatch) -> None:
    monkeypatch.setenv("CINATRA_BASE_URL", "http://example.test:9000")
    from agent_loader import _substitute_placeholders
    result = _substitute_placeholders("agent_url: {{CINATRA_BASE_URL}}/api/a2a/agents/foo")
    assert result == "agent_url: http://example.test:9000/api/a2a/agents/foo"


def test_substitute_placeholders_default_base_url(monkeypatch) -> None:
    monkeypatch.delenv("CINATRA_BASE_URL", raising=False)
    from agent_loader import _substitute_placeholders
    result = _substitute_placeholders("{{CINATRA_BASE_URL}}/x")
    assert result == "http://host.docker.internal:3000/x"


def test_substitute_placeholders_unknown_var_unchanged(monkeypatch) -> None:
    monkeypatch.delenv("UNKNOWN_VAR", raising=False)
    from agent_loader import _substitute_placeholders
    result = _substitute_placeholders("hello {{UNKNOWN_VAR}} world")
    assert result == "hello {{UNKNOWN_VAR}} world"


def test_substitute_placeholders_json_escapes_special_chars(monkeypatch) -> None:
    """Env var values with quotes or newlines must be JSON-escaped so the
    substituted text does not break the surrounding JSON document."""
    monkeypatch.setenv("MY_VAR", 'hello "world"\nline2')
    from agent_loader import _substitute_placeholders
    result = _substitute_placeholders('{"key": "{{MY_VAR}}"}')
    assert result == '{"key": "hello \\"world\\"\\nline2"}'
