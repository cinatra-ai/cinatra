#!/usr/bin/env bash
set -euo pipefail
# works-after :: Wayflow arm (cinatra#352).
#
# Builds the docker/wayflow image at CANDIDATE pins (PYTHON_TAG /
# WAYFLOWCORE_VERSION / PYAGENTSPEC_VERSION build-args; defaults = current pins),
# mounts the committed no-LLM echo-flow fixture
# (tests/fixtures/works-after-agent/), boots the runtime, then drives BOTH A2A
# surfaces against the candidate runtime: the blocking message/send → completed
# round-trip (rt/wayflow-a2a-send.mjs) AND — CAPABILITY-AWARE (owner Option B,
# cinatra#1148) — the streaming message/stream SSE round-trip
# (rt/wayflow-a2a-stream.mjs): that arm reads the runtime agent card's
# capabilities.streaming and only REQUIRES the stream round-trip when the card
# advertises it (recording an explicit n/a otherwise; a card that claims
# streaming:true yet fails the round-trip FAILS). Both arms assert the
# round-tripped nonce surfaces via the EndNode output (not merely the echoed
# user input).
#
# This proves "wayflow works after a python/wayflowcore-major bump" with a
# DETERMINISTIC, LLM-FREE agent (path A; design §1.5): the A2A server + task
# broker/worker + ASGI app + message protocol — exactly what a bump of the
# wayflow python stack can break — without any LLM key or private extension.
#
# The runtime fails LOUD at boot without CINATRA_BRIDGE_TOKEN or
# CINATRA_CONTEXT_ATTEST_KEY; the arm mints throwaway values for both. The loader
# ONLY mounts an agent dir that carries a valid
# .cinatra-published.json marker whose oasSha256 matches cinatra/oas.json, so the
# fixture ships that committed marker (kept in sync by works-after:test).
#
# Env: PYTHON_TAG (default 3.14-slim), WAYFLOWCORE_VERSION (default 26.1.2),
#      PYAGENTSPEC_VERSION (default 26.1.2). Defaults mirror the Dockerfile ARG
#      pins; CI derives the candidate from the Dockerfile so a bare local run
#      and the gate test the same image.

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

PYTHON_TAG="${PYTHON_TAG:-3.14-slim}"
WAYFLOWCORE_VERSION="${WAYFLOWCORE_VERSION:-26.1.2}"
PYAGENTSPEC_VERSION="${PYAGENTSPEC_VERSION:-26.1.2}"
RUN_ID="wa-wayflow-$$"
NET="${RUN_ID}-net"
APP="${RUN_ID}-runtime"
IMG="cinatra-works-after-wayflow:${RUN_ID}"
FIXTURE_ROOT="${REPO_ROOT}/tests/fixtures/works-after-agent"
AGENT_PATH="/agents/cinatra-works-after/echo-proof"

