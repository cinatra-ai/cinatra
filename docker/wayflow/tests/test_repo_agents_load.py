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

Discovery reuses the runtime's OWN ``agent_loader.discover_agents`` two-level
walk (``<agents_dir>/<vendor>/<slug>/cinatra/oas.json``) so the guard can never
drift from the set the loader actually mounts. By default it scans the in-repo
multi-vendor ``extensions`` root — the exact tree docker-compose bind-mounts at
``/agents``. Set ``CINATRA_AGENTS_DIR`` to the INSTALLED standalone-extension
tree (the very path the container mounts at ``/agents``, materialized from the
dev-lock) so CI exercises the exact installed OAS artifacts rather than only the
vendored copies — closing the "vendored ≠ installed" gap called out in
cinatra#1830. The ``agents-run``/``works-after`` container CI points this at the
mounted ``/agents`` tree (see ``scripts/ci/works-after/wayflow.sh``), so the same
``CINATRA_AGENTS_DIR`` value drives both the runtime boot and this guard.

An agent whose gate is a KNOWN, separately-tracked mount failure is allowlisted
as a strict ``xfail`` (see ``_KNOWN_FAILING_GATE_AGENTS``) so its red stays
VISIBLE without failing the whole guard — and a surprise PASS forces the entry's
removal.

Runs only where wayflowcore + pyagentspec are installed. Skipped otherwise.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

# repo root: docker/wayflow/tests/test_repo_agents_load.py → ../../../
REPO_ROOT = Path(__file__).resolve().parents[3]
_ENV_DIR = os.environ.get("CINATRA_AGENTS_DIR")
# Default to the multi-vendor ``extensions`` root — the SAME tree docker-compose
# bind-mounts at ``/agents`` and that ``discover_agents`` two-level-walks. The
# container CI overrides this with ``CINATRA_AGENTS_DIR=/agents`` (the mounted
# installed tree) so the guard tracks exactly what the runtime loads.
AGENTS_DIR = Path(_ENV_DIR) if _ENV_DIR else (REPO_ROOT / "extensions")

try:
    from wayflowcore.agentspec import AgentSpecLoader  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — runs only inside the container
    AgentSpecLoader = None  # type: ignore[assignment]

# Reuse the loader's own pre-load transforms + discovery so this guard tracks
# the exact runtime mount path. Guarded: agent_loader pulls in the full runtime
# import surface (starlette/uvicorn/wayflowcore), so on a host that lacks it the
# whole suite skips rather than erroring at collection.
try:
    import agent_loader  # type: ignore[import-not-found]
except Exception:  # pragma: no cover — runs only where the runtime deps exist
    agent_loader = None  # type: ignore[assignment]

try:  # context-subflow injection ships next to agent_loader in the image
    from context_subflow_injection import inject_context_subflows  # type: ignore[import-not-found]
except Exception:  # pragma: no cover
    inject_context_subflows = None  # type: ignore[assignment]


# Agents whose gate is KNOWN to still fail this mount guard, pending a separate
# fix — allowlisted as ``xfail`` so the red stays VISIBLE (the suite reports it,
# it does not silently pass) while CI stays green, rather than masking it or
# hard-failing the whole guard.
#
#   auditor-agent (cinatra#1625 / cinatra#1830): its ``review_gate`` is an
#   ``InputMessageNode`` whose declared, DataFlowEdge-fed inputs carry the
#   renderer ``inputMessageSchema`` shape the load-time reconcile shim
#   (``_reconcile_input_message_gates``) cannot yet fold into a
#   ``message_template`` — so it is deliberately left unrewritten and fails to
#   mount on the pin. The gate re-encode that makes it foldable is tracked
#   separately in cinatra#1625/#1830; drop this entry when it lands. ``strict``
#   flips an unexpected PASS into a FAILURE, so the day the re-encode ships this
#   guard forces the allowlist entry to be removed.
_KNOWN_FAILING_GATE_AGENTS = {
    "auditor-agent",
}
_KNOWN_FAILING_REASON = (
    "cinatra#1625/#1830: auditor-agent review_gate awaits the HITL gate "
    "re-encode; the declared-input reconcile shim cannot fold its renderer "
    "schema yet, so it fails to mount on the pin. Remove this allowlist entry "
    "when the re-encode lands (a strict-xfail PASS will force it)."
)


def _agent_oas_params() -> list["pytest.ParameterSet"]:
    """Enumerate every mountable OAS via the runtime's own ``discover_agents``
    two-level walk, so the guard's parametrization is byte-identical to the set
    the loader mounts at boot. Each param is keyed by the canonical ``slug``
    (from ``metadata.cinatra.packageName``), and a known-failing gate agent is
    marked strict-xfail."""
    # No point discovering (and parsing OAS) when the suite can't mount anyway —
    # keeps collection inert on a host missing the runtime deps.
    if agent_loader is None or AgentSpecLoader is None or not AGENTS_DIR.is_dir():
        return []
    out: list["pytest.ParameterSet"] = []
    for vendor, slug, oas_path, _sha in agent_loader.discover_agents(AGENTS_DIR):
        marks = (
            [pytest.mark.xfail(reason=_KNOWN_FAILING_REASON, strict=True)]
            if slug in _KNOWN_FAILING_GATE_AGENTS
            else []
        )
        out.append(pytest.param(oas_path, marks=marks, id=f"{vendor}/{slug}"))
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
@pytest.mark.parametrize("oas_path", _agent_oas_params())
def test_oas_loads_via_agentspec_loader(oas_path: Path) -> None:
    """Each discoverable oas.json must mount through the real runtime pre-load
    pipeline + AgentSpecLoader without exception."""
    raw = oas_path.read_text(encoding="utf-8")
    label = oas_path.parent.parent.name
    substituted = _runtime_preload(raw, label)
    # Will raise on validation/conversion failure — pytest reports it.
    agent = AgentSpecLoader().load_json(substituted)
    assert agent is not None, f"AgentSpecLoader returned None for {oas_path}"
