#!/usr/bin/env bash
set -euo pipefail
# ============================================================================
# works-after GATE entrypoint (cinatra#1147).
#
# The single documented command an upgrade lane runs to ENFORCE "works-after
# green" as a fail-closed PREREQUISITE before its major can land. It wraps the
# proof orchestrator (works-after-proof.sh) in GATE MODE — a SKIP becomes a
# FAIL — and adds fail-fast precondition checks, so a lane cannot get a false
# green by forgetting to un-skip the arm(s) its major actually changes or to
# supply that arm's required candidate input.
#
# Why a dedicated entrypoint (vs. `works-after:proof`): the bare proof harness
# defaults to ALL arms and, outside gate mode, SKIPs an arm it can't exercise
# (e.g. graphiti without a key) — green. That is correct for a bare PR run, but
# WRONG for a gate: a gate must (a) name exactly what it gates, (b) refuse to
# skip, and (c) have a stable exit-code contract a lane / CI can branch on. This
# script is that contract.
#
# USAGE
#   scripts/ci/works-after-gate.sh --arms <all|csv>     [candidate pins via env]
#   WORKS_AFTER_GATE_ARMS=<all|csv> scripts/ci/works-after-gate.sh
#   pnpm works-after:gate -- --arms <all|csv>
#
#   An explicit arm selection is REQUIRED — there is no silent default. A gate
#   must name what it gates; `--arms all` gates every arm.
#
# PER-LANE EXAMPLES (set the NEW pin(s) for the major under test)
#   agent-runtime major:   --arms wayflow   PYTHON_TAG=… WAYFLOWCORE_VERSION=… PYAGENTSPEC_VERSION=…
#   postgres major:        --arms postgres  PG_TO_TAG=18-alpine PREV_IMAGE=<last released prod image>
#   graphiti/neo4j major:  --arms graphiti  NEO4J_IMAGE=… GRAPHITI_IMAGE=… OPENAI_API_KEY=…
#   redis major:           --arms redis     REDIS_TAG=8-alpine
#   verdaccio major:       --arms verdaccio VERDACCIO_TAG=…
#   nango major:           --arms nango     NANGO_SERVER_IMAGE=…
#   redis engine major (upgrade-from):   --arms upgrade-redis   REDIS_FROM_TAG=… REDIS_TO_TAG=…
#   mariadb engine major (upgrade-from): --arms upgrade-mariadb MARIADB_FROM_TAG=… MARIADB_TO_TAG=…
#   full-stack major:      --arms all       <all pins> PREV_IMAGE=… OPENAI_API_KEY=…
#
# EXIT CODES
#   0  gate PASSED       — every selected arm went green in gate mode.
#   1  gate FAILED       — a proof failed, or a required arm SKIPped under gate
#                          mode. The major MUST NOT land until this is green.
#   2  gate MISCONFIGURED — no/invalid arm selection, or a selected arm's
#                          required candidate input is missing (checked BEFORE
#                          any container starts). Fix the invocation, not the code.
#
# Candidate versions still come from each arm's per-arm env (REDIS_TAG,
# PG_TO_TAG, NEO4J_IMAGE/NEO4J_TAG, GRAPHITI_IMAGE, NANGO_SERVER_IMAGE,
# VERDACCIO_TAG, PYTHON_TAG, WAYFLOWCORE_VERSION, PYAGENTSPEC_VERSION, …),
# defaulting to the current pins — so a bare `--arms all` gate is green on
# today's main, and a major lane sets the new pin(s).
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCH="${SCRIPT_DIR}/works-after-proof.sh"

# Keep this list in lockstep with ALL_ARMS in works-after-proof.sh (asserted by
# the works-after:test static invariants).
ALL_ARMS="redis verdaccio nango wayflow graphiti upgrade-redis upgrade-mariadb postgres"

ARMS="${WORKS_AFTER_GATE_ARMS:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --arms)
      # Guard the value BEFORE `shift 2` — a bare trailing `--arms` would make
      # `shift 2` fail under `set -e` and exit 1 instead of the documented 2.
      if [ $# -lt 2 ]; then
        echo "works-after-gate: MISCONFIGURED — --arms requires a value (e.g. --arms wayflow, or --arms all)." >&2
        exit 2
      fi
      ARMS="$2"; shift 2 ;;
    --arms=*) ARMS="${1#--arms=}"; shift ;;
    -h|--help) sed -n '2,68p' "$0"; exit 0 ;;
    *) echo "works-after-gate: MISCONFIGURED — unknown argument '$1' (see --help)." >&2; exit 2 ;;
  esac
