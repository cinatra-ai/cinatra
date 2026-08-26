#!/usr/bin/env bash
set -euo pipefail
# works-after :: Neo4j / Graphiti arm (cinatra#352, re-shaped by cinatra#2591).
#
# Brings up candidate neo4j + the LOCAL embedder + the candidate graphiti server
# on an ISOLATED network with the real depends_on/auth env wiring (load-bearing
# config; design §2.2), then runs the project->store->retrieve round-trip
# (rt/graphiti-roundtrip.ts) through the repo's OWN graphiti-client.ts
# (MCP-over-HTTP).
#
# TWO TIERS (cinatra#2591). The arm used to be all-or-nothing on a real OpenAI
# key, because the pinned wrapper's factory built the OpenAI LLM client WITHOUT a
# base_url — extraction always hit api.openai.com, so no stand-in was possible
# and the whole arm had to be excluded from the secret-free CI set. The
# replacement server (docker/graphiti/Dockerfile) forwards `base_url`, and more
# importantly cinatra#2591's row recovery no longer depends on extraction at all.
# So:
#
#   TIER 1 — KEYLESS (always runs, NO secret). Proves what the substrate must do
#     without any vendor: the server BOOTS against real Neo4j with the local
#     embedder; `server/discover` is re-probed (the standing cinatra#2218 flip
#     condition, so the `{mode:"legacy"}` justification cannot go stale); a row
#     is seeded as a DETERMINISTIC anchor node and comes back from a SEMANTIC
#     query; re-seeding is an upsert; and a keyless episode is confirmed to be
#     accepted-then-dropped (the honest "extraction is off" state).
#
#   TIER 2 — KEYED (runs when OPENAI_API_KEY is present). Adds what only a real
#     provider can prove: episode -> EXTRACTION -> the extracted entity is
#     searchable. Outside gate mode a missing key SKIPS tier 2 (the arm still
#     passes on tier 1). In gate mode (WORKS_AFTER_GATE_MODE=1) a missing key is
#     a FAIL — a skipped proof is a false green when the arm is gating a
#     neo4j/graphiti major.
#
# Env: NEO4J_IMAGE (the FULL pinned ref `neo4j:<tag>@sha256:…` the harness runs —
#        so CI proves the DIGEST, not just the floating tag; derived from the
#        upgrade matrix),
#      NEO4J_TAG (tag component only — log/diagnostic lines and back-compat),
#      GRAPHITI_IMAGE (default: BUILT from docker/graphiti, so the proof binds
#        the bytes this repo ships rather than a registry tag),
#      KG_EMBEDDER_IMAGE (default: BUILT from docker/kg-embedder),
#      OPENAI_API_KEY (tier 2 only), WORKS_AFTER_GATE_MODE.
#
# The neo4j bring-up below mirrors the compose config for the CalVer major: it
# pins db.query.default_language back to CYPHER_5 (the CalVer default is
# CYPHER_25; graphiti emits Cypher-5-shaped queries). The
# NEO4J_PASSWORD generated below ("wa-" + 24 hex chars = 27) clears the major's
# new 8-char minimum-password floor.

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

NEO4J_TAG="${NEO4J_TAG:-2026.05-community}"
# Full pinned ref (tag@sha256) — authoritative for the pull, so the proof binds
# the DIGEST. Defaults to the neo4j matrix pin (== the compose pin, gated equal
# by the pin-drift check), DERIVED at runtime rather than copied (cinatra#2304),
# so a standalone run still proves the bytes the repo ships.
NEO4J_IMAGE="${NEO4J_IMAGE:-$(wa_matrix_pin neo4j)}"
GRAPHITI_IMAGE="${GRAPHITI_IMAGE:-}"
KG_EMBEDDER_IMAGE="${KG_EMBEDDER_IMAGE:-}"
GATE_MODE="${WORKS_AFTER_GATE_MODE:-0}"
RUN_ID="wa-graphiti-$$"
NET="${RUN_ID}-net"
NEO="${RUN_ID}-neo4j"
EMB="${RUN_ID}-embedder"
GR="${RUN_ID}-graphiti"

# TIER SELECTION (see header). Tier 1 always runs; tier 2 needs a real key. In
# gate mode a missing key is a hard FAIL, because a neo4j/graphiti major that is
# gated on this arm must have its EXTRACTION path proven, not just its substrate.
RUN_KEYED=1
if [ -z "${OPENAI_API_KEY:-}" ]; then
  if [ "$GATE_MODE" = "1" ]; then
    echo "${_WA_RED}ERROR: works-after graphiti requires OPENAI_API_KEY in gate mode (a skipped extraction proof is a false green). The lane must supply a real key.${_WA_RST}" >&2
    exit 1
  fi
  RUN_KEYED=0
  echo "${_WA_YELLOW}==> works-after graphiti: tier 2 (extraction) SKIPPED${_WA_RST} — no OPENAI_API_KEY. Tier 1 (substrate + local embedder + deterministic recovery) still runs, and needs no secret."
