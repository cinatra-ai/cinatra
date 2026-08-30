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

# SNAPSHOT THE LANE'S KEY UNDER A NAME NO TIER WRITES.
#
# `load_generated_env` exports every credential-carrying variable the generator
# names, and `OPENAI_API_KEY` is one of them (graphiti_core reads the bare name
# during init). So the fake-key wiring tier OVERWRITES `OPENAI_API_KEY` in this
# shell, and a later `GRAPHITI_TIER_KEY="$OPENAI_API_KEY"` would hand the
# extraction tier the FAKE key — an arm that claims a real provider proof while
# running on a string no vendor accepts. Read the real key from here instead;
# nothing exports over this name.
WA_LANE_OPENAI_KEY="${OPENAI_API_KEY:-}"

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

# A body that is valid JSON but not an OBJECT (`[]`, `null`, a scalar) parses and
# then has no `.get`. That used to escape as a 500 with a traceback while every
# other malformed input got a 400 — the one shape of bad request that read as a
# server fault. Asserted here rather than in a unit test because this service
# ships as a container and has no other harness.
for BAD_BODY in '[]' 'null' '3' '"x"'; do
  EMB_STATUS="$(docker exec "$EMB" curl -s -o /dev/null -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' -d "$BAD_BODY" \
    http://localhost:8080/v1/embeddings || echo 000)"
  [ "$EMB_STATUS" = "400" ] \
    || fail "the local embedder answered HTTP ${EMB_STATUS} for body ${BAD_BODY}; a malformed body is a bad request (400), not a server fault."
done
wa_info "local embedder rejects non-object bodies with 400 (not 500)"

# ---------------------------------------------------------------------------
# load_generated_env <provider>
#
# THE CONFIGURATION UNDER TEST IS THE GENERATOR'S, NOT THIS SCRIPT'S.
#
# Every tier below used to hand-roll its graphiti env, which meant the one
# configuration a real install actually receives — the one
# `scripts/gen-graphiti-env.mjs#buildGraphitiEnv` produces — was the one
# configuration the proof matrix never booted. A generator bug therefore could
# not fail this arm, and one did: the keyed OpenAI branch declared 1536-wide
# `text-embedding-3-small` while leaving the embedder URL at config.yaml's local
# 384-wide default, and a green tier 2 said nothing about it. This helper closes
# that gap by deriving the tier's env from the generator itself.
#
# SECRETS NEVER TRAVEL THROUGH THE SUBSTITUTION. The generator emits the
# credential-carrying variables by NAME only (`KEYVAR <name>`); the shell then
# exports each from its OWN `$GRAPHITI_TIER_KEY` and passes `-e NAME`, so the key
# is never a command-line argument and never crosses a pipe. The generator
# REFUSES to print any value equal to the key, so a future variable that starts
# carrying one fails the arm instead of leaking it.
#
# Sets: GENERATED_ENV_ARGS (the docker -e array) and GENERATED_ENV_SUMMARY (the
# key-free wiring line this arm logs and asserts on).
# ---------------------------------------------------------------------------
load_generated_env() {
  local provider="$1"
  GENERATED_ENV_ARGS=()
  GENERATED_ENV_SUMMARY=""
  local emitted
  # The script body is single-quoted so JS `${...}` reaches node untouched. The
  # ONE value that must come from the shell closes the quotes and reopens them
  # ('"..."'), so REPO_ROOT does expand — shellcheck reads only the outer quotes.
  # shellcheck disable=SC2016
  emitted="$(GRAPHITI_TIER_PROVIDER="$provider" wa_node --input-type=module -e '
    import { buildGraphitiEnv } from "'"${REPO_ROOT}"'/scripts/gen-graphiti-env.mjs";
    const key = process.env.GRAPHITI_TIER_KEY ?? "";
    const { env, hasKey, embedder } = buildGraphitiEnv(key, process.env.GRAPHITI_TIER_PROVIDER);
    const lines = [];
    for (const [name, value] of Object.entries(env)) {
      if (key && value === key) { lines.push(`KEYVAR ${name}`); continue; }
      if (key && String(value).includes(key)) {
        console.error(`refusing to emit ${name}: it embeds the resolved key`);
        process.exit(3);
      }
      lines.push(`SET ${name}=${value}`);
    }
    lines.push(`SUMMARY hasKey=${hasKey} embedder=${embedder}`);
    console.log(lines.join("\n"));
  ')" || fail "buildGraphitiEnv refused to produce an env for provider=${provider}."

  local line name
  while IFS= read -r line; do
    case "$line" in
      "KEYVAR "*)
        name="${line#KEYVAR }"
        # Export from THIS shell's key, so the value never appeared above.
        export "${name}=${GRAPHITI_TIER_KEY}"
        GENERATED_ENV_ARGS+=(-e "$name")
        ;;
      "SET "*)
        name="${line#SET }"
        export "${name%%=*}=${name#*=}"
        GENERATED_ENV_ARGS+=(-e "${name%%=*}")
        ;;
      "SUMMARY "*) GENERATED_ENV_SUMMARY="${line#SUMMARY }" ;;
    esac
  done <<< "$emitted"

  [ "${#GENERATED_ENV_ARGS[@]}" -gt 0 ] \
    || fail "buildGraphitiEnv(provider=${provider}) produced no environment at all."
  # Key-free by construction, and logged so the wiring is READABLE in CI output.
  wa_info "generator env for provider=${provider}: ${GENERATED_ENV_SUMMARY}; $(
    printf '%s\n' "$emitted" | grep '^SET EMBEDDER__' | sed 's/^SET //' | tr '\n' ' '
  )"
}

