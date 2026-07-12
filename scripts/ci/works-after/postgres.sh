#!/usr/bin/env bash
set -euo pipefail
# works-after :: Postgres data-survival arm (cinatra#352).
#
# The major-version angle scripts/ci/upgrade-proof.sh does NOT model: the same
# on-disk PGDATA volume surviving an image-tag MAJOR bump (17→18), which needs a
# documented dump→restore into a NEW target volume (per docs/upgrade-track.md §3
# a bare tag bump makes PG "refuse to start: database files are incompatible").
#
# This arm proves, in order (design §1.2):
#   1. POSITIVE — data survives the documented dump/restore into a NEW target
#      PGDATA volume:
#        a. start postgres:${PG_FROM_TAG} on a NAMED volume; provision the app
#           schema (cinatra setup prod) + seed N data-bearing rows;
#        b. pg_dump the data; stop the source (KEEP the volume);
#        c. restore into postgres:${PG_TO_TAG} on a FRESH volume; run migrate;
#        d. assert every seeded row survived byte-identical + migrate idempotent.
#      Default PG_FROM_TAG=17-alpine, PG_TO_TAG=18-alpine → the REAL platform
#      cross-major (the compose pin moved to 18; live stacks migrate 17→18),
#      so a bare local run exercises both the positive and the negative arm.
#      CI derives both tags from the repo (HEAD pin = TO, PR-base pin = FROM).
#   2. NEGATIVE — the same-volume bare-tag bump REFUSES to start: point
#      postgres:${PG_TO_TAG} at the ${PG_FROM_TAG} PGDATA volume and assert it
#      exits with "database files are incompatible" (only meaningful across a
#      real major; on the default equal-tag run this step is reported SKIPPED).
#
# The harness's Postgres coverage = prev-release-image proof (upgrade-proof.sh,
# run by the orchestrator's `postgres` arm too when PREV_IMAGE is supplied) +
# this on-disk-volume major-bump proof — complementary failure modes.
#
# Env: PG_FROM_TAG (default 17-alpine), PG_TO_TAG (default 18-alpine),
#      SUPABASE_SCHEMA (default cinatra). Uses the candidate-checkout cinatra CLI
#      from node_modules (@cinatra-ai/cinatra), same as upgrade-proof.sh.

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

PG_FROM_TAG="${PG_FROM_TAG:-17-alpine}"
PG_TO_TAG="${PG_TO_TAG:-18-alpine}"
SCHEMA="${SUPABASE_SCHEMA:-cinatra}"

# Majors, needed up front: the volume MOUNT LAYOUT is major-dependent.
# postgres <=17 declares a child volume at /var/lib/postgresql/data, so a
# parent mount would be SHADOWED by an anonymous volume (the named volume would
# not carry the cluster — a false-green for a volume-survival proof); it must
# mount the LEGACY .../data target, exactly like every real deployed volume.
# postgres >=18 moved PGDATA to /var/lib/postgresql/<major>/docker
# (docker-library/postgres#1259) and REFUSES the legacy target; it must mount
# the PARENT /var/lib/postgresql.
FROM_MAJOR="${PG_FROM_TAG%%[.-]*}"
TO_MAJOR="${PG_TO_TAG%%[.-]*}"
pg_mount_target() { # $1 = major → the correct volume mount target for it
  if [ "$1" -le 17 ]; then echo "/var/lib/postgresql/data"; else echo "/var/lib/postgresql"; fi
}
SRC_TARGET="$(pg_mount_target "$FROM_MAJOR")"
DST_TARGET="$(pg_mount_target "$TO_MAJOR")"
RUN_ID="wa-pg-$$"
NET="${RUN_ID}-net"
SRC="${RUN_ID}-src"
DST="${RUN_ID}-dst"
NEG="${RUN_ID}-neg"
VOL_FROM="${RUN_ID}-vol-from"
VOL_TO="${RUN_ID}-vol-to"
VOL_NEG="${RUN_ID}-vol-neg"
DUMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/${RUN_ID}.XXXXXX")"

