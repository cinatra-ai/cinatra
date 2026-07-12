#!/usr/bin/env bash
set -euo pipefail
# works-after :: nango-db UPGRADE-FROM arm — the cinatra#1417 Case B fixture
# (nango Postgres 15 → 17, the PRE-BASELINE case-scoped matrix exception).
#
# NET-NEW under cinatra#1422 (the upgrade-from harness arm), developed as the
# COORDINATED PAIR with cinatra-cli#129's `cinatra instance db upgrade-major`:
# the sanctioned command executes the guarded logical dump→fresh-volume→restore
# transaction; THIS fixture proves that exact mechanism for the exact Case B
# transition, end to end, with REAL nango data — not a synthetic table:
#
#   1. MATRIX GATE — (nango-postgres, 15 → 17) must resolve as supported
#      through the canonical revision-checked matrix (it is the case-scoped
#      `nango-15-to-17` exception; the general nango baseline HOLDS at 17).
#   2. SEED — boot postgres 15 (digest-pinned source; the 2026-07-07 field
#      volume's major) on a NAMED volume at the LEGACY mount (Case B stays
#      legacy on BOTH sides — no pg18 layout move), then boot the pinned
#      nango-server against it: Nango runs its OWN boot migrations and seeds
#      its real schema; the connection round-trip then writes a synthetic
#      connection + metadata (a REAL records-DB row — the state cinatra#1417
#      exists to preserve: NO fresh-init/re-auth reset).
#   3. PERSISTENCE PROOF — recreate the pg container from the named volume
#      (the dump must come from data the volume actually carries).
#   4. GUARDED DUMP — in-container pg_dump -Fc (no shell pipe; the exit status
#      is the pipeline-failure detection), copied out, non-empty + sha256
#      recorded — the same verified-backup discipline as the CLI transaction.
#   5. NEGATIVE — postgres 17 on the SAME pg15 volume must REFUSE to start:
#      the LITERAL nango-postgres crash-loop observed on 2026-07-07.
#   6. RESTORE — a FRESH volume under postgres 17 (legacy mount), pg_restore
#      --exit-on-error. The fresh cluster's bootstrap env creates the single
#      `nango` role (the defined fresh-cluster-collision strategy for a stock
#      nango db: its one role comes from the bootstrap, so no globals replay
#      is needed — objects restore under the same owner).
#   7. WORKS-AFTER FUNCTIONAL ARM — nango-server boots against the RESTORED
#      17 cluster (running its own migrations first), answers /health, the
#      seeded environment secret reads back IDENTICAL, and the pre-migration
#      connection's metadata round-trips byte-equal through get-connection
#      (rt/nango-roundtrip.ts WORKS_AFTER_VERIFY_ONLY) — content read-backs
#      through the app, stronger than row counts.
#
# Hermetic: throwaway NANGO_ENCRYPTION_KEY (minted per run, reused across the
# migration exactly like a real deployment keeps its key), synthetic
# `unauthenticated` connection, no ops secret, no egress. Reproducible: the
# seed/quiesce/assert scripts are THIS file + the committed round-trip; the
# source image is digest-pinned; never a raw volume snapshot.
#
# Env: NANGO_SERVER_IMAGE  (default = the origin/main digest pin),
#      NANGO_DB_FROM_IMAGE (default = digest-pinned postgres:15-alpine — Case
#                           B's source major; the field fleet has no canonical
#                           source digest, so the FIXTURE pins its own
#                           reproducible one, resolved 2026-07-12),
#      NANGO_DB_TO_IMAGE   (default = the matrix's canonical 17-alpine pin),
#      REDIS_TAG           (default 8-alpine).

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

NANGO_SERVER_IMAGE="${NANGO_SERVER_IMAGE:-nangohq/nango-server:hosted@sha256:6f12853c192eab083175865a0427c1ea57a757a2d4d932ed8af46d6e3c002869}"
NANGO_DB_FROM_IMAGE="${NANGO_DB_FROM_IMAGE:-postgres:15-alpine@sha256:3d0f7584ed7d04e27fa050d6683a74746608faf21f202be78460d679cc56461f}"
NANGO_DB_TO_IMAGE="${NANGO_DB_TO_IMAGE:-postgres:17-alpine@sha256:979c4379dd698aba0b890599a6104e082035f98ef31d9b9291ec22f2b13059ca}"
REDIS_TAG="${REDIS_TAG:-8-alpine}"

