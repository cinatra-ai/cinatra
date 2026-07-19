"""Regression test for `wayflow-docker-no-start`.

Mount-loads every discoverable ``oas.json`` through AgentSpecLoader the SAME way
``agent_loader._mount_one_sync`` does at container start — i.e. through the real
pre-load pipeline (context-subflow injection → HITL gate reconcile →
placeholder substitution), not a bare ``AgentSpecLoader().load_json``. Loading
the raw OAS directly diverges from the runtime path and would (a) false-fail on
the #1794 declared-inputs HITL gate form (repaired at load by
``_reconcile_input_message_gates``, cinatra#1830) and (b) miss any failure the
injection step introduces.

This catches whole-stack startup failures (the boolean-vs-string
``InputMessageNode.outputs`` mismatch that broke 6 of 7 wayflow containers; the
declared-gate-input rejection of cinatra#1830).

By default it scans the in-repo ``extensions/cinatra-ai`` tree. Set
``CINATRA_AGENTS_DIR`` to the INSTALLED standalone-extension tree (the tree the
container actually mounts, materialized from the dev-lock) so CI exercises the
exact installed OAS artifacts rather than only the vendored copies — closing the
"vendored ≠ installed" gap called out in cinatra#1830. The
``agents-run``/``works-after`` container CI should point this at its synced tree.

Runs only where wayflowcore + pyagentspec are installed. Skipped otherwise.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import pytest

# repo root: docker/wayflow/tests/test_repo_agents_load.py → ../../../
REPO_ROOT = Path(__file__).resolve().parents[3]
_ENV_DIR = os.environ.get("CINATRA_AGENTS_DIR")
AGENTS_DIR = Path(_ENV_DIR) if _ENV_DIR else (REPO_ROOT / "extensions" / "cinatra-ai")

try:
    from wayflowcore.agentspec import AgentSpecLoader  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — runs only inside the container
    AgentSpecLoader = None  # type: ignore[assignment]

# Reuse the loader's own pre-load transforms so this guard tracks the exact
# runtime mount path.
import agent_loader  # type: ignore[import-not-found]

try:  # context-subflow injection ships next to agent_loader in the image
    from context_subflow_injection import inject_context_subflows  # type: ignore[import-not-found]
except Exception:  # pragma: no cover
    inject_context_subflows = None  # type: ignore[assignment]


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


def _runtime_preload(raw_text: str, label: str) -> str:
    """Apply the same pre-``load_json`` transforms as ``_mount_one_sync``:
    context-subflow injection, HITL gate reconcile, then env substitution."""
    parsed = json.loads(raw_text)
    if isinstance(parsed, dict):
        if inject_context_subflows is not None:
            composed, report = inject_context_subflows(parsed, label)
            if report:
                parsed = composed
        agent_loader._reconcile_input_message_gates(parsed, label)
        raw_text = json.dumps(parsed)
    return agent_loader._substitute_placeholders(raw_text)


@pytest.mark.skipif(AgentSpecLoader is None, reason="wayflowcore not installed (run inside the wayflow image)")
@pytest.mark.parametrize("oas_path", _agent_oas_files(), ids=lambda p: p.parent.parent.name)
def test_oas_loads_via_agentspec_loader(oas_path: Path) -> None:
    """Each discoverable oas.json must mount through the real runtime pre-load
    pipeline + AgentSpecLoader without exception."""
    raw = oas_path.read_text(encoding="utf-8")
    label = oas_path.parent.parent.name
    substituted = _runtime_preload(raw, label)
    # Will raise on validation/conversion failure — pytest reports it.
    agent = AgentSpecLoader().load_json(substituted)
    assert agent is not None, f"AgentSpecLoader returned None for {oas_path}"
