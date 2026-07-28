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

_ENV_DIR = os.environ.get("CINATRA_AGENTS_DIR")
_HERE = Path(__file__).resolve()
# parents[3] = repo root when this file lives at ``<repo>/docker/wayflow/tests/``.
# In the wayflow image the file lives at ``/app/tests/`` (only two levels deep),
# so ``parents[3]`` would IndexError at import — guard it. The container ALWAYS
# sets ``CINATRA_AGENTS_DIR=/agents``, so the repo-root default is never needed
# there; a shallow mount with no override simply has nothing to scan.
_REPO_ROOT = _HERE.parents[3] if len(_HERE.parents) > 3 else None
if _ENV_DIR:
    AGENTS_DIR = Path(_ENV_DIR)
elif _REPO_ROOT is not None:
    # Default to the multi-vendor ``extensions`` root — the SAME tree
    # docker-compose bind-mounts at ``/agents`` and that ``discover_agents``
    # two-level-walks.
    AGENTS_DIR = _REPO_ROOT / "extensions"
else:
    AGENTS_DIR = Path("/__no_agents_dir__")  # shallow mount, no override → inert

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
# fix — allowlisted as a strict ``xfail`` so the red stays VISIBLE (the suite
# reports it, it does not silently pass) while CI stays green, rather than
# masking it or hard-failing the whole guard. ``strict`` flips an unexpected
# PASS into a FAILURE, so the day a listed agent starts mounting this guard
# forces its allowlist entry to be removed.
#
# EMPTY. auditor-agent formerly sat here (cinatra#1625 / cinatra#1830). Both of
# its known ``review_gate`` forms mount, so no conditional is warranted:
#   - auditor-agent revision ``179a7d13`` declares NO gate ``inputs`` (the
#     renderer ``inputMessageSchema`` lives under ``metadata.cinatra``); with no
#     ``{{placeholder}}`` ``message`` pyagentspec 26.1.2 infers an empty input
#     set, so the gate mounts NATIVELY and ``_reconcile_input_message_gates``
#     (which only touches an ``InputMessageNode`` with non-empty ``inputs``) is a
#     no-op. A strict-xfail entry against this form XPASSes and FAILS the guard.
#   - the cinatra#1625 HITL gate re-encode moves those to declared,
#     DataFlowEdge-fed inputs with plain ``[A-Za-z_]\w*`` titles
#     (``prompts``/``preview``) — which the shim folds into a
#     ``PluginInputMessageNode`` ``message_template`` (covered by
#     test_input_message_gate_reconcile.py), so that form mounts too.
# A conditional xfail would have no failing state to represent and could conceal
# a future regression, so the entry is removed unconditionally.
#
# ``security-reviewer-agent`` (cinatra#2140): the FIRST run of this guard against
# the real pinned extension tree — see the ``validate-wayflow-mount`` job in
# .github/workflows/validate-agents.yml, which that issue wires up — surfaced one
# genuine pre-existing mount failure. It is NOT a HITL-gate defect: at pin
# ``aa44488c`` the ``review`` node's ``data.system`` prompt contains a LITERAL
# ``{{ ... }}`` inside prose ("interpolate untrusted input via ``{{ ... }}``"),
# which wayflowcore parses as a Jinja expression and rejects with
# ``TemplateSyntaxError: unexpected '.'`` — so the agent never mounts. The fix
# belongs in the agent repo (wrap the prose in ``{% raw %}…{% endraw %}``) and is
# out of scope for #2140, whose subject is the two email agents' gate encoding.
# Listed here so the guard reports that red VISIBLY instead of being blocked by an
# unrelated defect.
#
# The allowlist maps slug → a SUBSTRING of the expected failure, and the check is
# BOUNDED (below): only that exact failure xfails. A different exception on an
# allowlisted agent is a real FAILURE (a blanket slug xfail would have masked it),
# and an allowlisted agent that starts mounting fails too, forcing the entry out.
_KNOWN_FAILING_GATE_AGENTS: dict[str, str] = {
    "security-reviewer-agent": "unexpected '.'",
}
_KNOWN_FAILING_REASON = (
    "known-failing mount (see _KNOWN_FAILING_GATE_AGENTS) — awaits a "
    "separately-tracked fix; the bounded xfail keeps the red visible without "
    "failing the guard, and only for the recorded failure."
)


def _agent_oas_params() -> list["pytest.ParameterSet"]:
    """Enumerate every mountable OAS via the runtime's own ``discover_agents``
    two-level walk, so the guard's parametrization is byte-identical to the set
    the loader mounts at boot. Each param is keyed by the canonical ``slug``
    (from ``metadata.cinatra.packageName``). A known-failing agent is NOT marked
    here: the xfail is applied in the test body so it can be bounded to the
    recorded failure instead of blanketing the slug."""
    # No point discovering (and parsing OAS) when the suite can't mount anyway —
    # keeps collection inert on a host missing the runtime deps.
    if agent_loader is None or AgentSpecLoader is None or not AGENTS_DIR.is_dir():
        return []
    out: list["pytest.ParameterSet"] = []
    for vendor, slug, oas_path, _sha in agent_loader.discover_agents(AGENTS_DIR):
        out.append(pytest.param(oas_path, slug, id=f"{vendor}/{slug}"))
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
@pytest.mark.parametrize("oas_path,slug", _agent_oas_params())
def test_oas_loads_via_agentspec_loader(oas_path: Path, slug: str) -> None:
    """Each discoverable oas.json must mount through the real runtime pre-load
    pipeline + AgentSpecLoader without exception."""
    raw = oas_path.read_text(encoding="utf-8")
    label = oas_path.parent.parent.name
    substituted = _runtime_preload(raw, label)
    expected_failure = _KNOWN_FAILING_GATE_AGENTS.get(slug)
    try:
        agent = AgentSpecLoader().load_json(substituted)
    except Exception as exc:  # noqa: BLE001 — the message decides the verdict
        if expected_failure is not None and expected_failure in str(exc):
            pytest.xfail(f"{slug}: {_KNOWN_FAILING_REASON} [{expected_failure}]")
        raise
    assert agent is not None, f"AgentSpecLoader returned None for {oas_path}"
    if expected_failure is not None:
        pytest.fail(
            f"{slug} is in _KNOWN_FAILING_GATE_AGENTS but now mounts — remove its "
            f"entry (the allowlist must never outlive the failure it records)."
        )
