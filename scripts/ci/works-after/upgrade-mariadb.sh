#!/usr/bin/env bash
set -euo pipefail
# works-after :: MariaDB UPGRADE-FROM arm (cinatra#1421 + cinatra#1422).
#
# The data-bearing prior-version fixture for the MariaDB family's guarded
# engine-upgrade path (scripts/upgrade/mariadb-upgrade-major.sh), landed as
# the coordinated pair of that path. One run covers BOTH MariaDB services:
# wordpress-mariadb carries the full battery (quiesce stop, failure
# injection, positive, dump/restore fallback); drupal-mariadb — the same
# engine, image and transition set — carries its OWN end-to-end positive
# proof, so EACH supported matrix transition has an executable upgrade-from
# proof. It proves, in order:
#
#   0. NEGATIVES (matrix, no containers): the sequential-only rule
#      (11.4 -> 12.0) and the downgrade (11.8 -> 11.4) FAIL CLOSED; the
#      supported hop resolves for BOTH services.
#   1. QUIESCE STOP: the path refuses (exit 3, no ledger touch) while any
#      container still references the volume.
#   2. FIXTURE: a mariadb:${MARIADB_FROM_TAG} volume with a seeded,
#      checksum-verifiable table, ledger-recorded at the source version.
#   3. FAILURE INJECTION (pre-commit): UPGRADE_INJECT_FAILURE=post-verify
#      must exit 5 and land back on the INTACT source volume WITH the
#      source-version ledger entry intact (CHECKSUM TABLE equal under the
#      SOURCE image; no pending journal; no leaked candidate volume).
#   4. POSITIVE: the same fixture upgrades in place (explicit
#      mariadb-upgrade on the CANDIDATE) ${MARIADB_FROM_TAG} ->
#      ${MARIADB_TO_TAG}; ledger commits; data survives byte-identical;
#      the checksummed dump artifact exists.
#   5. DUMP/RESTORE FALLBACK: on a second fixture,
#      UPGRADE_INJECT_FAILURE=inplace-migrate forces the in-place step to
#      fail — the path must COMPLETE via the dump/restore fallback (exit 0,
#      fallback marker in the transcript, same data + version assertions).
#   6. DRUPAL PARITY: a third fixture runs the drupal-mariadb transition end
#      to end (positive path; the family mechanics are identical, the
#      transition proof is its own).
#   7. INTERRUPTED (post-commit): on a fourth fixture,
#      UPGRADE_INJECT_FAILURE=cutover-verify must exit 4, RETAIN the pending
#      ledger journal (live entry still the SOURCE) and the candidate volume.
#
# Env: MARIADB_FROM_TAG (default: the 11.4 compose pin, DIGEST-BOUND — an
# upgrade-from fixture pins its source-image digest, cinatra#1422) and
# MARIADB_TO_TAG (default: 11.8 digest-bound — the matrix-supported next hop),
# so a bare run exercises the REAL supported cross-series path on exact bytes;
# a future engine lane overrides both. The matrix versions are the tags'
# release series (the part before any @sha256 pin). Fully isolated: named
# throwaway volumes, no host ports, throwaway root password minted per run.

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

# Digest-bound defaults (multi-arch index digests, resolved 2026-07-12 via the
# registry API): the fixture pins its source AND target image bytes; an
# override may be a bare tag (an intentionally unpinned manual run).
MARIADB_FROM_TAG="${MARIADB_FROM_TAG:-11.4@sha256:a794d9eb009e20de605858a11f32f63b4075cbd197c650436f0e3b457e4caed7}"
MARIADB_TO_TAG="${MARIADB_TO_TAG:-11.8@sha256:efb4959ef2c835cd735dbc388eb9ad6aab0c78dd64febcd51bc17481111890c4}"
# The MATRIX versions = the release series of each tag (strip any digest pin).
FROM_SERIES="${MARIADB_FROM_TAG%%@*}"
TO_SERIES="${MARIADB_TO_TAG%%@*}"
SERVICE="wordpress-mariadb"

