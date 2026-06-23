#!/usr/bin/env bash
set -euo pipefail
# works-after :: Neo4j / Graphiti arm (cinatra#352).
#
# Brings up candidate neo4j (NEO4J_TAG, default 5.26-community) + candidate
# graphiti (GRAPHITI_IMAGE, default the current pin) on an ISOLATED network with
# the real depends_on/auth env wiring (load-bearing config; design §2.2), then
# runs the project→store→retrieve round-trip (rt/graphiti-roundtrip.ts) through
# the repo's OWN graphiti-client.ts (MCP-over-HTTP) and asserts the projected
# episode is read back AND the extracted marker entity is searchable.
#
# REQUIRES a real OPENAI_API_KEY (settled empirically, design §1.4/§6.1): the
# graphiti image does entity EXTRACTION (LLM) BEFORE writing to Neo4j, the
# episode write is aborted if extraction fails, and the image's factory does NOT
# honor a custom OpenAI base-URL for the LLM client (only the embedder's) — so a
# local OpenAI fake CANNOT stand in. This arm is therefore NOT in the secret-free
# always-on PR set; the major-upgrade LANE / workflow_dispatch runs it with a key
# it supplies. Outside gate mode, a MISSING key => SKIP (exit 78). In gate mode
# (WORKS_AFTER_GATE_MODE=1) a missing key is a FAIL (a skipped proof is a false
# green) — the lane MUST supply the key when it gates a neo4j/graphiti major.
#
# Env: NEO4J_TAG (default 5.26-community),
#      GRAPHITI_IMAGE (default zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2),
#      OPENAI_API_KEY (required to RUN; see above), WORKS_AFTER_GATE_MODE.

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

NEO4J_TAG="${NEO4J_TAG:-5.26-community}"
GRAPHITI_IMAGE="${GRAPHITI_IMAGE:-zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2}"
GATE_MODE="${WORKS_AFTER_GATE_MODE:-0}"
RUN_ID="wa-graphiti-$$"
NET="${RUN_ID}-net"
NEO="${RUN_ID}-neo4j"
GR="${RUN_ID}-graphiti"

# Key gate (see header). EXIT 78 is the conventional "skipped" code the
# orchestrator maps to SKIP; in gate mode a missing key is a hard FAIL.
if [ -z "${OPENAI_API_KEY:-}" ]; then
  if [ "$GATE_MODE" = "1" ]; then
    echo "${_WA_RED}ERROR: works-after graphiti requires OPENAI_API_KEY in gate mode (a skipped neo4j/graphiti proof is a false green). The lane must supply a real key.${_WA_RST}" >&2
    exit 1
  fi
  echo "${_WA_YELLOW}==> works-after graphiti SKIPPED${_WA_RST} — no OPENAI_API_KEY (graphiti entity extraction needs a real LLM; this arm runs in the major lane with a key). Set OPENAI_API_KEY to run."
  exit 78
fi

NEO4J_PASSWORD="wa-$(wa_throwaway_hexkey 12)"

cleanup() {
  docker rm -fv "$GR" "$NEO" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
dump_diag() {
  wa_group_start "works-after graphiti failure diagnostics"
  echo "--- docker ps -a (run containers) ---"; docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- graphiti logs (version + neo4j connection + embedder/LLM base-URL) ---"; docker logs "$GR" 2>&1 | tail -50 || true
  echo "--- neo4j logs ---"; docker logs "$NEO" 2>&1 | tail -30 || true
  wa_group_end
}
on_err() { echo "${_WA_RED}ERROR: works-after graphiti FAILED (line $1).${_WA_RST}" >&2; dump_diag; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT
fail() { echo "${_WA_RED}ERROR: $*${_WA_RST}" >&2; dump_diag; exit 1; }

wa_log "works-after graphiti: candidate neo4j:${NEO4J_TAG} + ${GRAPHITI_IMAGE}"

docker network create "$NET" >/dev/null
docker run -d --name "$NEO" --network "$NET" \
  -e NEO4J_AUTH="neo4j/${NEO4J_PASSWORD}" \
  -e NEO4J_PLUGINS='["apoc"]' \
  -e NEO4J_apoc_export_file_enabled=true \
  -e NEO4J_apoc_import_file_enabled=true \
  "neo4j:${NEO4J_TAG}" >/dev/null

wa_info "waiting for neo4j readiness"
NEO_READY=0
for i in $(seq 1 40); do
  if docker exec "$NEO" cypher-shell -u neo4j -p "$NEO4J_PASSWORD" 'RETURN 1' >/dev/null 2>&1; then NEO_READY=1; break; fi
  sleep 3
done
[ "$NEO_READY" -eq 1 ] || fail "neo4j did not become ready within 120s."

# Graphiti, with the real compose env wiring (DATABASE__PROVIDER=neo4j etc.) +
# the lane-supplied OPENAI_API_KEY. Loopback-only ephemeral host port.
docker run -d --name "$GR" --network "$NET" -p 127.0.0.1::8000 \
  -e DATABASE__PROVIDER=neo4j \
  -e DATABASE__PROVIDERS__NEO4J__URI="bolt://${NEO}:7687" \
  -e DATABASE__PROVIDERS__NEO4J__USERNAME=neo4j \
  -e DATABASE__PROVIDERS__NEO4J__PASSWORD="$NEO4J_PASSWORD" \
  -e LLM__PROVIDERS__OPENAI__API_KEY="$OPENAI_API_KEY" \
  -e EMBEDDER__PROVIDERS__OPENAI__API_KEY="$OPENAI_API_KEY" \
  -e OPENAI_API_KEY="$OPENAI_API_KEY" \
  -e SEMAPHORE_LIMIT=10 \
  "$GRAPHITI_IMAGE" >/dev/null

HOST_PORT=""
for i in $(seq 1 40); do
  HOST_PORT="$(wa_host_port "$GR" 8000)"
  # graphiti has no fixed HTTP health route; a TCP connect to 8000 is readiness.
  if [ -n "$HOST_PORT" ] && curl -fsS -o /dev/null "http://127.0.0.1:${HOST_PORT}/" 2>/dev/null; then break; fi
  if [ -n "$HOST_PORT" ] && (exec 3<>"/dev/tcp/127.0.0.1/${HOST_PORT}") 2>/dev/null; then exec 3>&- 3<&-; break; fi
  if [ "$i" -eq 40 ]; then fail "graphiti did not open port 8000 within 120s."; fi
  sleep 3
done
GRAPHITI_URL="http://127.0.0.1:${HOST_PORT}"
wa_info "graphiti up at ${GRAPHITI_URL}"

MARKER="WorksAfterMarker$(wa_throwaway_hexkey 6)"
# graphiti-client.ts is "server-only" → run with the React Server condition.
GRAPHITI_URL="$GRAPHITI_URL" WORKS_AFTER_MARKER="$MARKER" WORKS_AFTER_DEADLINE_MS="${WORKS_AFTER_DEADLINE_MS:-120000}" \
  wa_node --conditions=react-server --import tsx "${REPO_ROOT}/scripts/ci/works-after/rt/graphiti-roundtrip.ts" \
  || fail "graphiti project→store→retrieve round-trip failed."

echo "${_WA_GREEN}==> works-after graphiti PASSED${_WA_RST} — candidate neo4j+graphiti round-tripped an object projection→search."