done

if [ -z "$ARMS" ]; then
  {
    echo "works-after-gate: MISCONFIGURED — no arm selection."
    echo "  A gate MUST name the arm(s) its major changes: --arms <all|csv> (or WORKS_AFTER_GATE_ARMS)."
    echo "  Valid arms: ${ALL_ARMS}. Use 'all' to gate every arm."
  } >&2
  exit 2
fi

# Resolve `all`; otherwise split the comma/space list into raw tokens (printf,
# not echo, so a token that looks like a flag is never interpreted).
if [ "$ARMS" = "all" ]; then
  RAW="$ALL_ARMS"
else
  RAW="$(printf '%s' "$ARMS" | tr ',' ' ')"
fi

# Validate each token and collect a clean, space-normalized SELECTED. Empty
# tokens from stray commas/spaces (e.g. `--arms ,` or `--arms ' '`) are dropped
# by word-splitting; an unknown arm OR a selection that resolves to ZERO arms is
# a MISCONFIGURATION (exit 2). A gate must NEVER run zero arms and report
# success — that would be a false green.
SELECTED=""
for arm in $RAW; do
  case " $ALL_ARMS " in
    *" $arm "*) SELECTED="${SELECTED:+$SELECTED }$arm" ;;
    *) echo "works-after-gate: MISCONFIGURED — unknown arm '${arm}' (valid: ${ALL_ARMS}, or 'all')." >&2; exit 2 ;;
  esac
done
if [ -z "$SELECTED" ]; then
  echo "works-after-gate: MISCONFIGURED — the arm selection '${ARMS}' resolved to no arms (an empty or ','-only value). Name at least one: --arms <all|csv>." >&2
  exit 2
fi

has_arm() { case " $SELECTED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ── Fail-fast preconditions (BEFORE any container starts) ────────────────────
# In gate mode the orchestrator hard-fails MID-RUN if a selected arm cannot
# actually run (graphiti without a key; the postgres prev-release proof without
# PREV_IMAGE). Surface those as a clear MISCONFIGURED up front so a lane fixes
# the invocation immediately instead of after a long container build.
MISCONFIG=0
if has_arm graphiti && [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "works-after-gate: MISCONFIGURED — the 'graphiti' arm needs OPENAI_API_KEY (graphiti runs LLM extraction before the Neo4j write); set it for the graphiti/neo4j major lane." >&2
  MISCONFIG=1
fi
if has_arm postgres && [ -z "${PREV_IMAGE:-}" ]; then
  echo "works-after-gate: MISCONFIGURED — selecting 'postgres' in gate mode also runs its prev-release upgrade proof, which needs PREV_IMAGE=<last released prod image> (a skipped prev-release proof is a false green)." >&2
  MISCONFIG=1
fi
if [ "$MISCONFIG" -ne 0 ]; then exit 2; fi

echo "== works-after GATE (cinatra#1147) =="
echo "arms: ${SELECTED}"
echo "mode: GATE — WORKS_AFTER_GATE_MODE=1 (a SKIP is a FAIL)"
echo ""

# Run the orchestrator in gate mode with exactly the selected arms. Its exit is
# 0 (all passed), 1 (a failure / skip-in-gate), or 2 (unknown arm — impossible
# here, we validated). Do not let `set -e` swallow the code.
set +e
WORKS_AFTER_GATE_MODE=1 WORKS_AFTER_ONLY="$(printf '%s' "$SELECTED" | tr ' ' ',')" bash "$ORCH"
rc=$?
set -e

case "$rc" in
  0)
    echo ""
    echo "works-after-gate: PASS — the harness is green in gate mode for: ${SELECTED}."
    exit 0
    ;;
  2)
    # Should not happen (selection validated above); treat as misconfig.
    echo "works-after-gate: MISCONFIGURED — the orchestrator rejected the arm selection." >&2
    exit 2
    ;;
  *)
    echo "works-after-gate: FAIL — the harness is RED in gate mode; this major MUST NOT land until it is green." >&2
    exit 1
    ;;
esac