RUN_ID="wa-upgmdb-$$"
VOL1="${RUN_ID}-vol1"
VOL2="${RUN_ID}-vol2"
VOL3="${RUN_ID}-vol3"
VOL4="${RUN_ID}-vol4"
SEED="${RUN_ID}-seed"
CHK="${RUN_ID}-chk"
HOLD="${RUN_ID}-hold"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/${RUN_ID}.XXXXXX")"
LEDGER1="${WORK}/ledger1.json"
LEDGER2="${WORK}/ledger2.json"
LEDGER3="${WORK}/ledger3.json"
LEDGER4="${WORK}/ledger4.json"
BACKUPS="${WORK}/backups"
PATH_SH="${REPO_ROOT}/scripts/upgrade/mariadb-upgrade-major.sh"
RESOLVE="${REPO_ROOT}/scripts/upgrade/resolve-transition.mjs"
LEDGER_MJS="${REPO_ROOT}/scripts/upgrade/ledger.mjs"
# Throwaway credentials, minted per run (never an ops secret).
FIX_PW="$(wa_throwaway_hexkey 16)"
export UPGRADE_MARIADB_ROOT_PASSWORD="$FIX_PW"

cleanup() {
  docker rm -f "$SEED" "$CHK" "$HOLD" >/dev/null 2>&1 || true
  for v in $(docker volume ls -q --filter "name=${RUN_ID}" 2>/dev/null); do
    docker volume rm -f "$v" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK" >/dev/null 2>&1 || true
}
dump_diag() {
  wa_group_start "works-after upgrade-mariadb failure diagnostics"
  echo "--- docker ps -a (run containers) ---"; docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- volumes ---"; docker volume ls --filter "name=${RUN_ID}" || true
  echo "--- ledger 1 ---"; cat "$LEDGER1" 2>/dev/null || true
  echo "--- ledger 2 ---"; cat "$LEDGER2" 2>/dev/null || true
  echo "--- ledger 3 ---"; cat "$LEDGER3" 2>/dev/null || true
  echo "--- fallback transcript tail ---"; tail -40 "${WORK}/fallback.log" 2>/dev/null || true
  wa_group_end
}
on_err() { echo "${_WA_RED}ERROR: works-after upgrade-mariadb FAILED (line $1).${_WA_RST}" >&2; dump_diag; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT
fail() { echo "${_WA_RED}ERROR: $*${_WA_RST}" >&2; dump_diag; exit 1; }

ledger_field() {
  node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=eval(process.argv[2]);process.stdout.write(v===null||v===undefined?"null":String(v));' "$1" "$2"
}

mdb_wait() {
  local c="$1" n="${2:-60}" _
  for _ in $(seq 1 "$n"); do
    if docker exec "$c" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

SEED_CHECKSUM=""
seed_fixture() {
  # seed_fixture <volume> <ledger-file> — prior-version fixture with a
  # checksum-verifiable data-bearing table + a ledger source entry.
  local vol="$1" ledger="$2"
  docker volume create "$vol" >/dev/null
  docker run -d --name "$SEED" -v "${vol}:/var/lib/mysql" \
    -e MARIADB_ROOT_PASSWORD="$FIX_PW" -e MARIADB_DATABASE=wa_upgrade \
    "mariadb:${MARIADB_FROM_TAG}" >/dev/null
  mdb_wait "$SEED" || fail "fixture mariadb:${MARIADB_FROM_TAG} did not become healthy."
  docker exec -e MYSQL_PWD="$FIX_PW" "$SEED" mariadb -uroot wa_upgrade -e "
    CREATE TABLE wa_rows (id INT PRIMARY KEY, payload VARCHAR(191) NOT NULL);
    INSERT INTO wa_rows VALUES (1,'works-after-1'), (2,'works-after-2'), (3,'works-after-3');
  " >/dev/null
  SEED_CHECKSUM="$(docker exec -e MYSQL_PWD="$FIX_PW" "$SEED" mariadb -uroot -N -e "CHECKSUM TABLE wa_upgrade.wa_rows;" | awk '{print $2}')"
  [ -n "$SEED_CHECKSUM" ] || fail "could not capture the fixture table checksum."
  docker exec -e MYSQL_PWD="$FIX_PW" "$SEED" mariadb -uroot -e "SET GLOBAL innodb_fast_shutdown=0;" >/dev/null
  docker stop -t 120 "$SEED" >/dev/null && docker rm -f "$SEED" >/dev/null
  node "$LEDGER_MJS" record --file "$ledger" --service "$SERVICE" \
    --image "mariadb:${MARIADB_FROM_TAG}" --volume-name "$vol" \
    --volume-created-at "$(docker volume inspect -f '{{.CreatedAt}}' "$vol")" >/dev/null
}

assert_data() {
  # assert_data <volume> <image-tag[@digest]> <series> — version series +
  # byte-identical rows.
  local vol="$1" tag="$2" series="$3" v sum
  docker run -d --name "$CHK" -v "${vol}:/var/lib/mysql" "mariadb:${tag}" >/dev/null
  mdb_wait "$CHK" || fail "verification mariadb:${tag} did not become healthy on '${vol}'."
  v="$(docker exec -e MYSQL_PWD="$FIX_PW" "$CHK" mariadb -uroot -N -e "SELECT VERSION();")"
  case "$v" in "${series}."*) : ;; *) fail "VERSION() on '${vol}' is '${v}', expected ${series}.*" ;; esac
  sum="$(docker exec -e MYSQL_PWD="$FIX_PW" "$CHK" mariadb -uroot -N -e "CHECKSUM TABLE wa_upgrade.wa_rows;" | awk '{print $2}')"
  [ "$sum" = "$SEED_CHECKSUM" ] || fail "table checksum on '${vol}' under mariadb:${tag} is '${sum}', seeded '${SEED_CHECKSUM}' — data did not survive byte-identical."
  docker rm -f "$CHK" >/dev/null
}

