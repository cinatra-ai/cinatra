"""approval_gate.py strips credential keys."""
import asyncio

from cinatra_executors.approval_gate import (
    CinatraApprovalGateExecutor,
    _CREDENTIAL_KEYS,
)


def test_credential_keys_set_matches_input_message() -> None:
    """The two strip lists MUST be identical -- defense-in-depth requires
    consistent coverage across both executors."""
    from cinatra_executors.input_message import _CREDENTIAL_KEYS as IM_KEYS
    assert _CREDENTIAL_KEYS == IM_KEYS, (
        f"approval_gate._CREDENTIAL_KEYS ({_CREDENTIAL_KEYS}) must equal "
        f"input_message._CREDENTIAL_KEYS ({IM_KEYS})"
    )


def test_invoke_strips_credential_fields() -> None:
    """The executor MUST remove every credential key from outputs even if the
    caller passes them in inputs."""
    executor = CinatraApprovalGateExecutor()
    inputs = {
        "campaignId": "abc",
        "bearer_token": "secret",
        "api_key": "leak",
        "a2a_bearer_token": "leak2",
        "draftBundle": {"x": 1},
    }
    result = asyncio.run(executor._invoke_step_async(inputs, conversation=None))
    assert result.outputs == {"campaignId": "abc", "draftBundle": {"x": 1}}
    assert "bearer_token" not in result.outputs
    assert "api_key" not in result.outputs
    assert "a2a_bearer_token" not in result.outputs


def test_invoke_strips_nested_credential_fields() -> None:
    """Credential keys nested inside dicts or arrays MUST also be stripped."""
    executor = CinatraApprovalGateExecutor()
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