fi

NEO4J_PASSWORD="wa-$(wa_throwaway_hexkey 12)"

cleanup() {
  docker rm -fv "$GR" "$EMB" "$NEO" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
dump_diag() {
  wa_group_start "works-after graphiti failure diagnostics"
  echo "--- docker ps -a (run containers) ---"; docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- graphiti logs (version + neo4j connection + embedder/LLM base-URL) ---"; docker logs "$GR" 2>&1 | tail -50 || true
  echo "--- local embedder logs ---"; docker logs "$EMB" 2>&1 | tail -20 || true
  echo "--- neo4j logs ---"; docker logs "$NEO" 2>&1 | tail -30 || true
  wa_group_end
}
on_err() { echo "${_WA_RED}ERROR: works-after graphiti FAILED (line $1).${_WA_RST}" >&2; dump_diag; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT
fail() { echo "${_WA_RED}ERROR: $*${_WA_RST}" >&2; dump_diag; exit 1; }

# BUILD the candidates by default (cinatra#2591): the indexer is no longer a
# registry tag we pull, it is an image this repo builds from a pinned upstream
# commit. Building here is what makes the proof bind the shipped Dockerfile.
if [ -z "$GRAPHITI_IMAGE" ]; then
  GRAPHITI_IMAGE="cinatra-works-after/knowledge-graph-mcp:${RUN_ID}"
  wa_info "building the knowledge-graph indexer from docker/graphiti (pinned upstream ref + graphiti-core)"
  docker build -t "$GRAPHITI_IMAGE" "${REPO_ROOT}/docker/graphiti" >/dev/null \
    || fail "docker/graphiti failed to build."
fi
if [ -z "$KG_EMBEDDER_IMAGE" ]; then
  KG_EMBEDDER_IMAGE="cinatra-works-after/kg-embedder:${RUN_ID}"
  wa_info "building the local embedder from docker/kg-embedder"
  docker build -t "$KG_EMBEDDER_IMAGE" "${REPO_ROOT}/docker/kg-embedder" >/dev/null \
    || fail "docker/kg-embedder failed to build."
fi

wa_log "works-after graphiti: candidate ${NEO4J_IMAGE} + ${GRAPHITI_IMAGE} + ${KG_EMBEDDER_IMAGE}"

docker network create "$NET" >/dev/null
docker run -d --name "$NEO" --network "$NET" \
  -e NEO4J_AUTH="neo4j/${NEO4J_PASSWORD}" \
  -e NEO4J_PLUGINS='["apoc"]' \
  -e NEO4J_apoc_export_file_enabled=true \
  -e NEO4J_apoc_import_file_enabled=true \
  -e NEO4J_db_query_default__language=CYPHER_5 \
  "$NEO4J_IMAGE" >/dev/null

wa_info "waiting for neo4j readiness"
NEO_READY=0
for i in $(seq 1 40); do
  if docker exec "$NEO" cypher-shell -u neo4j -p "$NEO4J_PASSWORD" 'RETURN 1' >/dev/null 2>&1; then NEO_READY=1; break; fi
  sleep 3
done
[ "$NEO_READY" -eq 1 ] || fail "neo4j did not become ready within 120s."

# The LOCAL embedder — the vendor-free floor. No published port: it is reachable
# only on this isolated network, exactly as in compose.
docker run -d --name "$EMB" --network "$NET" "$KG_EMBEDDER_IMAGE" >/dev/null
wa_info "waiting for the local embedder"
EMB_READY=0
for i in $(seq 1 40); do
  if docker exec "$EMB" curl -fsS http://localhost:8080/health >/dev/null 2>&1; then EMB_READY=1; break; fi
  sleep 3
done
[ "$EMB_READY" -eq 1 ] || fail "the local embedder did not become ready within 120s."
wa_info "local embedder ready: $(docker exec "$EMB" curl -fsS http://localhost:8080/health)"

# ---------------------------------------------------------------------------
# start_graphiti <tier>
#
# tier=keyless : NO provider key. The LLM slot carries the SAME named sentinel
#                the bring-up writes (scripts/gen-graphiti-env.mjs). It is not a
#                credential and cannot buy a call — it exists because the server
#                CRASHES at startup without it: CrossEncoderFactory builds an
#                OpenAIRerankerClient from the LLM provider block regardless of
#                whether a key exists, and AsyncOpenAI(api_key=None) raises. If
#                a future upstream fixes that, this sentinel can go and the tier
#                keeps passing.
# tier=keyed   : the lane-supplied OPENAI_API_KEY drives extraction; the local
#                embedder still serves vectors, so the tier also proves the two
#                halves can come from different places.
# tier=anthropic: the MULTI-PROVIDER arm (cinatra#2591 deliverable 2). The server
#                runs with llm.provider=anthropic and the local embedder floor —
#                the shape `scripts/gen-graphiti-env.mjs` materializes for an
#                install whose committed provider is Anthropic. It proves the
#                claim the floor exists for: an Anthropic install BOOTS and RANKS
#                with exactly ONE vendor, because Anthropic publishes no
#                embeddings API and the vectors come from the local service.
#                The openai provider block is left at its config.yaml defaults
#                (named sentinel + no-egress URL) ON PURPOSE: CrossEncoderFactory
#                may still construct a reranker from it, and the sentinel is what
#                keeps that construction from raising — see the keyless tier.
#                Extraction itself is only exercised when ANTHROPIC_API_KEY is
#                supplied; without it this tier asserts boot + ranking, and says
#                so rather than implying a proof it did not run.
# ---------------------------------------------------------------------------
start_graphiti() {
  local tier="$1"
  docker rm -fv "$GR" >/dev/null 2>&1 || true
  # A REAL key is handed over by NAME (`-e VAR`), never as `-e VAR=value`.
  # `-e VAR=value` puts the credential in the docker CLI's ARGV, where any local
  # process can read it out of `ps` for the lifetime of the call; `-e VAR` tells
  # docker to copy it from THIS shell's environment instead, so it never becomes
  # a command-line argument. The non-secret sentinels are literals and stay
  # inline — naming them would only obscure that they are not credentials.
  local -a key_env
  local llm_provider="openai"
  if [ "$tier" = "keyed" ]; then
    export LLM__PROVIDERS__OPENAI__API_KEY="$OPENAI_API_KEY"
    key_env=(-e LLM__PROVIDERS__OPENAI__API_KEY -e OPENAI_API_KEY)
  elif [ "$tier" = "anthropic" ]; then
    llm_provider="anthropic"
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
      export LLM__PROVIDERS__ANTHROPIC__API_KEY="$ANTHROPIC_API_KEY"
      key_env=(-e LLM__PROVIDERS__ANTHROPIC__API_KEY)
    else
      key_env=(-e "LLM__PROVIDERS__ANTHROPIC__API_KEY=cinatra-no-extraction-provider-configured")
    fi
  else
    key_env=(-e "LLM__PROVIDERS__OPENAI__API_KEY=cinatra-no-extraction-provider-configured")
  fi
  docker run -d --name "$GR" --network "$NET" -p 127.0.0.1::8000 \
    -v "${REPO_ROOT}/docker/graphiti/config.yaml:/app/mcp/config/cinatra.yaml:ro" \
    -e CONFIG_PATH=/app/mcp/config/cinatra.yaml \
    -e DATABASE__PROVIDER=neo4j \
    -e DATABASE__PROVIDERS__NEO4J__URI="bolt://${NEO}:7687" \
    -e DATABASE__PROVIDERS__NEO4J__USERNAME=neo4j \
    -e DATABASE__PROVIDERS__NEO4J__PASSWORD="$NEO4J_PASSWORD" \
    -e "LLM__PROVIDER=${llm_provider}" \
    "${key_env[@]}" \
    -e EMBEDDER__PROVIDER=openai \
    -e EMBEDDER__MODEL=bge-small-en-v1.5 \
    -e EMBEDDER__DIMENSIONS=384 \
    -e "EMBEDDER__PROVIDERS__OPENAI__API_URL=http://${EMB}:8080/v1" \
    -e EMBEDDER__PROVIDERS__OPENAI__API_KEY=cinatra-local-embedder \
    -e SEMAPHORE_LIMIT=10 \
    "$GRAPHITI_IMAGE" >/dev/null

  HOST_PORT=""
  for i in $(seq 1 40); do
    HOST_PORT="$(wa_host_port "$GR" 8000)"
    # The replacement server has a REAL readiness route; the old wrapper had
    # none, which is why this used to be a bare TCP connect that went green
    # before the server could serve.
    if [ -n "$HOST_PORT" ] && curl -fsS -o /dev/null "http://127.0.0.1:${HOST_PORT}/health" 2>/dev/null; then break; fi
    if [ "$i" -eq 40 ]; then fail "graphiti (${tier}) did not report healthy within 120s."; fi
    sleep 3
  done
  GRAPHITI_URL="http://127.0.0.1:${HOST_PORT}"
  wa_info "graphiti (${tier}) healthy at ${GRAPHITI_URL}"
}

# ---------------------------------------------------------------------------
# TIER 1 — KEYLESS. No secret involved.
# ---------------------------------------------------------------------------
wa_group_start "works-after graphiti tier 1 — substrate + local embedder + deterministic recovery (no key)"
start_graphiti keyless

# Re-assert the standing cinatra#2218 negotiation condition against THIS server.
# `server/discover` before a session must be refused; the day it is not, the
# client's `{mode:"legacy"}` pin is due to flip to `auto` and this line is what
# makes that visible instead of leaving a stale justification in a comment.
DISCOVER_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}' \
  "${GRAPHITI_URL}/mcp" || echo 000)"
if [ "$DISCOVER_STATUS" = "200" ]; then
  fail "server/discover now ANSWERS (HTTP 200). The graphiti-client.ts \`{mode:\"legacy\"}\` pin was justified by this refusal (cinatra#2218 / cinatra#2591 AC3) — re-probe and flip it to { mode: \"auto\" } in the same change that bumps the image."
fi
wa_info "server/discover still refused pre-session (HTTP ${DISCOVER_STATUS}) — the legacy negotiation pin remains justified"

MARKER="WorksAfterMarker$(wa_throwaway_hexkey 6)"
GRAPHITI_URL="$GRAPHITI_URL" WORKS_AFTER_MARKER="$MARKER" WORKS_AFTER_TIER="keyless" \
  WORKS_AFTER_DEADLINE_MS="${WORKS_AFTER_DEADLINE_MS:-120000}" \
  wa_node --conditions=react-server --import tsx "${REPO_ROOT}/scripts/ci/works-after/rt/graphiti-roundtrip.ts" \
  || fail "graphiti tier 1 (deterministic recovery on the local embedder) failed."
wa_group_end

# ---------------------------------------------------------------------------
# TIER 1b — ANTHROPIC PROVIDER SELECTION (cinatra#2591 deliverable 2).
#
# The claim under test is the one the embedder floor exists to make: an install
# whose committed provider is Anthropic runs the substrate with exactly ONE
# vendor. Anthropic has no embeddings API, so the vectors come from the local
# service, and the SAME deterministic-recovery round-trip that tier 1 runs must
# still pass with `llm.provider=anthropic`.
#
# This tier needs NO secret: it asserts that the server boots on the Anthropic
# provider block and that seeding + ranking (embedder-only work) still resolve
# rows deterministically. Anthropic EXTRACTION is only exercised when
# ANTHROPIC_API_KEY is set, and the arm never claims otherwise.
# ---------------------------------------------------------------------------
wa_group_start "works-after graphiti tier 1b — anthropic provider selection on the local embedder floor"
start_graphiti anthropic
MARKER="WorksAfterMarker$(wa_throwaway_hexkey 6)"
GRAPHITI_URL="$GRAPHITI_URL" WORKS_AFTER_MARKER="$MARKER" WORKS_AFTER_TIER="keyless" \
  WORKS_AFTER_DEADLINE_MS="${WORKS_AFTER_DEADLINE_MS:-120000}" \
  wa_node --conditions=react-server --import tsx "${REPO_ROOT}/scripts/ci/works-after/rt/graphiti-roundtrip.ts" \
  || fail "graphiti tier 1b (anthropic provider selection + deterministic recovery on the local embedder) failed."
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  wa_info "tier 1b ran with a real ANTHROPIC_API_KEY — anthropic extraction exercised"
else
  wa_info "tier 1b ran WITHOUT an anthropic key — boot + local-embedder ranking proven; anthropic extraction NOT exercised"
fi
wa_group_end

# ---------------------------------------------------------------------------
# TIER 2 — KEYED. Extraction, which only a real provider can prove.
# ---------------------------------------------------------------------------
if [ "$RUN_KEYED" = "1" ]; then
  wa_group_start "works-after graphiti tier 2 — extraction on a real provider"
  start_graphiti keyed
  MARKER="WorksAfterMarker$(wa_throwaway_hexkey 6)"
  GRAPHITI_URL="$GRAPHITI_URL" WORKS_AFTER_MARKER="$MARKER" WORKS_AFTER_TIER="keyed" \
    WORKS_AFTER_DEADLINE_MS="${WORKS_AFTER_DEADLINE_MS:-120000}" \
    wa_node --conditions=react-server --import tsx "${REPO_ROOT}/scripts/ci/works-after/rt/graphiti-roundtrip.ts" \
    || fail "graphiti tier 2 (episode -> extraction -> searchable entity) failed."
  wa_group_end
  echo "${_WA_GREEN}==> works-after graphiti PASSED${_WA_RST} — tier 1 (substrate + local embedder + deterministic recovery) AND tier 2 (extraction) both green."
else
  echo "${_WA_GREEN}==> works-after graphiti PASSED (tier 1)${_WA_RST} — substrate + local embedder + deterministic recovery green; extraction tier skipped (no key)."
fi