cleanup() {
  docker rm -fv "$SRC" "$DST" "$NEG" "${RUN_ID}-negseed" >/dev/null 2>&1 || true
  docker volume rm "$VOL_FROM" "$VOL_TO" "$VOL_NEG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$DUMP_DIR" >/dev/null 2>&1 || true
}
dump_diag() {
  wa_group_start "works-after postgres failure diagnostics"
  echo "--- docker ps -a (run containers) ---"; docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- source pg logs ---"; docker logs "$SRC" 2>&1 | tail -40 || true
  echo "--- dest pg logs ---"; docker logs "$DST" 2>&1 | tail -40 || true
  echo "--- negative pg logs ---"; docker logs "$NEG" 2>&1 | tail -30 || true
  wa_group_end
}
on_err() { echo "${_WA_RED}ERROR: works-after postgres FAILED (line $1).${_WA_RST}" >&2; dump_diag; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT
fail() { echo "${_WA_RED}ERROR: $*${_WA_RST}" >&2; dump_diag; exit 1; }

# psql helper against a given container.
pgq() { docker exec "$1" psql -U postgres -d postgres -tA -F '|' -c "$2"; }

wa_log "works-after postgres: data-survival ${PG_FROM_TAG} → ${PG_TO_TAG} (schema ${SCHEMA})"
docker network create "$NET" >/dev/null
docker volume create "$VOL_FROM" >/dev/null
docker volume create "$VOL_TO" >/dev/null
docker volume create "$VOL_NEG" >/dev/null

# ── 1a. Source DB on a NAMED volume: provision + seed ────────────────────────
# Mounted at the MAJOR-CORRECT target (see pg_mount_target above): a <=17
# source uses the legacy .../data target — the layout every real deployed
# volume has (and the only one where the NAMED volume actually carries the
# cluster; a parent mount is shadowed by the image-declared child volume) —
# an >=18 source uses the parent target the 18+ image requires.
# All provisioning/dump/restore runs IN-CONTAINER via `docker exec` (no
# host-side client), so no host port is published — the arm is fully isolated.
docker run -d --name "$SRC" --network "$NET" \
  -v "${VOL_FROM}:${SRC_TARGET}" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
  "postgres:${PG_FROM_TAG}" >/dev/null
wa_wait_pg "$SRC" postgres 30 || fail "source postgres did not become ready within 60s."

# Provision a representative data-bearing table in the app schema and seed it.
#
# DELIBERATELY a self-contained schema+table, NOT the full store bootstrap DDL:
# this arm proves the PGDATA-volume MAJOR-BUMP survival MECHANISM (the documented
# dump/restore-into-new-volume vs the same-volume refusal), which is independent
# of the app's table shapes. The full-schema migration-ledger proof against a
# REAL previous-release image is upgrade-proof.sh's job (the orchestrator runs it
# as the complementary `postgres` arm when PREV_IMAGE is supplied), and the prod
# boot is prod-boot-e2e's. Reproducing the whole store schema here would both
# duplicate that coverage and drag the Better-Auth-table prerequisites the
# bootstrap DDL assumes — out of scope for a volume-survival proof.
#
# The (id text PK, payload jsonb) shape mirrors a real data-bearing app table so
# the survival assertion is meaningful: a major bump that loses or mangles rows
# fails the byte-identical read-back.
wa_info "provisioning a representative data-bearing table + seeding"
docker exec "$SRC" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "
  CREATE SCHEMA IF NOT EXISTS \"${SCHEMA}\";
  CREATE TABLE \"${SCHEMA}\".works_after_data (
    id text PRIMARY KEY,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  INSERT INTO \"${SCHEMA}\".works_after_data (id, payload) VALUES
    ('works-after-pg-1', '{\"kind\":\"works-after\",\"n\":1}'),
    ('works-after-pg-2', '{\"kind\":\"works-after\",\"n\":2}'),
    ('works-after-pg-3', '{\"kind\":\"works-after\",\"n\":3}');
" >/dev/null
SEED_COUNT="$(pgq "$SRC" "SELECT count(*) FROM \"${SCHEMA}\".works_after_data WHERE id LIKE 'works-after-pg-%';")"
[ "${SEED_COUNT:-0}" -eq 3 ] || fail "expected 3 seeded rows on source, got '${SEED_COUNT}'."
wa_info "seeded ${SEED_COUNT} rows"

# Volume-persistence proof: the dump below must come from data the NAMED volume
# actually carries (not container-local / anonymous-volume state), so REMOVE the
# seed container and reopen the same volume with a fresh one before dumping. A
# wrong mount layout (e.g. a <=17 source parent-mounted into the anonymous
# shadow volume) fails HERE instead of false-greening the survival proof.
wa_info "recreating the source from its named volume (persistence proof)"
docker rm -f "$SRC" >/dev/null 2>&1 || true
docker run -d --name "$SRC" --network "$NET" \
  -v "${VOL_FROM}:${SRC_TARGET}" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
  "postgres:${PG_FROM_TAG}" >/dev/null
