"""Regression test for `wayflow-docker-no-start`.

Smoke-loads every repo-shipped oas.json under agents/cinatra/ through
AgentSpecLoader the same way agent_loader.py does at container start.

This catches whole-stack startup failures (such as the boolean-vs-string
output-type mismatch on InputMessageNode that broke 6 of 7 wayflow
containers when the skill-recommender-agent was inlined into
email-outreach-agent).

Runs only inside the wayflow Docker image (or any environment with
wayflowcore + pyagentspec installed). Skipped otherwise.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

# repo root: docker/wayflow/tests/test_repo_agents_load.py → ../../../
REPO_ROOT = Path(__file__).resolve().parents[3]
AGENTS_DIR = REPO_ROOT / "extensions" / "cinatra-ai"

try:
    from wayflowcore.agentspec import AgentSpecLoader  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — runs only inside the container
    AgentSpecLoader = None  # type: ignore[assignment]

# Substitute the same placeholders agent_loader.py does at container start
# (so {{CINATRA_BASE_URL}} etc. don't blow up the JSON parse).
import agent_loader  # type: ignore[import-not-found]


def _agent_oas_files() -> list[Path]:
    if not AGENTS_DIR.is_dir():
        return []
    out: list[Path] = []
    for slug_dir in sorted(AGENTS_DIR.iterdir()):
        if not slug_dir.is_dir():
            continue
        oas = slug_dir / "cinatra" / "oas.json"
        if oas.is_file():
            out.append(oas)
    return out


@pytest.mark.skipif(AgentSpecLoader is None, reason="wayflowcore not installed (run inside the wayflow image)")
@pytest.mark.parametrize("oas_path", _agent_oas_files(), ids=lambda p: p.parent.parent.name)
def test_oas_loads_via_agentspec_loader(oas_path: Path) -> None:
    """Each repo-shipped oas.json must load through AgentSpecLoader without exception.

    The historical failure mode is a `TypeError: ValueError: 'error' required in context`
    surfaced from pyagentspec when a `value_error` validation error fires (e.g.
    InputMessageNode.outputs[*].type set to 'boolean' instead of 'string').
    """
    raw = oas_path.read_text(encoding="utf-8")
    substituted = agent_loader._substitute_placeholders(raw)
    # Will raise on validation/conversion failure — pytest reports it.
    agent = AgentSpecLoader().load_json(substituted)
    assert agent is not None, f"AgentSpecLoader returned None for {oas_path}"
