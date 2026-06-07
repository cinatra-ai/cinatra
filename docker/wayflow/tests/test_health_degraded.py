"""/.health degraded fixture test.

Asserts that a per-agent load failure surfaces as `status: degraded` +
`failed >= 1` + the broken agent path in `failed_agents`. Uses one good
seed + one broken oas.json (invalid JSON) so the loader's per-agent
try/except branch is exercised.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_loader import build_parent_app


@pytest.mark.asyncio
async def test_health_returns_degraded_when_an_agent_fails_to_load(
    tmp_path: Path, http_client_factory
) -> None:
    """Per-agent load failure returns status: degraded and failed > 0.

    We seed one good agent (just the metadata.cinatra.packageName envelope —
    enough for discover_agents to find it) and one with broken JSON. The
    good agent will not load via AgentSpecLoader because the metadata-only
    envelope is incomplete, so it ALSO ends up in failed_agents — but that
    is fine for this test: we only assert `failed >= 1` and that the
    broken-agent entry is present.
    """
    good = tmp_path / "cinatra" / "email-recipient-selection-agent" / "cinatra"
    good.mkdir(parents=True)
    (good / "oas.json").write_text(
        json.dumps(
            {
                "metadata": {
                    "cinatra": {"packageName": "@cinatra-ai/email-recipient-selection-agent"}
                }
            }
        ),
        encoding="utf-8",
    )

    bad = tmp_path / "cinatra" / "broken-agent" / "cinatra"
    bad.mkdir(parents=True)
    # Discover-time parse failure: extract_vendor_slug raises on this body
    # before the AgentSpecLoader is ever called. The broken agent surfaces
    # in the discovery skip log, not failed_agents — so we ALSO seed a
    # second broken-but-discoverable agent below, whose oas.json passes
    # discovery (valid JSON, valid packageName) but FAILS in
    # AgentSpecLoader.load_json (no nodes / spec_version mismatch).
    (bad / "oas.json").write_text("not-valid-json{{{", encoding="utf-8")

    discoverable_but_broken = (
        tmp_path / "cinatra" / "discoverable-broken-agent" / "cinatra"
    )
    discoverable_but_broken.mkdir(parents=True)
    (discoverable_but_broken / "oas.json").write_text(
        json.dumps(
            {
                "metadata": {
                    "cinatra": {
                        "packageName": "@cinatra/discoverable-broken-agent"
                    }
                },
                "spec_version": "not-a-real-version",
            }
        ),
        encoding="utf-8",
    )

    app = build_parent_app(tmp_path)
    async with http_client_factory(app) as client:
        r = await client.get("/.health")

    assert r.status_code == 200, f"/.health unreachable: {r.status_code} {r.text!r}"
    body = r.json()
    assert body.get("status") == "degraded", (
        f"expected status=degraded with broken fixture, got {body!r}"
    )
    assert body.get("failed", 0) >= 1, (
        f"expected failed>=1 with broken fixture, got {body!r}"
    )
    failed_paths = body.get("failed_agents") or []
    assert any("discoverable-broken-agent" in p for p in failed_paths), (
        f"failed_agents must include the discoverable-broken-agent path, "
        f"got {failed_paths!r}"
    )
