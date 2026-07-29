#!/usr/bin/env bash
set -euo pipefail
# works-after :: Postgres UPGRADE-FROM arm (cinatra#1422, epic cinatra#1419).
#
# The data-bearing prior-version fixture for the Postgres family's guarded
# major-upgrade path (scripts/upgrade/postgres-upgrade-major.sh), landed as the
# coordinated pair of that path (and of the CLI command cinatra-cli#129). One run
# proves BOTH concrete cinatra#1417 transitions end to end on real docker:
#
#   Case A — platform-postgres 17 -> 18 (the SUPPORTED BASELINE; the pg18
#            mount-layout MOVE, legacy .../data -> parent). Carries the full
#            battery: matrix negatives, quiesce stop, fixture, failure-injection
#            rollback, positive, interrupted.
#   Case B — nango-postgres 15 -> 17 (the case-scoped exception; skips 16 in one
#            logical dump/restore hop; legacy mount on BOTH sides). Own
#            end-to-end positive proof.
#
# The scripts/ci/works-after/postgres.sh arm proves the raw dump/restore-into-
# a-new-volume survival MECHANISM + the same-mount bare-bump refusal; THIS arm
# proves the GUARDED TRANSACTION around it (ledger begin/commit/rollback, failure
# injection at each step, the intact-source rollback, the fail-closed interrupted
# state) for the exact matrix-supported transitions.
#
# It proves, in order:
#   0. NEGATIVES (matrix, no containers): a downgrade (18 -> 17) and an
#      unsupported hop (nango 17 -> 18) FAIL CLOSED; both supported hops resolve.
#   1. QUIESCE STOP: the path refuses (exit 3, no ledger touch) while a container
#      still references the volume.
#   2. FIXTURE: a pg17 volume with a seeded, checksum-verifiable table,
#      ledger-recorded at the source version.
#   3. FAILURE INJECTION (pre-commit): UPGRADE_INJECT_FAILURE=post-verify must
#      exit 5 and land back on the INTACT source volume WITH the source-version
#      ledger entry intact (rows equal under the SOURCE image; no pending
#      journal; no leaked candidate/target volume).
#   4. POSITIVE (Case A): the same fixture upgrades 17 -> 18; ledger commits; data
#      survives value-identical on 18; the checksummed dump artifact exists.
#   5. INTERRUPTED (post-commit): on a second fixture,
#      UPGRADE_INJECT_FAILURE=cutover-verify must exit 4, RETAIN the pending
#      journal (live entry still the SOURCE) and the target volume.
#   6. CASE B (nango 15 -> 17): a third fixture runs the case-scoped exception end
#      to end (positive; skipped major, legacy mount both sides).
#
# Env: PG_CASEA_FROM_TAG (default 17-alpine), PG_CASEA_TO_TAG (default the matrix
# platform-postgres pin, DIGEST-BOUND), PG_CASEB_FROM_TAG (default 15-alpine),
# PG_CASEB_TO_TAG (default the matrix nango-postgres pin, DIGEST-BOUND) — so a
# bare run exercises the REAL supported transitions on the matrix's exact target
# bytes. Field pg SOURCES have no single canonical digest (cinatra#1417), so the
# source tags are bare majors. Fully isolated: named throwaway volumes, no host
# ports, local trust auth (no password crosses argv/env).

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

# Case A target is DIGEST-BOUND (the platform-postgres matrix pin); Case B target
# is the nango-postgres matrix pin — the compose nango-db DELIBERATE 17-alpine
# HOLD (docker-compose.yml pins this exact digest), so Case B proves the 15 -> 17
# exception onto the bytes the hold actually ships. Sources are bare majors (no
# canonical field digest — cinatra#1417).
PG_CASEA_FROM_TAG="${PG_CASEA_FROM_TAG:-17-alpine}"
PG_CASEA_TO_TAG="${PG_CASEA_TO_TAG:-18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15}"
PG_CASEB_FROM_TAG="${PG_CASEB_FROM_TAG:-15-alpine}"
PG_CASEB_TO_TAG="${PG_CASEB_TO_TAG:-17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193}"

