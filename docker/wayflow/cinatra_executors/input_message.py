"""
CinatraInputMessageNodeExecutor.

Custom Step implementation for InputMessageNode. WayFlow's InputMessageNode
pauses flow execution and waits for user input via the A2A protocol. This
executor is NOT needed for standard InputMessageNode behaviour - WayFlow handles
it natively. It is registered here as a reference scaffold for future custom
HITL extensions.

WayFlow API (wayflowcore 26.1.x):
  - Custom steps extend wayflowcore.Step
  - Override _invoke_step_async(inputs, conversation) -> StepResult
  - WayFlow's built-in InputMessageNode already emits A2A task-update events
    with state="input-required"; Cinatra's dispatcher detects those events and
    transitions the run to pending_approval.

Keys stripped from inputs before exposing in HITL payloads:
  bearer_token, api_key, a2a_bearer_token, mcp_server_url, password, secret,
  token, access_token, refresh_token
"""

from typing import Any, Dict, List, Union

# Credential scrubber design note:
# _CREDENTIAL_KEYS protects PAYLOAD DATA keys - keys that may appear inside
# `inputs` dicts collected from prior nodes during a flow. Process-level
# secrets like CINATRA_BRIDGE_TOKEN live in os.environ and are injected into
# HTTP request headers by agent_loader._patch_api_call_step_bridge_token -
# they NEVER flow through executor inputs and so are NOT (and should not be)
# in this set. Adding CINATRA_BRIDGE_TOKEN here would not protect anything
# (the token never reaches a payload dict) and would silently strip a
# legitimate user-input field that happens to be named "cinatra_bridge_token".
_CREDENTIAL_KEYS = frozenset({
    "bearer_token", "api_key", "a2a_bearer_token", "mcp_server_url",
    "password", "secret", "token", "access_token", "refresh_token",
})


def _scrub_credentials(value: Any) -> Any:
    """Recursively strip credential keys from dicts and lists."""
    if isinstance(value, dict):
        return {k: _scrub_credentials(v) for k, v in value.items() if k not in _CREDENTIAL_KEYS}
    if isinstance(value, list):
        return [_scrub_credentials(item) for item in value]
    return value

try:
    from wayflowcore import Step  # type: ignore[import-not-found]
    from wayflowcore.steps.step import StepResult  # type: ignore[import-not-found]
except Exception:  # pragma: no cover
    class Step:  # type: ignore[no-redef]
        """Stub used only when wayflowcore is not installed (dev/typecheck)."""
        async def _invoke_step_async(self, inputs: Dict[str, Any], conversation: Any) -> Any:
            raise NotImplementedError("WayFlow runtime not available")

    class StepResult:  # type: ignore[no-redef]
        def __init__(self, outputs: Dict[str, Any]) -> None:
            self.outputs = outputs


class CinatraInputMessageNodeExecutor(Step):
    """
    Scaffold step for InputMessageNode - WayFlow handles this natively.

    The A2A server emits an input-required event when it reaches an
    InputMessageNode. Cinatra's dispatcher (execution.ts) detects this and
    transitions the run to pending_approval. No custom executor logic is required;
    this class exists to validate that custom Step subclasses register correctly.
    """

    async def _invoke_step_async(
        self, inputs: Dict[str, Any], conversation: Any
    ) -> "StepResult":
        # Strip credentials before any processing. Recursive to catch nested objects.
        safe_inputs = _scrub_credentials(inputs)

        # WayFlow's built-in InputMessageNode handling fires the interrupt.
        # This custom step is a no-op scaffold.
        return StepResult(outputs=safe_inputs)