neo4j_cypher() {
  # The password is a per-run throwaway generated above, not a credential.
  docker exec "$NEO" cypher-shell -u neo4j -p "$NEO4J_PASSWORD" --format plain "$1"
}

# ---------------------------------------------------------------------------
# reset_neo4j <why>
#
# The embedder WIDTH differs between tiers (384 on the local floor, 1536 on
# hosted OpenAI), and every tier shares one Neo4j. Vectors of two widths in one
# store compare wrongly rather than loudly — the exact hazard the generated
# keyed tier exists to catch — so the store is reset before the width changes.
#
# DELETING THE NODES IS NOT ENOUGH. A vector index carries its DIMENSIONS, and
# an index is SCHEMA: it survives `DETACH DELETE` untouched. A 384-wide index
# left standing is still the index the 1536-declared server writes through, so
# clearing only the data would move the silent mismatch one layer down instead
# of removing it. The vector indexes therefore go too, and graphiti rebuilds
# them at the declared width on the startup that immediately follows.
#
# Only VECTOR indexes are dropped. They are the only dimension-bound ones, and
# unlike a constraint-backed range index they can be dropped directly.
# ---------------------------------------------------------------------------
reset_neo4j() {
  local why="$1"
  neo4j_cypher 'MATCH (n) DETACH DELETE n' >/dev/null 2>&1 \
    || fail "could not clear neo4j data before ${why}."

  local names
  names="$(neo4j_cypher "SHOW INDEXES YIELD name, type WHERE type = 'VECTOR' RETURN name" 2>/dev/null | tail -n +2 | tr -d '"\r')" \
    || fail "could not enumerate neo4j vector indexes before ${why}."

  local idx
  while IFS= read -r idx; do
    [ -n "$idx" ] || continue
    neo4j_cypher "DROP INDEX \`${idx}\` IF EXISTS" >/dev/null 2>&1 \
      || fail "could not drop neo4j vector index '${idx}' before ${why}."
  done <<< "$names"

  # ASSERTED, not assumed. A width-bound index that survived this would receive
  # vectors of the other width in silence, which is the whole failure mode.
  local remaining
  remaining="$(neo4j_cypher "SHOW INDEXES YIELD type WHERE type = 'VECTOR' RETURN count(*) AS n" 2>/dev/null | tail -n +2 | tr -d '" \r' | head -1)" \
    || fail "could not re-read neo4j vector indexes after the reset before ${why}."
  [ "${remaining:-1}" = "0" ] \
    || fail "neo4j still carries ${remaining} vector index/indexes before ${why}; one of the other width would silently receive these vectors."

  wa_info "neo4j reset before ${why}: nodes deleted, every vector index dropped (the declared embedder width changes)"
}

# ---------------------------------------------------------------------------
# start_graphiti <tier>
#
# tier=generated-keyed : the env is whatever `buildGraphitiEnv` writes for a
#                keyed install (see load_generated_env) — the shape a real
#                configured install receives, booted rather than described.
#                `GRAPHITI_TIER_KEY` supplies the
#                credential — a real `OPENAI_API_KEY` when one exists (tier 2,
#                which then runs the full round trip against hosted embeddings),
#                and an obviously-fake one otherwise (tier 1c, boot + wiring
#                only, and it says so).
#
# tier=keyless : NO provider key. The LLM slot carries the SAME named sentinel
#                the bring-up hands over (scripts/gen-graphiti-env.mjs). It is not a
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
#                the shape `scripts/gen-graphiti-env.mjs` hands over for an
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
  # THE GENERATED TIER TAKES ITS WHOLE EMBEDDER + LLM WIRING FROM THE GENERATOR,
  # so it returns early rather than falling through to the hand-rolled block
  # below — a hand-rolled `-e` on the same variable would override exactly the
  # value under test.
  if [ "$tier" = "generated-keyed" ]; then
    load_generated_env openai
    docker run -d --name "$GR" --network "$NET" -p 127.0.0.1::8000 \
      -v "${REPO_ROOT}/docker/graphiti/config.yaml:/app/mcp/config/cinatra.yaml:ro" \
      -e CONFIG_PATH=/app/mcp/config/cinatra.yaml \
      -e DATABASE__PROVIDER=neo4j \
      -e DATABASE__PROVIDERS__NEO4J__URI="bolt://${NEO}:7687" \
      -e DATABASE__PROVIDERS__NEO4J__USERNAME=neo4j \
      -e DATABASE__PROVIDERS__NEO4J__PASSWORD="$NEO4J_PASSWORD" \
      "${GENERATED_ENV_ARGS[@]}" \
      -e SEMAPHORE_LIMIT=10 \
      "$GRAPHITI_IMAGE" >/dev/null
    wait_graphiti_healthy "$tier"
    # The generator must name the HOSTED embedder for a keyed install
    # (cinatra#2591 deliverable 3), and the width it declares must be that
    # endpoint's. Asserted against the RUNNING container, so a generator that
    # silently reverts to the local floor fails the arm rather than passing it.
    local emb_url emb_dim
    emb_url="$(docker exec "$GR" printenv EMBEDDER__PROVIDERS__OPENAI__API_URL || echo "")"
    emb_dim="$(docker exec "$GR" printenv EMBEDDER__DIMENSIONS || echo "")"
    case "$emb_url" in
      https://api.openai.com/*) ;;
      *) fail "generated keyed env points the embedder at '${emb_url}' — a keyed install must embed on the vendor it declares, not on the local 384-wide floor (cinatra#2591 deliverable 3)." ;;
    esac
    [ "$emb_dim" = "1536" ] \
      || fail "generated keyed env declares EMBEDDER__DIMENSIONS='${emb_dim}' against ${emb_url}; the declared width must be the width that endpoint serves."
    wa_info "generated keyed env verified IN THE CONTAINER: embedder ${emb_url} at ${emb_dim} dims"
    return 0
  fi
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

  wait_graphiti_healthy "$tier"
}

