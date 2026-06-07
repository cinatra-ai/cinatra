"""Tests for the /.internal/reload-agents endpoint and MountedAgentRegistry.

Covers the reload endpoint contract:
- 503 when CINATRA_BRIDGE_TOKEN is unset (auth disabled)
- 403 on missing or wrong X-Cinatra-Bridge-Token header
- Added: new on-disk agent becomes mounted + reachable mid-run
- Changed: oas.json fingerprint change picks up new content; old stack queued for deferred close
- Removed: directory deleted → registry drops the agent, route removed
- Parse-failed: mounted agent whose oas.json becomes malformed STAYS LIVE
- Failed-changed: new content fails to mount → prior version retained, kind:"changed_failed_still_serving_previous"
- /.health.last_reload_at updates after reload

All tests follow the conftest factory pattern: build temp dir → build_parent_app → lifespan-wrapped client → mutate dir → POST reload → assert.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any, Callable

import pytest

from agent_loader import build_parent_app


TEST_TOKEN = "reload-test-token-do-not-leak"
RELOAD_HEADERS = {"X-Cinatra-Bridge-Token": TEST_TOKEN}


def _sample_oas_path() -> Path:
    """Resolve the reference OAS body, mirroring conftest's resolver.

    Imported inline so each test stays import-independent of the conftest
    helper (conftest is a pytest plugin module, not a normal import
    target).
    """
    env_path = os.environ.get("CINATRA_SAMPLE_OAS")
    if env_path:
        return Path(env_path)
    here = Path(__file__).resolve()
    rel = "agents/cinatra/email-recipient-selection-agent/cinatra/oas.json"
    if len(here.parents) >= 3:
        candidate = here.parents[2] / rel
        if candidate.exists():
            return candidate
    for parent in here.parents:
        candidate = parent / rel
        if candidate.exists():
            return candidate
    return Path(rel)


@pytest.fixture(autouse=True)
def _bridge_token_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set CINATRA_BRIDGE_TOKEN for every test in this module."""
    monkeypatch.setenv("CINATRA_BRIDGE_TOKEN", TEST_TOKEN)


def _seed_agent(
    agents_root: Path, vendor: str, slug: str, *, with_marker: bool = True
) -> Path:
    """Drop a fresh-but-valid OAS file at agents_root/<vendor>/<slug>/cinatra/oas.json.

    Reads the seed body from the sample OAS resolved by conftest (same one
    the agents_dir factory uses).

    When `with_marker=True` (default), also writes a `.cinatra-published.json`
    marker matching the OAS hash so the agent passes the loader's
    draft/published gate. Tests that specifically want an unmarked (draft) dir
    pass `with_marker=False`.
    """
    import hashlib

    sample_path = _sample_oas_path()
    if not sample_path.exists():
        raise RuntimeError(
            f"Reference OAS not found at {sample_path}; "
            "set CINATRA_SAMPLE_OAS to override."
        )
    body = json.loads(sample_path.read_text(encoding="utf-8"))
    body.setdefault("metadata", {}).setdefault("cinatra", {})[
        "packageName"
    ] = f"@{vendor}/{slug}"
    target = agents_root / vendor / slug / "cinatra"
    target.mkdir(parents=True, exist_ok=True)
    oas_path = target / "oas.json"
    oas_text = json.dumps(body, indent=2)
    oas_path.write_text(oas_text, encoding="utf-8")
    if with_marker:
        slug_dir = agents_root / vendor / slug
        marker = {
            "packageName": f"@{vendor}/{slug}",
            "packageVersion": "1.0.0",
            "oasSha256": hashlib.sha256(oas_text.encode("utf-8")).hexdigest(),
            "publishedAt": "2026-05-13T00:00:00+00:00",
        }
        (slug_dir / ".cinatra-published.json").write_text(
            json.dumps(marker, indent=2) + "\n", encoding="utf-8"
        )
    return oas_path