RUN_ID="wa-ndbup-$$"
NET="${RUN_ID}-net"
PG15="${RUN_ID}-pg15"
PG17="${RUN_ID}-pg17"
NEG="${RUN_ID}-neg"
REDIS="${RUN_ID}-redis"
NS="${RUN_ID}-nango"
VOL15="${RUN_ID}-vol15"
VOL17="${RUN_ID}-vol17"
# Case B stays LEGACY on both sides: sources <=17 mount .../data (a parent
# mount would be shadowed by the image-declared anonymous volume — false
# green), and the 17 target keeps the legacy mount too (no pg18 layout move).
LEGACY_MOUNT=/var/lib/postgresql/data
DUMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/${RUN_ID}.XXXXXX")"

cleanup() {
  docker rm -fv "$NS" "$REDIS" "$PG15" "$PG17" "$NEG" >/dev/null 2>&1 || true
  docker volume rm "$VOL15" "$VOL17" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$DUMP_DIR" >/dev/null 2>&1 || true
}
dump_diag() {
  wa_group_start "works-after nango-db-upgrade failure diagnostics"
  echo "--- docker ps -a (run containers) ---"; docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- nango-server logs ---"; docker logs "$NS" 2>&1 | tail -50 || true
  echo "--- pg15 logs ---"; docker logs "$PG15" 2>&1 | tail -30 || true
  echo "--- pg17 logs ---"; docker logs "$PG17" 2>&1 | tail -30 || true
  echo "--- negative pg logs ---"; docker logs "$NEG" 2>&1 | tail -30 || true
  wa_group_end
}
on_err() { echo "${_WA_RED}ERROR: works-after nango-db-upgrade FAILED (line $1).${_WA_RST}" >&2; dump_diag; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT
fail() { echo "${_WA_RED}ERROR: $*${_WA_RST}" >&2; dump_diag; exit 1; }

# ── 1. Matrix gate ────────────────────────────────────────────────────────────
MATRIX_VERDICT="$(wa_node "${WORKS_AFTER_LIB_DIR}/resolve-transition.mjs" nango-postgres 15 17)" || {
  echo "${_WA_RED}ERROR: matrix gate REFUSED (nango-postgres: 15 -> 17) — the case-scoped exception is gone from docs/architecture/upgrade-matrix.json.${_WA_RST}" >&2
  echo "  ${MATRIX_VERDICT:-<no verdict>}" >&2
  exit 1
}
wa_log "works-after nango-db-upgrade: cinatra#1417 Case B (nango pg 15 → 17, case-scoped)"
wa_info "matrix gate OK: ${MATRIX_VERDICT}"
wa_info "source: ${NANGO_DB_FROM_IMAGE}"
wa_info "target: ${NANGO_DB_TO_IMAGE}"

read_secret() { # $1 = pg container — the seeded dev-environment secret key
  docker exec "$1" psql -U nango -d nango -tA -c "SELECT secret_key FROM _nango_environments WHERE name='dev' LIMIT 1;" 2>/dev/null | tr -d '[:space:]'
}
wait_nango() { # wait for /health on the CURRENT $NS container; sets HOST_PORT
  HOST_PORT=""
  local i
  for i in $(seq 1 60); do
    HOST_PORT="$(wa_host_port "$NS" 3003)"
    if [ -n "$HOST_PORT" ] && curl -fsS "http://127.0.0.1:${HOST_PORT}/health" >/dev/null 2>&1; then return 0; fi
    if [ "$i" -eq 60 ]; then return 1; fi
    sleep 3
  done
}
start_nango() { # $1 = the nango-db container to point at
  docker run -d --name "$NS" --network "$NET" -p 127.0.0.1::3003 \
    -e NANGO_ENCRYPTION_KEY="$ENC_KEY" \
    -e FLAG_AUTH_ENABLED=false \
    -e NANGO_DB_HOST="$1" -e NANGO_DB_NAME=nango -e NANGO_DB_USER=nango -e NANGO_DB_PASSWORD=nango -e NANGO_DB_PORT=5432 \
    -e RECORDS_DATABASE_URL="postgresql://nango:nango@$1:5432/nango" \
    -e NANGO_REDIS_URL="redis://${REDIS}:6379" \
    -e NANGO_SERVER_URL="http://localhost:3003" -e SERVER_PORT=3003 \
    "$NANGO_SERVER_IMAGE" >/dev/null
}

# ── 2. Seed: pg15 on a NAMED legacy-mounted volume + real nango schema/data ──
ENC_KEY="$(wa_throwaway_b64key)"
docker network create "$NET" >/dev/null
docker volume create "$VOL15" >/dev/null
docker volume create "$VOL17" >/dev/null
docker run -d --name "$PG15" --network "$NET" \
  -v "${VOL15}:${LEGACY_MOUNT}" \
  -e POSTGRES_DB=nango -e POSTGRES_USER=nango -e POSTGRES_PASSWORD=nango \
  "$NANGO_DB_FROM_IMAGE" >/dev/null
docker run -d --name "$REDIS" --network "$NET" "redis:${REDIS_TAG}" >/dev/null
wa_wait_pg "$PG15" nango 30 || fail "pg15 source did not become ready within 60s."
wa_wait_redis "$REDIS" 15 || fail "redis did not become ready within 30s."

start_nango "$PG15"
wait_nango || fail "nango-server did not answer /health against the pg15 source within 180s."
wa_info "nango-server up against pg15 (host port ${HOST_PORT}) — Nango's own migrations have seeded the real schema"

SECRET_BEFORE=""
for _ in $(seq 1 20); do
  SECRET_BEFORE="$(read_secret "$PG15")"
  [ -n "$SECRET_BEFORE" ] && break
  sleep 2
done
[ -n "$SECRET_BEFORE" ] || fail "could not read the seeded dev secret key from the pg15 nango-db."

CONNECTION_ID="wa-ndbup-15to17-$$"
NONCE="wa-ndbup-$(date +%s)-${RANDOM}"
NANGO_SERVER_URL="http://127.0.0.1:${HOST_PORT}" NANGO_SECRET_KEY="$SECRET_BEFORE" \
  WORKS_AFTER_NONCE="$NONCE" WORKS_AFTER_CONNECTION_ID="$CONNECTION_ID" \
  wa_node --import tsx "${REPO_ROOT}/scripts/ci/works-after/rt/nango-roundtrip.ts" \
  || fail "seeding the synthetic connection on the pg15 source failed."
wa_info "seeded connection '${CONNECTION_ID}' with metadata nonce on pg15"

# ── 3. Quiesce + persistence proof ────────────────────────────────────────────
docker rm -f "$NS" >/dev/null 2>&1 || true
docker rm -f "$PG15" >/dev/null 2>&1 || true
docker run -d --name "$PG15" --network "$NET" \
  -v "${VOL15}:${LEGACY_MOUNT}" \
  -e POSTGRES_DB=nango -e POSTGRES_USER=nango -e POSTGRES_PASSWORD=nango \
  "$NANGO_DB_FROM_IMAGE" >/dev/null
wa_wait_pg "$PG15" nango 30 || fail "pg15 did not come back up from its named volume — the volume does not carry the cluster."
ROWS="$(docker exec "$PG15" psql -U nango -d nango -tA -c "SELECT count(*) FROM _nango_connections WHERE connection_id='${CONNECTION_ID}';")"
[ "${ROWS:-0}" -eq 1 ] || fail "the seeded connection did not persist across a recreate from the named volume (got '${ROWS}')."
wa_info "persistence proof OK — the named pg15 volume carries the seeded nango data"

# ── 4. Guarded dump (verified backup) ────────────────────────────────────────
docker exec "$PG15" pg_dump -U nango -Fc -d nango -f /tmp/nango.pgc \
  || fail "pg_dump of the pg15 nango database failed."
docker cp "${PG15}:/tmp/nango.pgc" "${DUMP_DIR}/nango.pgc" || fail "could not copy the dump out."
[ -s "${DUMP_DIR}/nango.pgc" ] || fail "nango dump is empty."
DUMP_SHA="$(wa_node -e 'const{createHash}=require("crypto");const{readFileSync}=require("fs");process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "${DUMP_DIR}/nango.pgc")"
wa_info "dump verified: $(wc -c < "${DUMP_DIR}/nango.pgc" | tr -d ' ') bytes, sha256 ${DUMP_SHA}"
docker rm -f "$PG15" >/dev/null 2>&1 || true

# ── 5. NEGATIVE — pg17 on the SAME pg15 volume must REFUSE (the 1417 crash) ──
docker run -d --name "$NEG" --network "$NET" \
  -v "${VOL15}:${LEGACY_MOUNT}" \
  -e POSTGRES_DB=nango -e POSTGRES_USER=nango -e POSTGRES_PASSWORD=nango \
  "$NANGO_DB_TO_IMAGE" >/dev/null
REFUSED=0
for _ in $(seq 1 15); do
  RUNNING="$(docker inspect -f '{{.State.Running}}' "$NEG" 2>/dev/null || echo unknown)"
  if [ "$RUNNING" = "false" ]; then REFUSED=1; break; fi
  sleep 1
done
NEG_LOGS="$(docker logs "$NEG" 2>&1 | tail -40)"
if [ "$REFUSED" -ne 1 ]; then
  echo "--- negative pg logs:"; printf '%s\n' "$NEG_LOGS"
  fail "postgres 17 did NOT refuse the pg15 nango volume — the exact cinatra#1417 nango crash-loop class must reproduce as a refusal."
fi
printf '%s' "$NEG_LOGS" | grep -qiE 'incompatible with server|database files are incompatible|was initialized using|incompatible' \
  || { echo "--- negative pg logs:"; printf '%s\n' "$NEG_LOGS"; fail "pg17 stopped on the pg15 volume but without the documented incompatibility message."; }
docker rm -f "$NEG" >/dev/null 2>&1 || true
wa_info "NEGATIVE OK — pg17 refused the pg15 on-disk data (the observed 2026-07-07 nango-postgres failure class)"

# ── 6. Restore into a FRESH 17 volume (legacy mount — no layout move) ────────
docker run -d --name "$PG17" --network "$NET" \
  -v "${VOL17}:${LEGACY_MOUNT}" \
  -e POSTGRES_DB=nango -e POSTGRES_USER=nango -e POSTGRES_PASSWORD=nango \
  "$NANGO_DB_TO_IMAGE" >/dev/null
wa_wait_pg "$PG17" nango 45 || fail "pg17 target did not become ready within 90s."
docker cp "${DUMP_DIR}/nango.pgc" "${PG17}:/tmp/nango.pgc" || fail "could not copy the dump into the pg17 target."
# The fresh cluster's bootstrap env already created the single `nango` role a
# stock nango db uses (the defined collision strategy — no globals replay
# needed); restoring as that same role keeps ownership identical.
docker exec "$PG17" pg_restore -U nango -d nango --exit-on-error /tmp/nango.pgc \
  || fail "pg_restore of the nango dump into the fresh 17 volume failed."
wa_info "restored into the fresh 17 volume (pg_restore --exit-on-error)"

# ── 7. Works-after functional arm on the RESTORED cluster ────────────────────
SECRET_AFTER="$(read_secret "$PG17")"
[ -n "$SECRET_AFTER" ] || fail "could not read the dev secret key from the RESTORED 17 cluster."
[ "$SECRET_AFTER" = "$SECRET_BEFORE" ] || fail "the seeded environment secret did not survive the migration byte-identical."

start_nango "$PG17"
wait_nango || fail "nango-server did not answer /health against the RESTORED 17 cluster within 180s (its own boot migrations must succeed on restored data)."
wa_info "nango-server up against the restored 17 cluster (host port ${HOST_PORT})"

NANGO_SERVER_URL="http://127.0.0.1:${HOST_PORT}" NANGO_SECRET_KEY="$SECRET_AFTER" \
  WORKS_AFTER_NONCE="$NONCE" WORKS_AFTER_CONNECTION_ID="$CONNECTION_ID" WORKS_AFTER_VERIFY_ONLY=1 \
  wa_node --import tsx "${REPO_ROOT}/scripts/ci/works-after/rt/nango-roundtrip.ts" \
  || fail "post-migration read-back failed — the pre-migration connection's metadata must round-trip through get-connection on the restored 17 cluster."

echo "${_WA_GREEN}==> works-after nango-db-upgrade PASSED${_WA_RST} — nango pg 15→17 (case-scoped): dump/restore into a fresh legacy-mounted 17 volume preserved the real nango records (connection metadata + environment secret byte-identical; nango-server boots and serves them); the same-volume bare bump refused."
