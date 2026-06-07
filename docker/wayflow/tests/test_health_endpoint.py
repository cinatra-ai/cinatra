"""/.health known-good fixture test.

Asserts /.health returns 200 + degraded-aware JSON shape on a known-good
fixture with no broken agents. status must be "ok"; failed must be 0;
failed_agents must be the empty list.
"""

from __future__ import annotations

import pytest

from agent_loader import build_parent_app


@pytest.mark.asyncio
async def test_health_returns_ok_with_zero_failed(
    agents_dir, http_client_factory
) -> None:
    """Three known-good agents → status: ok, failed: 0, failed_agents: []."""
    root = agents_dir(
        ("cinatra", "email-recipient-selection-agent"),
        ("cinatra", "email-drafting-agent"),
        ("cinatra", "email-outreach-agent"),
    )
    app = build_parent_app(root)

    async with http_client_factory(app) as client:
        r = await client.get("/.health")

    assert r.status_code == 200, f"/.health unreachable: {r.status_code} {r.text!r}"
    body = r.json()
    assert body.get("status") == "ok", f"expected status=ok, got {body!r}"
    assert body.get("agents") == 3, f"expected agents=3, got {body!r}"
    assert body.get("failed") == 0, (
        f"expected failed=0 on known-good fixture, got {body!r}"
    )
    assert body.get("failed_agents") == [], (
        f"expected failed_agents=[], got {body!r}"
    )
