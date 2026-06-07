"""Bridge-token patches are global and idempotent.

Patch presence is asserted via the `__cinatra_patched__` sentinel directly,
not via fragile qualname or identity inspection. The second test proves
that re-running `build_parent_app` does NOT chain a second wrapper on top
of an already-patched method (the sentinel short-circuits re-patching).
"""

from __future__ import annotations

import httpx
import pytest

from wayflowcore.steps import ApiCallStep
from wayflowcore.a2a.a2aagent import A2AAgent
from wayflowcore.agentserver.server import A2AServer

from agent_loader import build_parent_app


def test_bridge_token_patches_set_sentinel(agents_dir, monkeypatch) -> None:
    """All four patches set __cinatra_patched__ on their target method."""
    monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", "test-token-deadbeef")
    monkeypatch.setenv("CINATRA_BASE_URL", "http://host.docker.internal:3000")
    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    _ = build_parent_app(root)

    # ApiCallStep._execute_request
    assert getattr(
        ApiCallStep._execute_request, "__cinatra_patched__", False
    ) is True, (
        "_patch_api_call_step_bridge_token did not set __cinatra_patched__ "
        "sentinel on ApiCallStep._execute_request patch missing"
    )
    # httpx.AsyncClient.send
    assert getattr(
        httpx.AsyncClient.send, "__cinatra_patched__", False
    ) is True, (
        "_patch_a2a_agent_bridge_token did not set __cinatra_patched__ "
        "sentinel on httpx.AsyncClient.send patch missing"
    )
    # A2AAgent.start_conversation
    assert getattr(
        A2AAgent.start_conversation, "__cinatra_patched__", False
    ) is True, (
        "_patch_a2a_agent_no_shared_conversation did not set "
        "__cinatra_patched__ sentinel on A2AAgent.start_conversation"
    )
    # A2AServer.serve_agent
    assert getattr(
        A2AServer.serve_agent, "__cinatra_patched__", False
    ) is True, (
        "_patch_serve_agent_flow_validation did not set __cinatra_patched__ "
        "sentinel on A2AServer.serve_agent patch missing"
    )


def test_bridge_token_patches_idempotent(agents_dir, monkeypatch) -> None:
    """Re-running build_parent_app must not re-wrap an already-patched method."""
    monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", "test-token-deadbeef")
    monkeypatch.setenv("CINATRA_BASE_URL", "http://host.docker.internal:3000")
    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    _ = build_parent_app(root)

    first_send = httpx.AsyncClient.send
    first_exec = ApiCallStep._execute_request
    first_start = A2AAgent.start_conversation
    first_serve = A2AServer.serve_agent

    # Build again - sentinel must short-circuit re-patch.
    _ = build_parent_app(root)

    assert httpx.AsyncClient.send is first_send, (
        "send was re-wrapped - patch not idempotent"
    )
    assert ApiCallStep._execute_request is first_exec, (
        "_execute_request was re-wrapped - patch not idempotent"
    )
    assert A2AAgent.start_conversation is first_start, (
        "start_conversation was re-wrapped - patch not idempotent"
    )
    assert A2AServer.serve_agent is first_serve, (
        "serve_agent was re-wrapped - patch not idempotent"
    )