run_path() {
  # run_path <volume> <ledger> [env NAME=VALUE…]
  local vol="$1" ledger="$2"; shift 2
  local rc=0
  env "$@" UPGRADE_LEDGER_FILE="$ledger" \
    UPGRADE_MARIADB_ROOT_PASSWORD="$FIX_PW" \
    bash "$PATH_SH" \
    --service "$SERVICE" --volume "$vol" \
    --from "$FROM_SERIES" --to "$TO_SERIES" \
    --from-tag "$MARIADB_FROM_TAG" --to-tag "$MARIADB_TO_TAG" \
    --backup-dir "$BACKUPS" \
    --verify-cmd 'test "$(docker exec -e MYSQL_PWD="$MYSQL_PWD" "$UF_VERIFY_CONTAINER" mariadb -uroot -N -e "SELECT COUNT(*) FROM wa_upgrade.wa_rows;")" = "3"' \
    || rc=$?
  return $rc
}

wa_log "works-after upgrade-mariadb: guarded path ${FROM_SERIES} -> ${TO_SERIES} (matrix ${SERVICE}; images mariadb:${MARIADB_FROM_TAG} -> mariadb:${MARIADB_TO_TAG})"

# ── 0. fail-closed negatives (no containers) ─────────────────────────────────
wa_info "negatives: sequential-only + downgrade must FAIL CLOSED at resolve time"
rc=0; node "$RESOLVE" wordpress-mariadb "$FROM_SERIES" 12.0 >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "wordpress-mariadb ${FROM_SERIES} -> 12.0 (skips a series) resolved rc=${rc}, expected fail-closed 3."
rc=0; node "$RESOLVE" wordpress-mariadb "$TO_SERIES" "$FROM_SERIES" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "wordpress-mariadb ${TO_SERIES} -> ${FROM_SERIES} (downgrade) resolved rc=${rc}, expected fail-closed 3."
node "$RESOLVE" wordpress-mariadb "$FROM_SERIES" "$TO_SERIES" >/dev/null \
  || fail "wordpress-mariadb ${FROM_SERIES} -> ${TO_SERIES} should be supported."
