#!/usr/bin/env bash
set -euo pipefail
# ============================================================================
# works-after proof harness — orchestrator (cinatra#352).
#
# The per-service FUNCTIONAL layer the four existing harnesses don't cover: it
# brings each env-app service up at a CANDIDATE version and runs a real
# round-trip through (where possible) the repo's OWN client code, asserting the
# functional result and FAILING LOUD with per-service diagnostics. This is the
# missing "no env-app/stack major lands without this green" gate (the
# major-version upgrade track).
#
# The six arms (each a standalone script under scripts/ci/works-after/):
#   redis      enqueue → worker runs → completion (bullmq + ioredis, the repo deps)
#   postgres   data survives a documented dump/restore into a NEW PGDATA volume;
#              same-mount bare tag bump REFUSES (negative). Optionally also runs
#              the prev-release upgrade proof (scripts/ci/upgrade-proof.sh) when
#              PREV_IMAGE is set — folding that previously-unwired script in.
#   nango      synthetic connection store round-trip (records-DB + API contract)
#   graphiti   object projection → store → search round-trip (neo4j + graphiti).
#              NOT secret-free — runs only with a real OPENAI_API_KEY (lane).
#   wayflow    agent execution over A2A (no-LLM echo flow) → completed task
#   verdaccio  publish → install round-trip (real immutability config mounted)
#
# CANDIDATE versions come from per-arm env (REDIS_TAG, PG_TO_TAG, NEO4J_TAG,
# NANGO_SERVER_IMAGE, VERDACCIO_TAG, PYTHON_TAG, …), defaulting to the CURRENT
# pins so a bare `bash scripts/ci/works-after-proof.sh` is green on today's main.
# The major-upgrade lane runs the SAME script with the new version(s) set.
#
# Selectable arms:
#   WORKS_AFTER_ONLY=redis,nango   run a subset (default = all)
#   WORKS_AFTER_GATE_MODE=1        a SKIP becomes a FAIL (no false green when a
#                                  gate run can't actually exercise an arm)
#
# Mirrors the proven discipline of upgrade-proof.sh / prod-boot-e2e.sh and the
# closeout-suite.mjs summary-table shape. Exits non-zero if ANY selected arm
# FAILED (a SKIP is not a failure unless gate mode promotes it).
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ARMS_DIR="${SCRIPT_DIR}/works-after"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${ARMS_DIR}/lib.sh"

GATE_MODE="${WORKS_AFTER_GATE_MODE:-0}"

# All arms, in run order. postgres is last-ish (slowest with the negative test).
ALL_ARMS="redis verdaccio nango wayflow graphiti postgres"

# Resolve the selected set from WORKS_AFTER_ONLY (comma/space separated).
if [ -n "${WORKS_AFTER_ONLY:-}" ]; then
  SELECTED="$(echo "${WORKS_AFTER_ONLY}" | tr ',' ' ')"
else
  SELECTED="$ALL_ARMS"
fi

# Validate selection.
for arm in $SELECTED; do
  case " $ALL_ARMS " in
    *" $arm "*) : ;;
    *) echo "ERROR: unknown arm '${arm}' in WORKS_AFTER_ONLY (valid: ${ALL_ARMS})." >&2; exit 2 ;;
  esac
done

echo "== works-after proof harness (cinatra#352) =="
echo "repo: ${REPO_ROOT}"
echo "arms: ${SELECTED}$([ "$GATE_MODE" = "1" ] && echo '  [GATE MODE: a SKIP is a FAIL]')"
echo "candidates: REDIS_TAG=${REDIS_TAG:-7-alpine} PG_FROM_TAG=${PG_FROM_TAG:-17-alpine} PG_TO_TAG=${PG_TO_TAG:-17-alpine} NEO4J_TAG=${NEO4J_TAG:-2026.05-community} VERDACCIO_TAG=${VERDACCIO_TAG:-6} PYTHON_TAG=${PYTHON_TAG:-3.14-slim}"
echo ""

# Results accumulators (parallel arrays, bash-3.2 compatible).
RES_NAMES=""
RES_STATUS=""