cleanup() {
  docker rm -fv "$APP" >/dev/null 2>&1 || true
  docker image rm "$IMG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
dump_diag() {
  wa_group_start "works-after wayflow failure diagnostics"
  echo "--- docker ps -a (run containers) ---"; docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- runtime /.health ---"
  if [ -n "${HOST_PORT:-}" ]; then curl -fsS "http://127.0.0.1:${HOST_PORT}/.health" 2>&1 | head -c 400 || true; echo; fi
  echo "--- runtime logs (wayflowcore version + per-agent load failures) ---"; docker logs "$APP" 2>&1 | tail -60 || true
  wa_group_end
}
on_err() { echo "${_WA_RED}ERROR: works-after wayflow FAILED (line $1).${_WA_RST}" >&2; dump_diag; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT
fail() { echo "${_WA_RED}ERROR: $*${_WA_RST}" >&2; dump_diag; exit 1; }

wa_log "works-after wayflow: candidate python:${PYTHON_TAG} wayflowcore==${WAYFLOWCORE_VERSION} pyagentspec==${PYAGENTSPEC_VERSION}"

[ -f "${FIXTURE_ROOT}/cinatra-works-after/echo-proof/cinatra/oas.json" ] \
  || fail "echo-flow fixture missing at ${FIXTURE_ROOT}/cinatra-works-after/echo-proof/cinatra/oas.json"

wa_info "building candidate wayflow image"
docker build \
  --build-arg "PYTHON_TAG=${PYTHON_TAG}" \
  --build-arg "WAYFLOWCORE_VERSION=${WAYFLOWCORE_VERSION}" \
  --build-arg "PYAGENTSPEC_VERSION=${PYAGENTSPEC_VERSION}" \
  -t "$IMG" "${REPO_ROOT}/docker/wayflow" >/dev/null \
  || fail "candidate wayflow image build failed (python:${PYTHON_TAG} wayflowcore==${WAYFLOWCORE_VERSION})."

docker network create "$NET" >/dev/null

BRIDGE_TOKEN="works-after-$(wa_throwaway_hexkey 16)"
# #1192: the boot preflight also requires the per-node context-attestation key
# (symmetric with the bridge token). This deterministic arm runs NO composed
# children, but the runtime refuses to boot without it — mint a throwaway so the
# real preflight-pass boot path is exercised (rather than the opt-out bypass).
ATTEST_KEY="works-after-$(wa_throwaway_hexkey 16)"
# Loopback-only ephemeral host port; mount the fixture tree read-only at /agents.
docker run -d --name "$APP" --network "$NET" -p 127.0.0.1::3010 \
  -e PORT=3010 \
  -e CINATRA_AGENTS_DIR=/agents \
  -e CINATRA_BRIDGE_TOKEN="$BRIDGE_TOKEN" \
  -e CINATRA_CONTEXT_ATTEST_KEY="$ATTEST_KEY" \
  -e CINATRA_BASE_URL="http://host.docker.internal:3000" \
  -v "${FIXTURE_ROOT}:/agents:ro" \
  "$IMG" >/dev/null

HOST_PORT=""
for i in $(seq 1 40); do
  HOST_PORT="$(wa_host_port "$APP" 3010)"
  if [ -n "$HOST_PORT" ] && curl -fsS "http://127.0.0.1:${HOST_PORT}/.health" >/dev/null 2>&1; then break; fi
  # A crashed runtime never becomes healthy — fail fast with its logs.
  if [ "$(docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null)" != "true" ]; then
    fail "wayflow runtime exited before becoming healthy."
  fi
  if [ "$i" -eq 40 ]; then fail "wayflow /.health did not answer within 120s."; fi
  sleep 3
done
WAYFLOW_URL="http://127.0.0.1:${HOST_PORT}"
wa_info "wayflow runtime up at ${WAYFLOW_URL}"

# The echo agent must be mounted and NOT in failed_agents.
HEALTH="$(curl -fsS "${WAYFLOW_URL}/.health")"
echo "$HEALTH" | grep -q '"agents"' || fail "/.health did not report an agents count: ${HEALTH}"
if echo "$HEALTH" | grep -q 'cinatra-works-after/echo-proof'; then
  # Present in /.health only when it FAILED (failed_agents lists failures).
  echo "$HEALTH" | grep -q '"failed_agents":\[\]' \
    || fail "echo-proof agent failed to load: ${HEALTH}"
fi
wa_info "health: ${HEALTH}"

# cinatra#1830 — exercise the HITL InputMessageNode gate mount guard against the
# CANDIDATE runtime, pointed at the exact tree the runtime just loaded. The
# image already carries wayflowcore/pyagentspec/pytest; running the guard here
# proves the #1830 declared-inputs reconcile shim (and the whole mount pre-load
# pipeline) still holds after a python/wayflowcore bump — the point of
# works-after. CINATRA_AGENTS_DIR=/agents is the SAME value the runtime booted
# with, so test_repo_agents_load discovers exactly the mounted set via the
# loader's own discover_agents walk (a known-failing gate agent is strict-xfail,
# so its red stays visible without failing the arm).
wa_info "running #1830 HITL gate mount-guard suites inside the candidate runtime"
docker exec -e CINATRA_AGENTS_DIR=/agents "$APP" \
  python -m pytest -q \
  tests/test_input_message_gate_reconcile.py \
  tests/test_repo_agents_load.py \
  || fail "HITL gate mount-guard suites failed inside the candidate wayflow runtime (#1830 reconcile shim / installed-tree load)."

NONCE="wa-$(date +%s)-${RANDOM}"
WAYFLOW_BASE_URL="$WAYFLOW_URL" WAYFLOW_AGENT_PATH="$AGENT_PATH" WORKS_AFTER_NONCE="$NONCE" \
  wa_node "${REPO_ROOT}/scripts/ci/works-after/rt/wayflow-a2a-send.mjs" \
  || fail "wayflow A2A message/send round-trip failed (task did not complete with the nonce)."

# cinatra#1148 (owner Option B — CAPABILITY-AWARE): prove the STREAMING surface
# against the bumped runtime WHEN the runtime advertises it. message/stream (SSE)
# is a distinct, load-bearing path (the @a2a-js multi-line-SSE `data:` fix exists
# because it broke); the host-side packages/a2a SSE tests MOCK the streaming
# bridge, so only this boots the candidate runtime and drives its native fasta2a
# SSE stream. The probe itself reads the agent card's capabilities.streaming: it
# records an explicit n/a (exit 0) when the runtime declares no streaming, runs
# the REQUIRED round-trip when it does, and FAILS (exit 1) if a card that claims
# streaming:true cannot deliver it. A fresh nonce so the stream proof cannot pass
# on the send arm's echoed input.
STREAM_NONCE="wa-stream-$(date +%s)-${RANDOM}"
WAYFLOW_BASE_URL="$WAYFLOW_URL" WAYFLOW_AGENT_PATH="$AGENT_PATH" WORKS_AFTER_NONCE="$STREAM_NONCE" \
  wa_node "${REPO_ROOT}/scripts/ci/works-after/rt/wayflow-a2a-stream.mjs" \
  || fail "wayflow A2A message/stream arm failed (card advertised streaming:true but the round-trip did not complete with the nonce)."

echo "${_WA_GREEN}==> works-after wayflow PASSED${_WA_RST} — candidate wayflow ran an agent over A2A (message/send → completed REQUIRED; message/stream SSE proved when the card advertises streaming, else recorded n/a; nonce surfaced wherever it ran)."