node "$RESOLVE" drupal-mariadb "$FROM_SERIES" "$TO_SERIES" >/dev/null \
  || fail "drupal-mariadb ${FROM_SERIES} -> ${TO_SERIES} should be supported (family parity — one path, both services)."

# ── 1. quiesce stop ──────────────────────────────────────────────────────────
wa_info "quiesce: the path must refuse while a container references the volume"
mkdir -p "$BACKUPS"
docker volume create "$VOL1" >/dev/null
docker run -d --name "$HOLD" -v "${VOL1}:/hold" alpine sleep 600 >/dev/null
rc=0
run_path "$VOL1" "${WORK}/never-written.json" || rc=$?
[ "$rc" -eq 3 ] || fail "un-quiesced volume exited ${rc}, expected fail-closed 3."
[ ! -f "${WORK}/never-written.json" ] || fail "a quiesce refusal must not touch the ledger."
docker rm -f "$HOLD" >/dev/null
docker volume rm "$VOL1" >/dev/null

# ── 2. fixture ───────────────────────────────────────────────────────────────
wa_info "fixture: seeding mariadb:${MARIADB_FROM_TAG} volume + ledger source entry"
seed_fixture "$VOL1" "$LEDGER1"

# ── 3. failure injection (pre-commit): intact source + source ledger ─────────
wa_info "failure injection: UPGRADE_INJECT_FAILURE=post-verify must roll back"
PRE_DIGEST="$(wa_volume_digest "$VOL1")"
rc=0; run_path "$VOL1" "$LEDGER1" UPGRADE_INJECT_FAILURE=post-verify || rc=$?
[ "$rc" -eq 5 ] || fail "injected post-verify failure exited ${rc}, expected pre-commit abort 5."
POST_DIGEST="$(wa_volume_digest "$VOL1")"
[ "$PRE_DIGEST" = "$POST_DIGEST" ] \
  || fail "the source volume's COLD content digest changed across the injected failure (${PRE_DIGEST} -> ${POST_DIGEST}) — the original was touched pre-commit."
[ "$(ledger_field "$LEDGER1" 'l.services["wordpress-mariadb"].image')" = "mariadb:${MARIADB_FROM_TAG}" ] \
  || fail "after rollback the ledger must still carry the SOURCE entry."
[ "$(ledger_field "$LEDGER1" 'l.pending')" = "null" ] || fail "after rollback no pending journal may remain."
[ -z "$(docker volume ls -q --filter "name=${VOL1}-ufcand")" ] || fail "rollback leaked a candidate volume."
assert_data "$VOL1" "$MARIADB_FROM_TAG" "$FROM_SERIES"
wa_info "rollback verified: source volume byte-identical under ${FROM_SERIES}, source ledger entry intact"

# ── 4. positive: guarded in-place upgrade end to end ─────────────────────────
wa_info "positive: full guarded upgrade (explicit mariadb-upgrade on the candidate)"
run_path "$VOL1" "$LEDGER1" || fail "guarded mariadb upgrade path failed (exit $?)."
[ "$(ledger_field "$LEDGER1" 'l.services["wordpress-mariadb"].image')" = "mariadb:${MARIADB_TO_TAG}" ] \
  || fail "after commit the ledger must carry the TARGET entry."
[ "$(ledger_field "$LEDGER1" 'l.pending')" = "null" ] || fail "after commit no pending journal may remain."
assert_data "$VOL1" "$MARIADB_TO_TAG" "$TO_SERIES"
ls "$BACKUPS"/${SERVICE}-*.sql >/dev/null 2>&1 || fail "checksummed dump artifact missing."
ls "$BACKUPS"/${SERVICE}-*.sql.sha256 >/dev/null 2>&1 || fail "dump checksum file missing."
wa_info "upgrade verified: rows byte-identical on ${TO_SERIES}; ledger committed; dump retained"

