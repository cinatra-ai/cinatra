"""Boot-completeness assertion for the CI mount guard (cinatra#2140).

Run INSIDE the wayflow container, after it has booted over the pinned extension
tree, by the ``validate-wayflow-mount`` job in
``.github/workflows/validate-agents.yml``:

    docker exec -w /app <container> python tests/assert_mount_health.py

Not a pytest module (its filename is deliberately outside the ``test_*``
collection pattern) — it asserts things only the LIVE runtime knows, which the
pytest guards structurally cannot:

1. **Discovery completeness.** ``test_repo_agents_load`` parametrizes from
   ``discover_agents``, so an agent that discovery silently drops (missing or
   stale ``.cinatra-published.json``, unparseable OAS) simply produces no test —
   a vacuous green. Comparing ``agents + failed_agents`` against the number of
   ``oas.json`` files actually on disk closes that.
2. **Post-deserialization mount failures.** The pytest guard stops at
   ``AgentSpecLoader().load_json``; ``_mount_one_sync`` then builds the
   ``A2AServer`` and resolves the ASGI app, and the lifespan is entered later
   still. Only ``/.health`` sees those, so ``failed_agents`` must be within the
   ONE allowlist (imported from the guard module — never re-declared here).
3. **The subject agents are present.** A clone-back that lands a tree without
   the two cinatra#2140 agents and their orchestrator would make every
   both-path assertion skip.

Exit 0 on success; prints ``::error::`` annotations and exits 1 otherwise.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_repo_agents_load import _KNOWN_FAILING_GATE_AGENTS  # noqa: E402

HEALTH_URL = os.environ.get("CINATRA_HEALTH_URL", "http://127.0.0.1:3010/.health")
AGENTS_DIR = Path(os.environ.get("CINATRA_AGENTS_DIR", "/agents"))

#: The agents cinatra#2140 is about, plus the orchestrator that carries the
#: inlined (orchestrated) encoding of the same gates.
REQUIRED_LABELS = (
    "cinatra-ai/email-drafting-agent",
    "cinatra-ai/email-recipient-selection-agent",
    "cinatra-ai/email-outreach-agent",
)


def main() -> int:
    with urllib.request.urlopen(HEALTH_URL, timeout=30) as response:  # noqa: S310
        health = json.load(response)

    # `<agents_dir>/<vendor>/<slug>/cinatra/oas.json` — the same shape
    # `discover_agents` walks. The runtime labels a mount by the OAS
    # `metadata.cinatra.packageName` rather than the disk path; they agree in the
    # pinned tree, and a divergence is logged by the loader as a WARNING, so the
    # disk-derived label is the right basis for a COUNT comparison.
    on_disk = sorted(
        f"{path.parents[2].name}/{path.parents[1].name}"
        for path in AGENTS_DIR.glob("*/*/cinatra/oas.json")
    )
    mounted = int(health.get("agents") or 0)
    failed = sorted(health.get("failed_agents") or [])
    allowlisted = {f"cinatra-ai/{slug}" for slug in _KNOWN_FAILING_GATE_AGENTS}

    print(
        f"[assert_mount_health] on_disk={len(on_disk)} mounted={mounted} "
        f"failed={failed} allowlisted={sorted(allowlisted)}"
    )

    problems: list[str] = []
    if mounted + len(failed) != len(on_disk):
        problems.append(
            f"{mounted} mounted + {len(failed)} failed != {len(on_disk)} oas.json on "
            f"disk — discovery dropped agent(s) silently, so the mount guard would "
            f"not have covered them."
        )
    unexpected = sorted(set(failed) - allowlisted)
    if unexpected:
        problems.append(
            f"agent(s) failed to mount and are not in _KNOWN_FAILING_GATE_AGENTS: "
            f"{unexpected}"
        )
    missing = [label for label in REQUIRED_LABELS if label not in on_disk]
    if missing:
        problems.append(f"the cinatra#2140 agents are absent from the tree: {missing}")
    failed_required = [label for label in REQUIRED_LABELS if label in failed]
    if failed_required:
        problems.append(f"the cinatra#2140 agents failed to mount: {failed_required}")

    for problem in problems:
        print(f"::error::{problem}")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
