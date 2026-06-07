"""Structural ApiNode-only predicate.

The original `_patch_serve_agent_flow_validation` matched the substring
`"Only support Flow"` against wayflowcore's free-text ValueError message.
That contract is fragile: any wayflowcore patch release that rewords the
message flips the match to false, and every ApiNode-only flow
(drupal/wordpress content editors) fails to mount.

Replacement: structural check on the agent's `flow.steps` shape.
This test exercises the predicate directly with stubs — no wayflowcore
import required.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

# Make agent_loader importable; mirrors conftest.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent_loader import _is_apinode_only_flow  # noqa: E402


# Stand-in classes whose __name__ matches the wayflowcore step class names
# the predicate gates on. The predicate compares by `type(step).__name__`
# so wayflowcore does not need to be installed for this test.
class ApiCallStep:  # noqa: D401
    pass


class EndStep:  # noqa: D401
    pass


class InputMessageStep:  # noqa: D401
    pass


class AgentExecutionStep:  # noqa: D401
    pass


def _agent(steps: Any) -> Any:
    """Build a minimal stub agent with the shape `_is_apinode_only_flow` expects."""
    flow = SimpleNamespace(steps=steps)
    return SimpleNamespace(flow=flow)


def test_returns_true_for_pure_apicall_steps_list() -> None:
    agent = _agent([ApiCallStep(), ApiCallStep(), EndStep()])
    assert _is_apinode_only_flow(agent) is True


def test_returns_true_for_pure_apicall_steps_dict() -> None:
    agent = _agent({"a": ApiCallStep(), "b": EndStep()})
    assert _is_apinode_only_flow(agent) is True


def test_returns_false_when_input_message_step_present() -> None:
    agent = _agent([ApiCallStep(), InputMessageStep(), EndStep()])
    assert _is_apinode_only_flow(agent) is False


def test_returns_false_when_agent_execution_step_present() -> None:
    agent = _agent([ApiCallStep(), AgentExecutionStep()])
    assert _is_apinode_only_flow(agent) is False


def test_returns_false_when_no_flow_attribute() -> None:
    agent = SimpleNamespace()  # no `flow`
    assert _is_apinode_only_flow(agent) is False


def test_returns_false_when_steps_empty_list() -> None:
    agent = _agent([])
    assert _is_apinode_only_flow(agent) is False


def test_returns_false_when_steps_is_unexpected_type() -> None:
    agent = _agent("not-a-list")
    assert _is_apinode_only_flow(agent) is False


def test_returns_false_when_flow_is_none() -> None:
    agent = SimpleNamespace(flow=None)
    assert _is_apinode_only_flow(agent) is False