# ── 5. dump/restore fallback ─────────────────────────────────────────────────
wa_info "fallback: UPGRADE_INJECT_FAILURE=inplace-migrate must complete via dump/restore"
seed_fixture "$VOL2" "$LEDGER2"
rc=0
run_path "$VOL2" "$LEDGER2" UPGRADE_INJECT_FAILURE=inplace-migrate 2>&1 | tee "${WORK}/fallback.log" || rc=$?
[ "$rc" -eq 0 ] || fail "fallback run exited ${rc}, expected success via dump/restore."
grep -q "fallback: in-place mariadb-upgrade failed" "${WORK}/fallback.log" \
  || fail "fallback transcript is missing the dump/restore fallback marker — the in-place path may have run instead."
[ "$(ledger_field "$LEDGER2" 'l.services["wordpress-mariadb"].image')" = "mariadb:${MARIADB_TO_TAG}" ] \
  || fail "after the fallback commit the ledger must carry the TARGET entry."
assert_data "$VOL2" "$MARIADB_TO_TAG" "$TO_SERIES"

# ── 6. drupal-mariadb: the second family service, own end-to-end proof ───────
wa_info "drupal parity: drupal-mariadb ${FROM_SERIES} -> ${TO_SERIES} end to end (same family path, own transition)"
SERVICE="drupal-mariadb"
seed_fixture "$VOL3" "$LEDGER3"
run_path "$VOL3" "$LEDGER3" || fail "guarded drupal-mariadb upgrade path failed (exit $?)."
[ "$(ledger_field "$LEDGER3" 'l.services["drupal-mariadb"].image')" = "mariadb:${MARIADB_TO_TAG}" ] \
  || fail "after the drupal-mariadb commit the ledger must carry the TARGET entry."
[ "$(ledger_field "$LEDGER3" 'l.pending')" = "null" ] || fail "after the drupal-mariadb commit no pending journal may remain."
assert_data "$VOL3" "$MARIADB_TO_TAG" "$TO_SERIES"

# ── 7. interrupted (post-commit): pending journal retained, fail-closed ──────
wa_info "interrupted: UPGRADE_INJECT_FAILURE=cutover-verify must retain the pending journal"
SERVICE="wordpress-mariadb"
seed_fixture "$VOL4" "$LEDGER4"
rc=0; run_path "$VOL4" "$LEDGER4" UPGRADE_INJECT_FAILURE=cutover-verify || rc=$?
[ "$rc" -eq 4 ] || fail "injected cutover-verify failure exited ${rc}, expected post-commit interruption 4."
[ "$(ledger_field "$LEDGER4" 'l.pending && l.pending.service')" = "wordpress-mariadb" ] \
  || fail "an interrupted migration must RETAIN its pending ledger journal (fail-closed evidence)."
[ "$(ledger_field "$LEDGER4" 'l.pending.target.image')" = "mariadb:${MARIADB_TO_TAG}" ] \
  || fail "the retained journal must record the TARGET image it was migrating to."
[ "$(ledger_field "$LEDGER4" 'l.services["wordpress-mariadb"].image')" = "mariadb:${MARIADB_FROM_TAG}" ] \
  || fail "the live ledger entry must still be the SOURCE while interrupted."
[ -n "$(docker volume ls -q --filter "name=${VOL4}-ufcand")" ] \
  || fail "an interrupted migration must retain the candidate volume as recovery material."

echo "${_WA_GREEN}==> works-after upgrade-mariadb PASSED${_WA_RST} — guarded ${FROM_SERIES} -> ${TO_SERIES} path: fail-closed negatives + quiesce stop, rollback lands on the intact source + source ledger, in-place upgrade commits, dump/restore fallback completes, drupal-mariadb parity proven end to end, interruption stays fail-closed."