run_arm() {
  # run_arm <name> <script-path> [extra-args...]
  local name="$1"; shift
  local script="$1"; shift
  echo "${_WA_DIM}---- RUN : ${name} ----${_WA_RST}"
  local rc=0
  WORKS_AFTER_GATE_MODE="$GATE_MODE" bash "$script" "$@" || rc=$?
  local status
  if [ "$rc" -eq 0 ]; then
    status="PASS"
  elif [ "$rc" -eq 78 ]; then
    # 78 = arm self-reported SKIP. In gate mode that's a FAIL.
    if [ "$GATE_MODE" = "1" ]; then status="FAIL(skip-in-gate)"; else status="SKIP"; fi
  else
    status="FAIL"
  fi
  RES_NAMES="${RES_NAMES} ${name}"
  RES_STATUS="${RES_STATUS} ${status}"
  echo ""
}

for arm in $SELECTED; do
  case "$arm" in
    redis)     run_arm redis     "${ARMS_DIR}/redis.sh" ;;
    verdaccio) run_arm verdaccio "${ARMS_DIR}/verdaccio.sh" ;;
    nango)     run_arm nango     "${ARMS_DIR}/nango.sh" ;;
    wayflow)   run_arm wayflow   "${ARMS_DIR}/wayflow.sh" ;;
    graphiti)  run_arm graphiti  "${ARMS_DIR}/graphiti.sh" ;;
    postgres)
      run_arm postgres "${ARMS_DIR}/postgres.sh"
      # Complementary prev-release proof: the previously-unwired upgrade-proof.sh
      # (data-survival across a prev-release-image → candidate migration). In
      # gate mode PREV_IMAGE MUST be supplied (a skipped Postgres proof is a
      # false green; design §1.2 A7); outside gate mode it's reported SKIP.
      if [ -n "${PREV_IMAGE:-}" ]; then
        echo "${_WA_DIM}---- RUN : postgres-prev-release (upgrade-proof.sh) ----${_WA_RST}"
        prc=0
        bash "${REPO_ROOT}/scripts/ci/upgrade-proof.sh" || prc=$?
        RES_NAMES="${RES_NAMES} postgres-prev-release"
        RES_STATUS="${RES_STATUS} $([ "$prc" -eq 0 ] && echo PASS || echo FAIL)"
        echo ""
      else
        RES_NAMES="${RES_NAMES} postgres-prev-release"
        if [ "$GATE_MODE" = "1" ]; then
          echo "${_WA_RED}ERROR: postgres-prev-release requires PREV_IMAGE in gate mode (a skipped prev-release proof is a false green).${_WA_RST}" >&2
          RES_STATUS="${RES_STATUS} FAIL(skip-in-gate)"
        else
          echo "${_WA_YELLOW}---- SKIP : postgres-prev-release (set PREV_IMAGE=<last released image> to run upgrade-proof.sh) ----${_WA_RST}"
          RES_STATUS="${RES_STATUS} SKIP"
        fi
        echo ""
      fi
      ;;
  esac
done

# ── Summary table (closeout-suite shape) ─────────────────────────────────────
echo "== works-after summary =="
# shellcheck disable=SC2086
set -- $RES_NAMES
NAMES=("$@")
# shellcheck disable=SC2086
set -- $RES_STATUS
STATUSES=("$@")
FAILED=0
SKIPPED=0
for idx in "${!NAMES[@]}"; do
  n="${NAMES[$idx]}"; s="${STATUSES[$idx]}"
  case "$s" in
    PASS)  echo "  ${_WA_GREEN}[PASS]${_WA_RST} ${n}" ;;
    SKIP)  echo "  ${_WA_YELLOW}[SKIP]${_WA_RST} ${n}"; SKIPPED=$((SKIPPED+1)) ;;
    *)     echo "  ${_WA_RED}[${s}]${_WA_RST} ${n}"; FAILED=$((FAILED+1)) ;;
  esac
done
echo ""

if [ "$FAILED" -gt 0 ]; then
  echo "${_WA_RED}works-after: FAIL — ${FAILED} arm(s) failed.${_WA_RST}" >&2
  exit 1
fi
echo "${_WA_GREEN}works-after: OK — all selected arms passed${_WA_RST}$([ "$SKIPPED" -gt 0 ] && echo " (${SKIPPED} skipped)")."
