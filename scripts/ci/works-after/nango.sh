#!/usr/bin/env bash
set -euo pipefail
# works-after :: Nango arm (cinatra#352).
#
# Brings up a candidate nango-server (full NANGO_SERVER_IMAGE override — the
# design's R2 robustness kernel; default = the origin/main digest pin) with its
# nango-db (postgres:15-alpine) + a redis, all on an ISOLATED docker network,
# then runs the connection-store round-trip (rt/nango-roundtrip.ts): create a
# synthetic `unauthenticated` integration → import a synthetic connection →
# setMetadata → getConnection, asserting the metadata round-trips byte-equal.
# This exercises the server → records-DB store/read path + the @nangohq/node ↔
# nango-server API contract with a 100% synthetic, HERMETIC connection — NO ops
# secret, NO external OAuth, NO egress. (The AES-GCM credential envelope is out
# of scope for this secret-free arm — see the round-trip's header SCOPE note.)
#
# Throwaway crypto: NANGO_ENCRYPTION_KEY is minted per run (32 random bytes).
# The dev-environment secret key Nango seeds on first boot is read from the
# throwaway nango-db (its plaintext secret_key column) and passed to the SDK.
#
# SCOPE — nango-db data-survival is NOT this arm's job. This arm proves the
# nango-SERVER functional contract against a throwaway (fresh) nango-db at
# NANGO_DB_TAG; it does not prove nango-db's on-disk PGDATA survives a postgres
# MAJOR bump. That data-migration mechanism (dump/restore into a NEW volume +
# the same-volume bare-tag-bump refusal — docs/upgrade-track.md §3, which names
# the `nango-postgres` volume explicitly) is DATABASE-INSTANCE-AGNOSTIC and is
# proven generically by the postgres arm (scripts/ci/works-after/postgres.sh) —
# a nango-db postgres 15→16 bump is the same mechanism the postgres arm gates,
# so it is not duplicated here. NANGO_DB_TAG lets the lane pin the nango-db
# major when proving nango-server↔db compatibility.
#
# Env: NANGO_SERVER_IMAGE (default = the origin/main digest pin),
#      NANGO_DB_TAG (default 15-alpine), REDIS_TAG (default 7-alpine).

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

NANGO_SERVER_IMAGE="${NANGO_SERVER_IMAGE:-nangohq/nango-server:hosted@sha256:6f12853c192eab083175865a0427c1ea57a757a2d4d932ed8af46d6e3c002869}"
NANGO_DB_TAG="${NANGO_DB_TAG:-15-alpine}"
REDIS_TAG="${REDIS_TAG:-7-alpine}"
RUN_ID="wa-nango-$$"
NET="${RUN_ID}-net"
PG="${RUN_ID}-ndb"
REDIS="${RUN_ID}-redis"
NS="${RUN_ID}-nango"

cleanup() {
  docker rm -fv "$NS" "$REDIS" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
dump_diag() {
  wa_group_start "works-after nango failure diagnostics"
  echo "--- docker ps -a (run containers) ---"; docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- nango-server logs (carries the version banner) ---"; docker logs "$NS" 2>&1 | tail -50 || true
  echo "--- nango-db pg_isready ---"; docker exec "$PG" pg_isready -U nango 2>&1 | head -2 || true
  wa_group_end
}
on_err() { echo "${_WA_RED}ERROR: works-after nango FAILED (line $1).${_WA_RST}" >&2; dump_diag; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT
fail() { echo "${_WA_RED}ERROR: $*${_WA_RST}" >&2; dump_diag; exit 1; }

wa_log "works-after nango: candidate ${NANGO_SERVER_IMAGE%%@*}$([ "${NANGO_SERVER_IMAGE}" != "${NANGO_SERVER_IMAGE%%@*}" ] && echo ' (digest-pinned)')"

ENC_KEY="$(wa_throwaway_b64key)"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_DB=nango -e POSTGRES_USER=nango -e POSTGRES_PASSWORD=nango \
  "postgres:${NANGO_DB_TAG}" >/dev/null
docker run -d --name "$REDIS" --network "$NET" "redis:${REDIS_TAG}" >/dev/null
wa_wait_pg "$PG" nango 30 || fail "nango-db did not become ready within 60s."
wa_wait_redis "$REDIS" 15 || fail "nango redis did not become ready within 30s."

# Bring up nango-server. FLAG_AUTH_ENABLED=false disables the dashboard auth
# (NOT the API secret-key auth — the API still requires the seeded secret key).
# Loopback-only ephemeral host port so the host-side tsx round-trip can connect.
docker run -d --name "$NS" --network "$NET" -p 127.0.0.1::3003 \
  -e NANGO_ENCRYPTION_KEY="$ENC_KEY" \
  -e FLAG_AUTH_ENABLED=false \
  -e NANGO_DB_HOST="$PG" -e NANGO_DB_NAME=nango -e NANGO_DB_USER=nango -e NANGO_DB_PASSWORD=nango -e NANGO_DB_PORT=5432 \
  -e RECORDS_DATABASE_URL="postgresql://nango:nango@${PG}:5432/nango" \
  -e NANGO_REDIS_URL="redis://${REDIS}:6379" \
  -e NANGO_SERVER_URL="http://localhost:3003" -e SERVER_PORT=3003 \
  "$NANGO_SERVER_IMAGE" >/dev/null

# Wait for the server to answer /health AND for its first-boot migrations to
# seed the default dev environment (whose secret_key we then read).
HOST_PORT=""
for i in $(seq 1 60); do
  HOST_PORT="$(wa_host_port "$NS" 3003)"
  if [ -n "$HOST_PORT" ] && curl -fsS "http://127.0.0.1:${HOST_PORT}/health" >/dev/null 2>&1; then break; fi
  if [ "$i" -eq 60 ]; then fail "nango-server did not answer /health within 180s."; fi
  sleep 3
done
wa_info "nango-server up (host port ${HOST_PORT})"

# Read the seeded dev-environment secret key from the throwaway nango-db.
SECRET=""
for _ in $(seq 1 20); do
  SECRET="$(docker exec "$PG" psql -U nango -d nango -tA -c "SELECT secret_key FROM _nango_environments WHERE name='dev' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$SECRET" ] && break
  sleep 2
done
[ -n "$SECRET" ] || fail "could not read the seeded dev secret key from nango-db (migrations not complete?)."

NONCE="wa-$(date +%s)-${RANDOM}"
NANGO_SERVER_URL="http://127.0.0.1:${HOST_PORT}" NANGO_SECRET_KEY="$SECRET" WORKS_AFTER_NONCE="$NONCE" \
  wa_node --import tsx "${REPO_ROOT}/scripts/ci/works-after/rt/nango-roundtrip.ts" \
  || fail "nango connection-store round-trip failed (create→import→setMetadata→getConnection)."

echo "${_WA_GREEN}==> works-after nango PASSED${_WA_RST} — candidate nango-server round-tripped a synthetic connection through the records-DB store + get-connection API contract."