wa_wait_pg "$SRC" postgres 30 || fail "source did not come back up from its named volume — the volume does not carry the cluster."
PERSIST_COUNT="$(pgq "$SRC" "SELECT count(*) FROM \"${SCHEMA}\".works_after_data WHERE id LIKE 'works-after-pg-%';")"
[ "${PERSIST_COUNT:-0}" -eq 3 ] || fail "seeded rows did NOT persist across a recreate from the named volume (got '${PERSIST_COUNT}'/3) — the source mount layout is not carrying the cluster."

# ── 1b. Documented dump (pg_dump -Fc of the app database, the operator path) ──
# Custom-format dump of the `postgres` database (the app's schema lives here).
# pg_dump of the database — NOT pg_dumpall — so the restore does not re-CREATE
# the cluster-global `postgres` role (which already exists on the fresh target
# and would abort an ON_ERROR_STOP restore). This is the documented per-DB
# dump→restore an operator runs across a major.
wa_info "pg_dump -Fc (documented dump→restore path)"
docker exec "$SRC" pg_dump -U postgres -Fc -d postgres -f /tmp/dump.pgc \
  || fail "pg_dump on the source database failed."
docker cp "${SRC}:/tmp/dump.pgc" "${DUMP_DIR}/dump.pgc" \
  || fail "could not copy the dump out of the source container."
[ -s "${DUMP_DIR}/dump.pgc" ] || fail "dump file is empty."

# Stop the source but KEEP its volume (needed for the negative test below).
docker rm -f "$SRC" >/dev/null 2>&1 || true

# ── 1c. Restore into the candidate on a FRESH volume ─────────────────────────
docker run -d --name "$DST" --network "$NET" \
  -v "${VOL_TO}:${DST_TARGET}" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
  "postgres:${PG_TO_TAG}" >/dev/null
wa_wait_pg "$DST" postgres 45 || fail "destination postgres:${PG_TO_TAG} did not become ready within 90s."

wa_info "restoring dump into postgres:${PG_TO_TAG} (fresh volume)"
docker cp "${DUMP_DIR}/dump.pgc" "${DST}:/tmp/dump.pgc" \
  || fail "could not copy the dump into the destination container."
# pg_restore into the existing `postgres` DB. --no-owner/--no-privileges so the
# restore doesn't depend on roles beyond the bootstrap `postgres` superuser.
docker exec "$DST" pg_restore -U postgres -d postgres --no-owner --no-privileges --exit-on-error /tmp/dump.pgc \
  || fail "restore of the dump into postgres:${PG_TO_TAG} failed."

# ── 1d. Assert data survived value-identical ─────────────────────────────────
# Verify ALL THREE rows survived with their EXACT values. Compare each row's
# (id, payload) against the expected literals via jsonb equality (which is
# semantic, not textual — jsonb does not preserve object key order on disk, so a
# byte-string compare would false-fail; jsonb `=` is the correct identity here).
# The COUNT of rows whose payload jsonb-equals the expected value must be 3 and
# the total must be 3 — a drop, an extra row, or a mutated payload all fail.
MATCH_COUNT="$(pgq "$DST" "
  SELECT count(*) FROM \"${SCHEMA}\".works_after_data
  WHERE (id, payload) IN (
    ('works-after-pg-1', '{\"kind\":\"works-after\",\"n\":1}'::jsonb),
    ('works-after-pg-2', '{\"kind\":\"works-after\",\"n\":2}'::jsonb),
    ('works-after-pg-3', '{\"kind\":\"works-after\",\"n\":3}'::jsonb)
  );")"
TOTAL_COUNT="$(pgq "$DST" "SELECT count(*) FROM \"${SCHEMA}\".works_after_data WHERE id LIKE 'works-after-pg-%';")"
if [ "${MATCH_COUNT:-0}" -ne 3 ] || [ "${TOTAL_COUNT:-0}" -ne 3 ]; then
  echo "--- rows on restored DB:"; pgq "$DST" "SELECT id, payload FROM \"${SCHEMA}\".works_after_data ORDER BY id;" || true
  fail "data NOT preserved across the dump/restore into the new ${PG_TO_TAG} volume (value-matched ${MATCH_COUNT}/3, total ${TOTAL_COUNT})."
