"""Recursive discovery test.

Runs `discover_agents` against the real `agents/` tree and asserts every
required Cinatra-vendored agent is found. The on-disk vendor must be
`cinatra` (the only vendor shipped in this repo today), and the canonical
slug returned by `discover_agents` is the one in
`metadata.cinatra.packageName` — not the disk directory name (so e.g.
`reviewer-agent/` on disk surfaces as `email-reviewer-agent` because that
is what the OAS metadata declares).
"""

from __future__ import annotations

from pathlib import Path

from agent_loader import discover_agents


def test_discovers_all_repo_agents() -> None:
    """Real agents/cinatra/* tree should yield every directory containing
    cinatra/oas.json.
    """
    # Resolution order:
    #   1. Container path: /agents (mounted read-only by the test runner).
    #   2. Host-side checkout: docker/wayflow/tests/ → ../../../agents.
    here = Path(__file__).resolve()
    agents_root = Path("/agents")
    if not agents_root.is_dir() and len(here.parents) >= 4:
        agents_root = here.parents[3] / "agents"
    assert agents_root.is_dir(), (
        f"agents directory not found at {agents_root}; "
        "set CWD to repo root or mount /agents inside the container"
    )

    results = discover_agents(agents_root)
    assert results, f"discover_agents returned empty list for {agents_root}"

    # discover_agents returns 4-tuples (vendor, slug, oas_path, oas_sha256)
    # so the fingerprint can flow to _mount_one_sync without a second read.
    slugs = sorted({s for _, s, _, _ in results})
    required = [
        "email-recipient-selection-agent",
        "email-drafting-agent",
        "email-outreach-agent",
        "email-follow-up-agent",
        "email-reviewer-agent",
        "email-delivery-agent",
    ]
    for slug in required:
        assert slug in slugs, (
            f"missing required agent slug: {slug}; got {slugs}"
        )

    vendors = {v for v, _, _, _ in results}
    assert vendors == {"cinatra"}, (
        f"expected only 'cinatra' vendor on disk, got {vendors}"
    )
