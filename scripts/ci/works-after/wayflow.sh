#!/usr/bin/env bash
set -euo pipefail
# works-after :: Wayflow arm (cinatra#352).
#
# Builds the docker/wayflow image at CANDIDATE pins (PYTHON_TAG /
# WAYFLOWCORE_VERSION / PYAGENTSPEC_VERSION build-args; defaults = current pins),
# mounts the committed no-LLM echo-flow fixture
# (tests/fixtures/works-after-agent/), boots the runtime, then drives the A2A
# message/send → completed round-trip (rt/wayflow-a2a-send.mjs) and asserts the
# task completes with the round-tripped nonce surfaced via the EndNode output.
#
# This proves "wayflow works after a python/wayflowcore-major bump" with a
# DETERMINISTIC, LLM-FREE agent (path A; design §1.5): the A2A server + task
# broker/worker + ASGI app + message protocol — exactly what a bump of the
# wayflow python stack can break — without any LLM key or private extension.
#
# The runtime fails LOUD at boot without CINATRA_BRIDGE_TOKEN; the arm mints a
# throwaway one. The loader ONLY mounts an agent dir that carries a valid
# .cinatra-published.json marker whose oasSha256 matches cinatra/oas.json, so the
# fixture ships that committed marker (kept in sync by works-after:test).
#
# Env: PYTHON_TAG (default 3.11-slim), WAYFLOWCORE_VERSION (default 26.1.1),
#      PYAGENTSPEC_VERSION (default 26.1.0).

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

PYTHON_TAG="${PYTHON_TAG:-3.11-slim}"
WAYFLOWCORE_VERSION="${WAYFLOWCORE_VERSION:-26.1.1}"
PYAGENTSPEC_VERSION="${PYAGENTSPEC_VERSION:-26.1.0}"
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
# Loopback-only ephemeral host port; mount the fixture tree read-only at /agents.
docker run -d --name "$APP" --network "$NET" -p 127.0.0.1::3010 \
  -e PORT=3010 \
  -e CINATRA_AGENTS_DIR=/agents \
  -e CINATRA_BRIDGE_TOKEN="$BRIDGE_TOKEN" \
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

NONCE="wa-$(date +%s)-${RANDOM}"
WAYFLOW_BASE_URL="$WAYFLOW_URL" WAYFLOW_AGENT_PATH="$AGENT_PATH" WORKS_AFTER_NONCE="$NONCE" \
  wa_node "${REPO_ROOT}/scripts/ci/works-after/rt/wayflow-a2a-send.mjs" \
  || fail "wayflow A2A message/send round-trip failed (task did not complete with the nonce)."

echo "${_WA_GREEN}==> works-after wayflow PASSED${_WA_RST} — candidate wayflow ran an agent over A2A (message/send → completed, nonce surfaced)."