RUN_ID="wa-upgpg-$$"
SEED="${RUN_ID}-seed"
CHK="${RUN_ID}-chk"
HOLD="${RUN_ID}-hold"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/${RUN_ID}.XXXXXX")"
BACKUPS="${WORK}/backups"
PATH_SH="${REPO_ROOT}/scripts/upgrade/postgres-upgrade-major.sh"
RESOLVE="${REPO_ROOT}/scripts/upgrade/resolve-transition.mjs"
LEDGER_MJS="${REPO_ROOT}/scripts/upgrade/ledger.mjs"

cleanup() {
  docker rm -f "$SEED" "$CHK" "$HOLD" >/dev/null 2>&1 || true
  for v in $(docker volume ls -q --filter "name=${RUN_ID}" 2>/dev/null); do
    docker volume rm -f "$v" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK" >/dev/null 2>&1 || true
}
dump_diag() {
  wa_group_start "works-after upgrade-postgres failure diagnostics"
  echo "--- docker ps -a (run containers) ---"; docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- volumes ---"; docker volume ls --filter "name=${RUN_ID}" || true
  echo "--- ledgers ---"; for f in "$WORK"/ledger*.json; do echo "== $f =="; cat "$f" 2>/dev/null || true; done
  wa_group_end
}
on_err() { echo "${_WA_RED}ERROR: works-after upgrade-postgres FAILED (line $1).${_WA_RST}" >&2; dump_diag; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT
fail() { echo "${_WA_RED}ERROR: $*${_WA_RST}" >&2; dump_diag; exit 1; }

pg_mount_target() { if [ "${1%%[.-]*}" -le 17 ]; then echo "/var/lib/postgresql/data"; else echo "/var/lib/postgresql"; fi; }

ledger_field() {
  node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=eval(process.argv[2]);process.stdout.write(v===null||v===undefined?"null":String(v));' "$1" "$2"
}

# SU is the cluster superuser for the CURRENT case (set per case block) — Case A
# platform runs as `postgres`, Case B nango runs as `nango` (matching the real
# compose POSTGRES_USER), so the arm exercises the exact superuser path the CLI
# would drive in production.
SU="postgres"

pg_wait() {
  local c="$1" n="${2:-45}" _
  for _ in $(seq 1 "$n"); do
    if docker exec "$c" pg_isready -U "$SU" -q >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

seed_fixture() {
  # seed_fixture <volume> <ledger-file> <from-tag> — a prior-version pg fixture
  # with a data-bearing table + a ledger source entry, initialised with the
  # current case's superuser ($SU). Mounts at the source major's target.
  local vol="$1" ledger="$2" from_tag="$3" mount major
  major="${from_tag%%[.-]*}"
  mount="$(pg_mount_target "$major")"
  docker volume create "$vol" >/dev/null
  docker run -d --name "$SEED" -v "${vol}:${mount}" \
    -e POSTGRES_PASSWORD=uf -e POSTGRES_USER="$SU" -e POSTGRES_DB=postgres "postgres:${from_tag}" >/dev/null
  pg_wait "$SEED" || fail "fixture postgres:${from_tag} did not become ready."
  docker exec "$SEED" psql -U "$SU" -d postgres -v ON_ERROR_STOP=1 -c "
    CREATE SCHEMA IF NOT EXISTS wa;
    CREATE TABLE wa.rows (id int PRIMARY KEY, payload jsonb NOT NULL);
    INSERT INTO wa.rows VALUES (1,'{\"n\":1}'::jsonb),(2,'{\"n\":2}'::jsonb),(3,'{\"n\":3}'::jsonb);
  " >/dev/null
  docker stop -t 60 "$SEED" >/dev/null && docker rm -f "$SEED" >/dev/null
  node "$LEDGER_MJS" record --file "$ledger" --service "$SERVICE" \
    --image "postgres:${from_tag}" --volume-name "$vol" \
    --volume-created-at "$(docker volume inspect -f '{{.CreatedAt}}' "$vol")" >/dev/null
}

assert_data() {
  # assert_data <volume> <tag[@digest]> <major> — server major + value-identical rows.
  local vol="$1" tag="$2" major="$3" mount v cnt match
  mount="$(pg_mount_target "$major")"
  docker run -d --name "$CHK" -v "${vol}:${mount}" \
    -e POSTGRES_PASSWORD=uf -e POSTGRES_USER="$SU" -e POSTGRES_DB=postgres "postgres:${tag}" >/dev/null
  pg_wait "$CHK" || fail "verification postgres:${tag} did not become ready on '${vol}'."
  v="$(docker exec "$CHK" psql -U "$SU" -d postgres -tAc "SHOW server_version" | sed -E 's/^([0-9]+).*/\1/')"
  [ "$v" = "$major" ] || fail "server major on '${vol}' under postgres:${tag} is '${v}', expected ${major}."
  cnt="$(docker exec "$CHK" psql -U "$SU" -d postgres -tAc "SELECT count(*) FROM wa.rows;")"
  [ "$cnt" = "3" ] || fail "row count on '${vol}' under postgres:${tag} is '${cnt}', expected 3 — data did not survive."
  match="$(docker exec "$CHK" psql -U "$SU" -d postgres -tAc "SELECT count(*) FROM wa.rows WHERE (id,payload) IN ((1,'{\"n\":1}'::jsonb),(2,'{\"n\":2}'::jsonb),(3,'{\"n\":3}'::jsonb));")"
  [ "$match" = "3" ] || fail "rows on '${vol}' did not survive value-identical (matched ${match}/3)."
  docker rm -f "$CHK" >/dev/null
}

run_path() {
  # run_path <volume> <ledger> <from> <to> <from-tag> <to-tag> [env NAME=VALUE…]
  local vol="$1" ledger="$2" from="$3" to="$4" from_tag="$5" to_tag="$6"; shift 6
  local rc=0
  env "$@" UPGRADE_LEDGER_FILE="$ledger" \
    bash "$PATH_SH" \
    --service "$SERVICE" --volume "$vol" \
    --from "$from" --to "$to" --from-tag "$from_tag" --to-tag "$to_tag" \
    --backup-dir "$BACKUPS" --superuser "$SU" \
    --verify-cmd 'test "$(docker exec "$UF_VERIFY_CONTAINER" psql -U "$UF_SUPERUSER" -d postgres -tAc "SELECT count(*) FROM wa.rows")" = "3"' \
    || rc=$?
  return $rc
}

mkdir -p "$BACKUPS"
CASEA_FROM_MAJOR="${PG_CASEA_FROM_TAG%%[.-]*}"
CASEA_TO_MAJOR="$(printf '%s' "${PG_CASEA_TO_TAG%%@*}" | sed -E 's/^([0-9]+).*/\1/')"
CASEB_FROM_MAJOR="${PG_CASEB_FROM_TAG%%[.-]*}"
CASEB_TO_MAJOR="$(printf '%s' "${PG_CASEB_TO_TAG%%@*}" | sed -E 's/^([0-9]+).*/\1/')"

wa_log "works-after upgrade-postgres: guarded Case A platform-postgres ${CASEA_FROM_MAJOR}->${CASEA_TO_MAJOR} + Case B nango-postgres ${CASEB_FROM_MAJOR}->${CASEB_TO_MAJOR}"

# ── 0. fail-closed negatives (no containers) ─────────────────────────────────
wa_info "negatives: downgrade + unsupported hop must FAIL CLOSED at resolve time"
rc=0; node "$RESOLVE" platform-postgres "$CASEA_TO_MAJOR" "$CASEA_FROM_MAJOR" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "platform-postgres ${CASEA_TO_MAJOR} -> ${CASEA_FROM_MAJOR} (downgrade) resolved rc=${rc}, expected fail-closed 3."
rc=0; node "$RESOLVE" nango-postgres 17 18 >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "nango-postgres 17 -> 18 (unsupported) resolved rc=${rc}, expected fail-closed 3."
node "$RESOLVE" platform-postgres "$CASEA_FROM_MAJOR" "$CASEA_TO_MAJOR" >/dev/null \
  || fail "platform-postgres ${CASEA_FROM_MAJOR} -> ${CASEA_TO_MAJOR} should be supported."
node "$RESOLVE" nango-postgres "$CASEB_FROM_MAJOR" "$CASEB_TO_MAJOR" >/dev/null \
  || fail "nango-postgres ${CASEB_FROM_MAJOR} -> ${CASEB_TO_MAJOR} should be supported (case-scoped exception)."

# ── Case A — platform-postgres 17 -> 18 ──────────────────────────────────────
SERVICE="platform-postgres"; SU="postgres"
VOL1="${RUN_ID}-a1"; LEDGER1="${WORK}/ledger-a1.json"
VOL2="${RUN_ID}-a2"; LEDGER2="${WORK}/ledger-a2.json"

# 1. quiesce stop
wa_info "Case A quiesce: the path must refuse while a container references the volume"
docker volume create "$VOL1" >/dev/null
docker run -d --name "$HOLD" -v "${VOL1}:/hold" alpine sleep 600 >/dev/null
rc=0; run_path "$VOL1" "${WORK}/never.json" "$CASEA_FROM_MAJOR" "$CASEA_TO_MAJOR" "$PG_CASEA_FROM_TAG" "$PG_CASEA_TO_TAG" || rc=$?
[ "$rc" -eq 3 ] || fail "un-quiesced volume exited ${rc}, expected fail-closed 3."
[ ! -f "${WORK}/never.json" ] || fail "a quiesce refusal must not touch the ledger."
docker rm -f "$HOLD" >/dev/null; docker volume rm "$VOL1" >/dev/null

# 2. fixture
wa_info "Case A fixture: seeding postgres:${PG_CASEA_FROM_TAG} volume + ledger source entry"
seed_fixture "$VOL1" "$LEDGER1" "$PG_CASEA_FROM_TAG"

# 3. failure injection (pre-commit): intact source + source ledger
wa_info "Case A failure injection: UPGRADE_INJECT_FAILURE=post-verify must roll back to the intact source"
PRE_DIGEST="$(wa_volume_digest "$VOL1")"
rc=0; run_path "$VOL1" "$LEDGER1" "$CASEA_FROM_MAJOR" "$CASEA_TO_MAJOR" "$PG_CASEA_FROM_TAG" "$PG_CASEA_TO_TAG" UPGRADE_INJECT_FAILURE=post-verify || rc=$?
[ "$rc" -eq 5 ] || fail "injected post-verify failure exited ${rc}, expected pre-commit abort 5."
POST_DIGEST="$(wa_volume_digest "$VOL1")"
[ "$PRE_DIGEST" = "$POST_DIGEST" ] || fail "the source volume's COLD content digest changed across the injected failure (${PRE_DIGEST} -> ${POST_DIGEST}) — the original was touched pre-commit."
[ "$(ledger_field "$LEDGER1" 'l.services["platform-postgres"].image')" = "postgres:${PG_CASEA_FROM_TAG}" ] \
  || fail "after rollback the ledger must still carry the SOURCE entry."
[ "$(ledger_field "$LEDGER1" 'l.pending')" = "null" ] || fail "after rollback no pending journal may remain."
[ -z "$(docker volume ls -q --filter "name=${VOL1}-ufcand")" ] || fail "rollback leaked a candidate volume."
[ -z "$(docker volume ls -q --filter "name=${VOL1}-uftarget")" ] || fail "rollback leaked a target volume."
assert_data "$VOL1" "$PG_CASEA_FROM_TAG" "$CASEA_FROM_MAJOR"
wa_info "Case A rollback verified: source volume value-identical under pg${CASEA_FROM_MAJOR}, source ledger entry intact"

# 4. positive
wa_info "Case A positive: full guarded upgrade ${CASEA_FROM_MAJOR} -> ${CASEA_TO_MAJOR}"
run_path "$VOL1" "$LEDGER1" "$CASEA_FROM_MAJOR" "$CASEA_TO_MAJOR" "$PG_CASEA_FROM_TAG" "$PG_CASEA_TO_TAG" \
  || fail "guarded platform-postgres upgrade path failed (exit $?)."
[ "$(ledger_field "$LEDGER1" 'l.services["platform-postgres"].image')" = "postgres:${PG_CASEA_TO_TAG}" ] \
  || fail "after commit the ledger must carry the TARGET entry."
[ "$(ledger_field "$LEDGER1" 'l.pending')" = "null" ] || fail "after commit no pending journal may remain."
assert_data "$VOL1" "$PG_CASEA_TO_TAG" "$CASEA_TO_MAJOR"
ls "$BACKUPS"/${SERVICE}-*.sql >/dev/null 2>&1 || fail "checksummed dump artifact missing."
ls "$BACKUPS"/${SERVICE}-*.sql.sha256 >/dev/null 2>&1 || fail "dump checksum file missing."
wa_info "Case A upgrade verified: rows value-identical on pg${CASEA_TO_MAJOR}; ledger committed; dump retained"

# 5. interrupted (post-commit): pending journal retained, fail-closed
wa_info "Case A interrupted: UPGRADE_INJECT_FAILURE=cutover-verify must retain the pending journal"
seed_fixture "$VOL2" "$LEDGER2" "$PG_CASEA_FROM_TAG"
rc=0; run_path "$VOL2" "$LEDGER2" "$CASEA_FROM_MAJOR" "$CASEA_TO_MAJOR" "$PG_CASEA_FROM_TAG" "$PG_CASEA_TO_TAG" UPGRADE_INJECT_FAILURE=cutover-verify || rc=$?
[ "$rc" -eq 4 ] || fail "injected cutover-verify failure exited ${rc}, expected post-commit interruption 4."
[ "$(ledger_field "$LEDGER2" 'l.pending && l.pending.service')" = "platform-postgres" ] \
  || fail "an interrupted migration must RETAIN its pending ledger journal (fail-closed evidence)."
[ "$(ledger_field "$LEDGER2" 'l.services["platform-postgres"].image')" = "postgres:${PG_CASEA_FROM_TAG}" ] \
  || fail "the live ledger entry must still be the SOURCE while interrupted."
[ -n "$(docker volume ls -q --filter "name=${VOL2}-uftarget")" ] \
  || fail "an interrupted migration must retain the target volume as recovery material."

# ── Case B — nango-postgres 15 -> 17 (case-scoped exception) ──────────────────
# Runs as the `nango` superuser (matching the real compose POSTGRES_USER=nango),
# exercising the exact non-default-superuser path the CLI drives for nango-db.
SERVICE="nango-postgres"; SU="nango"
VOL3="${RUN_ID}-b1"; LEDGER3="${WORK}/ledger-b1.json"
wa_info "Case B: nango-postgres ${CASEB_FROM_MAJOR} -> ${CASEB_TO_MAJOR} end to end (skipped major, legacy mount both sides)"
seed_fixture "$VOL3" "$LEDGER3" "$PG_CASEB_FROM_TAG"
run_path "$VOL3" "$LEDGER3" "$CASEB_FROM_MAJOR" "$CASEB_TO_MAJOR" "$PG_CASEB_FROM_TAG" "$PG_CASEB_TO_TAG" \
  || fail "guarded nango-postgres 15 -> 17 upgrade path failed (exit $?)."
[ "$(ledger_field "$LEDGER3" 'l.services["nango-postgres"].image')" = "postgres:${PG_CASEB_TO_TAG}" ] \
  || fail "after the nango-postgres commit the ledger must carry the TARGET entry."
[ "$(ledger_field "$LEDGER3" 'l.pending')" = "null" ] || fail "after the nango-postgres commit no pending journal may remain."
assert_data "$VOL3" "$PG_CASEB_TO_TAG" "$CASEB_TO_MAJOR"

echo "${_WA_GREEN}==> works-after upgrade-postgres PASSED${_WA_RST} — guarded Case A ${CASEA_FROM_MAJOR}->${CASEA_TO_MAJOR} (negatives + quiesce + rollback-on-intact-source + positive + interrupted) and Case B nango ${CASEB_FROM_MAJOR}->${CASEB_TO_MAJOR} proven end to end."