wait_graphiti_healthy() {
  local tier="$1"
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
# TIER 1c — THE GENERATOR'S OWN KEYED CONFIGURATION, BOOTED. No secret.
#
# Tiers 1 and 1b prove the substrate on configurations this script writes. This
# one proves the configuration a real KEYED install receives, which is a
# different thing: while no tier called `buildGraphitiEnv`, a generator that
# mis-wired the keyed branch passed the whole matrix. That is not theoretical —
# the keyed branch declared 1536-wide `text-embedding-3-small` while leaving the
# embedder URL at config.yaml's local 384-wide default, and every tier stayed
# green, because the one configuration an operator actually gets was the one
# configuration nothing booted.
#
# The key here is OBVIOUSLY FAKE, so this tier claims boot + wiring and nothing
# else — no round trip runs, and nothing is sent to any vendor. Tier 2 runs the
# same generated configuration with a real key and does the round trip.
# ---------------------------------------------------------------------------
wa_group_start "works-after graphiti tier 1c — the generator's keyed configuration boots (no secret)"
# THE FIRST 1536-WIDE TIER. Tiers 1 and 1b ranked at 384 on the local floor and
# left 384-wide vector indexes behind them, so the store is reset HERE — before
# the first server that declares the hosted width boots and rebuilds them — and
# not later. Tier 2 declares the same 1536 and inherits what this tier built,
# so it needs no reset of its own.
reset_neo4j "tier 1c (the first tier that declares the hosted 1536 width)"
GRAPHITI_TIER_KEY="sk-fake-works-after-wiring-proof-2591" start_graphiti generated-keyed
wa_info "tier 1c: boot + embedder wiring proven on buildGraphitiEnv's own output; the key is fake, so extraction and ranking are NOT claimed here"
wa_group_end

# ---------------------------------------------------------------------------
# TIER 2 — KEYED. Extraction, which only a real provider can prove — and now on
# the configuration the GENERATOR writes, not a hand-rolled one.
# ---------------------------------------------------------------------------
if [ "$RUN_KEYED" = "1" ]; then
  wa_group_start "works-after graphiti tier 2 — extraction on a real provider, on the generated env"
  # No reset here: tier 1c already dropped the 384-wide schema and let graphiti
  # rebuild it at 1536, which is the width this tier declares too. Nothing wrote
  # a vector in between.
  GRAPHITI_TIER_KEY="$WA_LANE_OPENAI_KEY" start_graphiti generated-keyed
  MARKER="WorksAfterMarker$(wa_throwaway_hexkey 6)"
  GRAPHITI_URL="$GRAPHITI_URL" WORKS_AFTER_MARKER="$MARKER" WORKS_AFTER_TIER="keyed" \
    WORKS_AFTER_DEADLINE_MS="${WORKS_AFTER_DEADLINE_MS:-120000}" \
    wa_node --conditions=react-server --import tsx "${REPO_ROOT}/scripts/ci/works-after/rt/graphiti-roundtrip.ts" \
    || fail "graphiti tier 2 (episode -> extraction -> searchable entity) failed."
  wa_group_end
  echo "${_WA_GREEN}==> works-after graphiti PASSED${_WA_RST} — tier 1 (substrate + local embedder + deterministic recovery), tier 1b (anthropic selection), tier 1c (the generator's keyed configuration boots) AND tier 2 (extraction + hosted-embedder ranking on that same generated configuration) all green."
else
  echo "${_WA_GREEN}==> works-after graphiti PASSED (tiers 1, 1b, 1c)${_WA_RST} — substrate + local embedder + deterministic recovery green, and the generator's keyed configuration BOOTS with its hosted-embedder wiring asserted in the container; extraction tier skipped (no key), so extraction and hosted-embedder RANKING are not claimed."
fi
