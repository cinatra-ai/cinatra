"""Two-vendor / same-slug isolation.

Asserts that the SAME slug (`email-outreach-agent`) under two DIFFERENT
vendors (`@cinatra/...` vs `@acme/...`) produces TWO distinct mount paths
that both serve their AgentCards independently — there is no
last-writer-wins shared-state bug.
"""

from __future__ import annotations

import pytest

from agent_loader import build_parent_app


@pytest.mark.asyncio
async def test_same_slug_under_different_vendors(
    agents_dir, monkeypatch, http_client_factory
) -> None:
    """@cinatra-ai/email-outreach-agent and @acme/email-outreach-agent both reachable."""
    monkeypatch.setenv("WAYFLOW_BASE_URL", "http://test:3010")
    root = agents_dir(
        ("cinatra", "email-outreach-agent"),
        ("acme", "email-outreach-agent"),
    )
    app = build_parent_app(root)  # Build after tree seeded.

    async with http_client_factory(app) as client:
        r1 = await client.get(
            "/agents/cinatra/email-outreach-agent/.well-known/agent-card.json"
        )
        r2 = await client.get(
            "/agents/acme/email-outreach-agent/.well-known/agent-card.json"
        )

    assert r1.status_code == 200, (
        f"@cinatra unreachable: {r1.status_code} {r1.text!r}"
    )
    assert r2.status_code == 200, (
        f"@acme unreachable: {r2.status_code} {r2.text!r}"
    )
    body1 = r1.json()
    body2 = r2.json()
    # Both AgentCards exist as JSON. The url fields must differ — proving
    # mounts are not collapsed onto one shared A2AServer.
    assert body1.get("url") != body2.get("url"), (
        f"both AgentCards reported the same url; expected distinct mount "
        f"paths under @cinatra vs @acme. body1={body1!r}, body2={body2!r}"
    )
    assert "/agents/cinatra/email-outreach-agent" in (body1.get("url") or "")
    assert "/agents/acme/email-outreach-agent" in (body2.get("url") or "")