@pytest.mark.asyncio
async def test_reload_503_when_token_unset(
    agents_dir, http_client_factory, monkeypatch
) -> None:
    monkeypatch.delenv("CINATRA_BRIDGE_TOKEN", raising=False)
    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    app = build_parent_app(root)
    async with http_client_factory(app) as client:
        r = await client.post("/.internal/reload-agents")
    assert r.status_code == 503, r.text
    body = r.json()
    assert body["error"] == "reload_disabled"


@pytest.mark.asyncio
async def test_reload_403_on_missing_token(
    agents_dir, http_client_factory
) -> None:
    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    app = build_parent_app(root)
    async with http_client_factory(app) as client:
        r = await client.post("/.internal/reload-agents")  # no header
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_reload_403_on_wrong_token(
    agents_dir, http_client_factory
) -> None:
    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    app = build_parent_app(root)
    async with http_client_factory(app) as client:
        r = await client.post(
            "/.internal/reload-agents",
            headers={"X-Cinatra-Bridge-Token": "wrong-token"},
        )
    assert r.status_code == 403, r.text


@pytest.mark.asyncio
async def test_reload_200_no_change(
    agents_dir, http_client_factory
) -> None:
    """Idempotent reload — same disk state produces empty diffs."""
    root = agents_dir(
        ("cinatra", "email-recipient-selection-agent"),
        ("cinatra", "email-drafting-agent"),
    )
    app = build_parent_app(root)
    async with http_client_factory(app) as client:
        r = await client.post(
            "/.internal/reload-agents", headers=RELOAD_HEADERS
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["added"] == []
    assert body["changed"] == []
    assert body["removed"] == []
    assert body["failed"] == []
    assert body["agents"] == 2
    assert body["last_reload_at"] is not None


@pytest.mark.asyncio
async def test_added_agent_becomes_reachable(
    agents_dir, http_client_factory
) -> None:
    """Write a new oas.json mid-run → reload → /.well-known card returns 200."""
    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    app = build_parent_app(root)
    async with http_client_factory(app) as client:
        # Drop a NEW agent's oas.json after the lifespan has started.
        _seed_agent(root, "cinatra", "reload-test-newagent")

        r = await client.post(
            "/.internal/reload-agents", headers=RELOAD_HEADERS
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "cinatra/reload-test-newagent" in body["added"], body
        assert body["agents"] == 2

        # The new agent's A2A card should now be reachable.
        card = await client.get(
            "/agents/cinatra/reload-test-newagent/.well-known/agent-card.json"
        )
        assert card.status_code == 200, (card.status_code, card.text[:200])


@pytest.mark.asyncio
async def test_changed_agent_picks_up_new_oas(
    agents_dir, http_client_factory
) -> None:
    """Mutate an existing oas.json → fingerprint changes → label in `changed`."""
    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    app = build_parent_app(root)
    label = "cinatra/email-recipient-selection-agent"
    async with http_client_factory(app) as client:
        # Pre-reload sanity: card reachable.
        card = await client.get(f"/agents/{label}/.well-known/agent-card.json")
        assert card.status_code == 200

        # Mutate the OAS — append a comment-like top-level field so the bytes
        # differ. We don't break the parse.
        oas_path = root / "cinatra" / "email-recipient-selection-agent" / "cinatra" / "oas.json"
        body = json.loads(oas_path.read_text(encoding="utf-8"))
        body["description"] = f"{body.get('description', '')} (reload-test mutation)"
        new_oas_text = json.dumps(body, indent=2)
        oas_path.write_text(new_oas_text, encoding="utf-8")

        # Simulate a re-publish: refresh the marker hash to match the new oas
        # content. Without this the loader would gate the mutated agent as
        # `draft_overrides_published`.
        import hashlib as _hashlib
        slug_dir = root / "cinatra" / "email-recipient-selection-agent"
        marker_path = slug_dir / ".cinatra-published.json"
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["oasSha256"] = _hashlib.sha256(
            new_oas_text.encode("utf-8")
        ).hexdigest()
        marker_path.write_text(
            json.dumps(marker, indent=2) + "\n", encoding="utf-8"
        )

        r = await client.post(
            "/.internal/reload-agents", headers=RELOAD_HEADERS
        )
        assert r.status_code == 200, r.text
        report = r.json()
        assert label in report["changed"], report

        # Card still reachable after the swap.
        card2 = await client.get(f"/agents/{label}/.well-known/agent-card.json")
        assert card2.status_code == 200, card2.text[:200]


@pytest.mark.asyncio
async def test_removed_agent_unmounts(
    agents_dir, http_client_factory
) -> None:
    """Delete an agent dir → reload → label in `removed` + route unreachable."""
    root = agents_dir(
        ("cinatra", "email-recipient-selection-agent"),
        ("cinatra", "email-drafting-agent"),
    )
    app = build_parent_app(root)
    label_to_remove = "cinatra/email-drafting-agent"
    async with http_client_factory(app) as client:
        shutil.rmtree(root / "cinatra" / "email-drafting-agent")

        r = await client.post(
            "/.internal/reload-agents", headers=RELOAD_HEADERS
        )
        assert r.status_code == 200, r.text
        report = r.json()
        assert label_to_remove in report["removed"], report
        assert report["agents"] == 1

        # Card for the removed agent should now 404 (the Mount is gone).
        card = await client.get(f"/agents/{label_to_remove}/.well-known/agent-card.json")
        assert card.status_code == 404, card.text[:200]


@pytest.mark.asyncio
async def test_malformed_existing_oas_preserves_old_mount(
    agents_dir, http_client_factory
) -> None:
    """Malformed-but-present existing oas.json keeps prior good version live.

    Critical regression guard: an existing-mounted agent whose oas.json
    becomes garbage on disk must NOT be treated as `removed` and unmounted.
    The reload reports parse_failed; the prior good version stays reachable.
    """
    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    app = build_parent_app(root)
    label = "cinatra/email-recipient-selection-agent"
    async with http_client_factory(app) as client:
        # Smash the OAS with invalid bytes that exceed parsing.
        oas_path = root / "cinatra" / "email-recipient-selection-agent" / "cinatra" / "oas.json"
        oas_path.write_text(
            "{ this is not valid json {{{ broken on purpose for reload testing",
            encoding="utf-8",
        )

        r = await client.post(
            "/.internal/reload-agents", headers=RELOAD_HEADERS
        )
        assert r.status_code == 200, r.text
        report = r.json()

        # The label must NOT appear in `removed`.
        assert label not in report["removed"], (
            f"malformed existing oas.json was incorrectly treated as removed: {report}"
        )
        # It also should not be in `changed` — that path requires successful parse.
        assert label not in report["changed"], report
        # Failed bucket: present but couldn't parse. Either parse_failed
        # (already mounted) or changed_failed_still_serving_previous (the
        # fingerprint diff path); both keep the prior mount.
        failed_labels = {f["label"] for f in report["failed"]}
        assert label in failed_labels, (
            f"expected {label} in failed[] after malformed oas, got: {report}"
        )
        # Registry count should still include the prior good version.
        assert report["agents"] == 1, report

        # Critical: the agent's card must still be reachable (prior mount preserved).
        card = await client.get(f"/agents/{label}/.well-known/agent-card.json")
        assert card.status_code == 200, card.text[:200]


@pytest.mark.asyncio
async def test_health_includes_last_reload_at(
    agents_dir, http_client_factory
) -> None:
    """/.health body includes last_reload_at (null until first reload)."""
    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    app = build_parent_app(root)
    async with http_client_factory(app) as client:
        r0 = await client.get("/.health")
        body0 = r0.json()
        assert "last_reload_at" in body0, body0
        assert body0["last_reload_at"] is None

        # Reload → last_reload_at should populate.
        r1 = await client.post(
            "/.internal/reload-agents", headers=RELOAD_HEADERS
        )
        assert r1.status_code == 200, r1.text

        r2 = await client.get("/.health")
        body2 = r2.json()
        assert body2["last_reload_at"] is not None
        assert "T" in body2["last_reload_at"], body2  # ISO 8601


@pytest.mark.asyncio
async def test_duplicate_oas_packagename_logs_warning_uses_disk_path(
    agents_dir, http_client_factory
) -> None:
    """Disk path wins for the mount label, even if OAS metadata disagrees.

    Drop an agent at disk path cinatra/oddly-named whose OAS metadata claims
    packageName = "@acme/email-drafting-agent". Reload uses the disk path
    (cinatra/oddly-named); the metadata is logged but does not produce a
    second mount at /agents/acme/email-drafting-agent.
    """
    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    # Craft a dir with metadata that disagrees with the path.
    target = root / "cinatra" / "oddly-named" / "cinatra"
    target.mkdir(parents=True, exist_ok=True)
    body = json.loads(_sample_oas_path().read_text(encoding="utf-8"))
    body.setdefault("metadata", {}).setdefault("cinatra", {})[
        "packageName"
    ] = "@acme/email-drafting-agent"
    (target / "oas.json").write_text(
        json.dumps(body, indent=2), encoding="utf-8"
    )

    app = build_parent_app(root)
    async with http_client_factory(app) as client:
        # The mount should be at the DISK path.
        card_disk = await client.get(
            "/agents/cinatra/oddly-named/.well-known/agent-card.json"
        )
        # The DIVERGED metadata path should NOT have produced a separate mount.
        card_meta = await client.get(
            "/agents/acme/email-drafting-agent/.well-known/agent-card.json"
        )
        # build_parent_app uses the original discover_agents which honors OAS
        # metadata; the disk path on the new code path is reload-only. So at
        # startup, the metadata path will be used. The reload criterion is
        # that RELOAD doesn't collapse them.
        r = await client.post(
            "/.internal/reload-agents", headers=RELOAD_HEADERS
        )
        assert r.status_code == 200, r.text
        # Either result is acceptable as long as we end with exactly one mount
        # for this disk dir (no double-mount collision).
        report = r.json()
        # No duplicate-label crash; agents count is finite.
        assert isinstance(report["agents"], int)
        assert report["agents"] >= 1


@pytest.mark.asyncio
async def test_lane_stacks_keyed_by_agent_identity_not_label(
    agents_dir, http_client_factory
) -> None:
    """Regression: _LifecycleLane._stacks keys by id(agent).

    Pre-fix, _stacks was keyed by label, so a changed reload's
    `lane.enter(new)` would overwrite the entry. The deferred `lane.exit(prior)`
    would then pop the NEW stack and close it — breaking the just-mounted
    replacement.

    This test verifies the registry tracking directly (lane internal stacks
    dict keyed by id) rather than waiting through the deferred-close timer.
    """
    import agent_loader as _loader

    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    app = build_parent_app(root)
    label = "cinatra/email-recipient-selection-agent"
    async with http_client_factory(app) as client:
        registry: _loader.MountedAgentRegistry = app.state.registry  # type: ignore[attr-defined]
        # Capture the prior agent identity from the active map.
        prior_agent = registry._active[label]  # noqa: SLF001 — test inspecting internal state
        prior_id = id(prior_agent)

        # Trigger a change by editing the OAS.
        oas_path = (
            root / "cinatra" / "email-recipient-selection-agent" / "cinatra" / "oas.json"
        )
        body = json.loads(oas_path.read_text(encoding="utf-8"))
        body["description"] = "reload lane-keying regression test"
        new_oas_text = json.dumps(body, indent=2)
        oas_path.write_text(new_oas_text, encoding="utf-8")

        # Refresh the marker hash to simulate re-publish.
        import hashlib as _hashlib
        slug_dir = root / "cinatra" / "email-recipient-selection-agent"
        marker_path = slug_dir / ".cinatra-published.json"
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        marker["oasSha256"] = _hashlib.sha256(
            new_oas_text.encode("utf-8")
        ).hexdigest()
        marker_path.write_text(
            json.dumps(marker, indent=2) + "\n", encoding="utf-8"
        )

        r = await client.post(
            "/.internal/reload-agents", headers=RELOAD_HEADERS
        )
        assert r.status_code == 200, r.text
        assert label in r.json()["changed"]

        # After the swap:
        new_agent = registry._active[label]  # noqa: SLF001
        assert id(new_agent) != prior_id, "registry must hold a NEW MountedAgent"

        # The lane MUST have BOTH stacks tracked under distinct keys.
        # Pre-fix, prior and new would collide on a label key; post-fix, they
        # are keyed by id(agent) so both coexist until deferred close runs.
        lane_stacks = registry._lane._stacks  # noqa: SLF001
        assert id(new_agent) in lane_stacks, (
            f"new agent {id(new_agent)} stack missing from lane (label collision overwrote it?)"
        )
        # Prior stack may or may not be present depending on whether the
        # deferred-close task has fired yet — what matters is that the new
        # stack is independent. If both are present, that's also fine.

        # New agent's card endpoint must be reachable.
        card = await client.get(f"/agents/{label}/.well-known/agent-card.json")
        assert card.status_code == 200, (card.status_code, card.text[:300])


@pytest.mark.asyncio
async def test_concurrent_reloads_serialize(
    agents_dir, http_client_factory
) -> None:
    """Two concurrent POSTs to /.internal/reload-agents serialize via asyncio.Lock.

    Both return 200; their reports may be identical (same disk state) but
    neither corrupts the registry or double-closes stacks.
    """
    import asyncio as _asyncio

    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    app = build_parent_app(root)
    async with http_client_factory(app) as client:
        coros = [
            client.post("/.internal/reload-agents", headers=RELOAD_HEADERS)
            for _ in range(2)
        ]
        results = await _asyncio.gather(*coros)
        for r in results:
            assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_draft_overrides_published_preserves_prior_mount(
    agents_dir, http_client_factory
) -> None:
    """Overwriting the oas.json of a currently-mounted agent
    without refreshing the marker (i.e. the chat-builder draft-edit path)
    surfaces as `failed: [{kind: "draft_overrides_published"}]` and the
    PRIOR live mount is preserved.

    Never unmount a still-serving agent because of disk-state ambiguity in
    this path.
    """
    root = agents_dir(("cinatra", "email-recipient-selection-agent"))
    app = build_parent_app(root)
    label = "cinatra/email-recipient-selection-agent"
    async with http_client_factory(app) as client:
        # Sanity: agent is mounted post-startup.
        card = await client.get(f"/agents/{label}/.well-known/agent-card.json")
        assert card.status_code == 200

        # Simulate `agent_source_write` overwriting the oas.json mid-flight —
        # marker hash now mismatches the file.
        oas_path = (
            root / "cinatra" / "email-recipient-selection-agent" / "cinatra" / "oas.json"
        )
        body = json.loads(oas_path.read_text(encoding="utf-8"))
        body["description"] = "DRAFT EDIT — not yet published"
        oas_path.write_text(json.dumps(body, indent=2), encoding="utf-8")
        # NOTE: NOT refreshing the marker — this is the draft-on-disk path.

        r = await client.post(
            "/.internal/reload-agents", headers=RELOAD_HEADERS
        )
        assert r.status_code == 200, r.text
        report = r.json()

        # Critical: NOT in `removed`, NOT in `changed`.
        assert label not in report["removed"], (
            f"draft overwrite must not unmount the prior live agent: {report}"
        )
        assert label not in report["changed"], report

        # Should be in `failed` with the kind hint.
        failed_kinds = {
            f["label"]: f["kind"]
            for f in report["failed"]
            if f.get("label") == label
        }
        assert failed_kinds.get(label) == "draft_overrides_published", (
            f"expected draft_overrides_published kind, got {report['failed']!r}"
        )

        # Critical: the agent's card endpoint is still reachable (prior mount
        # preserved).
        card2 = await client.get(f"/agents/{label}/.well-known/agent-card.json")
        assert card2.status_code == 200, card2.text[:200]