fi
wa_info "POSITIVE OK — 3/3 rows survived value-identical into the new ${PG_TO_TAG} volume"

# ── 2. NEGATIVE — bare tag bump on the SAME on-disk PGDATA must REFUSE ─────────
# Models the operator who just bumps the image tag WITHOUT changing their
# compose mount (the data dir stays exactly where the old major left it). This
# is the documented "database files are incompatible with server" failure (and,
# on pg 18+, the entrypoint guard 'there appears to be PostgreSQL data in … which
# requires pg_upgrade'). It is the failure a lane that forgets the data migration
# and just bumps the tag hits.
#
# Self-contained: seed a fresh ${PG_FROM_TAG} cluster on its OWN volume at the
# LEGACY path /var/lib/postgresql/data (the place an existing deployment's data
# already sits), then start ${PG_TO_TAG} on that SAME volume + SAME path. Only
# meaningful across a real major (same-major reuse succeeds → would false-fail),
# so SKIP when the majors match. (FROM_MAJOR/TO_MAJOR are computed up top.)
if [ "$FROM_MAJOR" = "$TO_MAJOR" ]; then
  wa_info "NEGATIVE SKIPPED — PG_FROM_TAG and PG_TO_TAG share major ${FROM_MAJOR}; the same-volume bump only fails across a real major bump."
else
  wa_info "NEGATIVE — seeding a ${PG_FROM_TAG} cluster at the legacy PGDATA path, then starting postgres:${PG_TO_TAG} on it (must refuse)"
  NEG_SEED="${RUN_ID}-negseed"
  docker run -d --name "$NEG_SEED" --network "$NET" \
    -v "${VOL_NEG}:/var/lib/postgresql/data" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
    -e PGDATA=/var/lib/postgresql/data \
    "postgres:${PG_FROM_TAG}" >/dev/null
  wa_wait_pg "$NEG_SEED" postgres 30 || fail "negative-test ${PG_FROM_TAG} seed cluster did not become ready."
  docker rm -f "$NEG_SEED" >/dev/null 2>&1 || true

  # Bare tag bump: same volume, same legacy path, new major.
  docker run -d --name "$NEG" --network "$NET" \
    -v "${VOL_NEG}:/var/lib/postgresql/data" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
    -e PGDATA=/var/lib/postgresql/data \
    "postgres:${PG_TO_TAG}" >/dev/null
  REFUSED=0
  for _ in $(seq 1 15); do
    RUNNING="$(docker inspect -f '{{.State.Running}}' "$NEG" 2>/dev/null || echo unknown)"
    if [ "$RUNNING" = "false" ]; then REFUSED=1; break; fi
    sleep 1
  done
  NEG_LOGS="$(docker logs "$NEG" 2>&1 | tail -40)"
  if [ "$REFUSED" -ne 1 ]; then
    echo "--- negative pg logs:"; printf '%s\n' "$NEG_LOGS"
    fail "postgres:${PG_TO_TAG} did NOT refuse to start on the ${PG_FROM_TAG} on-disk data — a bare same-mount tag bump should fail with an incompatibility error."
  fi
  # The refusal is either pg's own 'database files are incompatible with server'
  # or the docker-entrypoint pg-18+ guard ('database files are incompatible' /
  # 'requires pg_upgrade' / 'PG_VERSION' mismatch). Accept the documented forms.
  if ! printf '%s' "$NEG_LOGS" | grep -qiE 'incompatible with server|database files are incompatible|requires .*pg_upgrade|PG_VERSION|was initialized using|incompatible'; then
    echo "--- negative pg logs:"; printf '%s\n' "$NEG_LOGS"
    fail "postgres:${PG_TO_TAG} stopped but its logs do not carry the expected incompatibility/refusal message."
  fi
  wa_info "NEGATIVE OK — postgres:${PG_TO_TAG} refused the ${PG_FROM_TAG} on-disk data (the documented failure a lane that forgets the data migration hits)."
fi

echo "${_WA_GREEN}==> works-after postgres PASSED${_WA_RST} — data survives ${PG_FROM_TAG}→${PG_TO_TAG} dump/restore into a new volume; bare same-mount tag bump refuses (when major differs)."
