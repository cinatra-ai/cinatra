#!/usr/bin/env bash
set -euo pipefail
# works-after :: redis/valkey UPGRADE-FROM arm (cinatra#1421 + cinatra#1422).
#
# The data-bearing prior-version fixture for the redis family's guarded
# upgrade path (scripts/upgrade/redis-upgrade-major.sh), landed as the
# coordinated pair of that path. It proves, in order:
#
#   0. NEGATIVES (matrix, no containers): the downgrade (platform-redis
#      8 -> 7) and every unlisted hop (plane-redis valkey 7.2.11 -> 8,
#      twenty-redis 7 -> 8) FAIL CLOSED at resolve time; the supported hop
#      resolves. Cross-fork block: pointing the path at a valkey image repo
#      for a redis service refuses BEFORE any mutation.
#   1. FIXTURE: a redis:${REDIS_FROM_TAG} volume seeded with real keys of
#      MULTIPLE types (strings, hash, list, set, zset, a volatile-TTL key,
#      and a second database) under AOF (--appendonly yes — the arm
#      deliberately exercises the explicit AOF handling AND the path's
#      type-aware full-state digest), ledger-recorded at the source version.
#   2. FAILURE INJECTION (pre-commit): the path run with
#      UPGRADE_INJECT_FAILURE=post-verify must exit 5 and land back on the
#      byte-identical source volume (COLD content digest compared pre/post)
#      WITH the source-version ledger entry intact and no pending journal
#      and no leaked candidate volume.
#   3. POSITIVE: the same fixture upgrades ${REDIS_FROM_TAG} ->
#      ${REDIS_TO_TAG}; the ledger commits the target entry; the data +
#      AOF mode survive (probe nonce read-back incl. the second database,
#      DBSIZE, aof_enabled — the path itself asserts the full-state digest);
#      the checksummed backup artifact exists.
#   4. INTERRUPTED (post-commit): on a second fixture,
#      UPGRADE_INJECT_FAILURE=cutover-verify must exit 4 and RETAIN the
#      pending ledger journal recording the TARGET image (the fail-closed
#      "interrupted migration" evidence the cinatra-cli preflight refuses
#      on) with the live entry still the SOURCE, plus the candidate volume
#      as recovery material.
#
# Env: REDIS_FROM_TAG (default: 7-alpine DIGEST-BOUND — an upgrade-from
# fixture pins its source-image digest, cinatra#1422; this is the exact
# pre-#1339 compose pin, i.e. what a live 7-era volume ran) and REDIS_TO_TAG
# (default: the current digest-bound 8-alpine compose pin) — the
# matrix-supported platform-redis 7 -> 8 hop; a future major lane overrides
# both. Fully isolated: named throwaway volumes, no host ports.

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

# Digest-bound defaults (multi-arch index digests): FROM = the pre-#1339
# 7-alpine pin (docker-compose.yml documents it as the rollback ref), TO = the
# current 8-alpine compose pin. An override may be a bare tag (an
# intentionally unpinned manual run).
REDIS_FROM_TAG="${REDIS_FROM_TAG:-7-alpine@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99}"
REDIS_TO_TAG="${REDIS_TO_TAG:-8-alpine@sha256:9d317178eceac8454a2284a9e6df2466b93c745529947f0cd42a0fa9609d7005}"
# The MATRIX versions = each tag's major (strip any digest pin first).
FROM_BARE="${REDIS_FROM_TAG%%@*}"
TO_BARE="${REDIS_TO_TAG%%@*}"
FROM_MAJOR="${FROM_BARE%%[.-]*}"
TO_MAJOR="${TO_BARE%%[.-]*}"
SERVICE="platform-redis"

RUN_ID="wa-upgrds-$$"
VOL1="${RUN_ID}-vol1"
VOL2="${RUN_ID}-vol2"
SEED="${RUN_ID}-seed"
CHK="${RUN_ID}-chk"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/${RUN_ID}.XXXXXX")"
LEDGER1="${WORK}/ledger1.json"
LEDGER2="${WORK}/ledger2.json"
BACKUPS="${WORK}/backups"
PATH_SH="${REPO_ROOT}/scripts/upgrade/redis-upgrade-major.sh"
RESOLVE="${REPO_ROOT}/scripts/upgrade/resolve-transition.mjs"
LEDGER_MJS="${REPO_ROOT}/scripts/upgrade/ledger.mjs"
PROBE_NONCE="$(wa_throwaway_hexkey 16)"

cleanup() {
  docker rm -f "$SEED" "$CHK" >/dev/null 2>&1 || true
  # The path's own containers/candidates are namespaced by ITS pid; sweep any
  # candidate volumes derived from our fixture volumes.
  for v in $(docker volume ls -q --filter "name=${RUN_ID}" 2>/dev/null); do
    docker volume rm -f "$v" >/dev/null 2>&1 || true
  done
  rm -rf "$WORK" >/dev/null 2>&1 || true
}
dump_diag() {
  wa_group_start "works-after upgrade-redis failure diagnostics"
  echo "--- docker ps -a (run containers) ---"; docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- volumes ---"; docker volume ls --filter "name=${RUN_ID}" || true
  echo "--- ledger 1 ---"; cat "$LEDGER1" 2>/dev/null || true
  echo "--- ledger 2 ---"; cat "$LEDGER2" 2>/dev/null || true
  wa_group_end
}
on_err() { echo "${_WA_RED}ERROR: works-after upgrade-redis FAILED (line $1).${_WA_RST}" >&2; dump_diag; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT
fail() { echo "${_WA_RED}ERROR: $*${_WA_RST}" >&2; dump_diag; exit 1; }

ledger_field() {
  # ledger_field <file> <node-expression over `l`>
  node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=eval(process.argv[2]);process.stdout.write(v===null||v===undefined?"null":String(v));' "$1" "$2"
}

seed_fixture() {
  # seed_fixture <volume> <ledger-file> — data-bearing prior-version fixture
  # under AOF + a ledger source entry.
  local vol="$1" ledger="$2" i
  docker volume create "$vol" >/dev/null
  docker run -d --name "$SEED" -v "${vol}:/data" "redis:${REDIS_FROM_TAG}" redis-server --appendonly yes >/dev/null
  wa_wait_redis "$SEED" 30 || fail "fixture redis:${REDIS_FROM_TAG} did not become ready."
  for i in $(seq 1 50); do
    docker exec "$SEED" redis-cli set "wa:k${i}" "v${i}" >/dev/null
  done
  docker exec "$SEED" redis-cli set "wa:probe" "$PROBE_NONCE" >/dev/null
  # Multiple types + a volatile key + a second database: exercises the path's
  # type-aware full-state digest (values, not just key names) across the hop.
  docker exec "$SEED" redis-cli hset wa:h f1 v1 f2 v2 >/dev/null
  docker exec "$SEED" redis-cli rpush wa:l a b c >/dev/null
  docker exec "$SEED" redis-cli sadd wa:s x y z >/dev/null
  docker exec "$SEED" redis-cli zadd wa:z 1 a 2 b >/dev/null
  docker exec "$SEED" redis-cli set wa:ttl tick EX 3600 >/dev/null
  # Values carrying raw control/delimiter bytes: the path's full-state digest
  # must frame elements (length-prefixed), so these can never collide with a
  # multi-element encoding.
  docker exec "$SEED" sh -c "redis-cli rpush wa:bin \"\$(printf 'a\\001b\\002c')\" \"\$(printf 'd\\003e')\"" >/dev/null
  docker exec "$SEED" redis-cli -n 1 set wa:db1 "db1-${PROBE_NONCE}" >/dev/null
  docker exec "$SEED" redis-cli save >/dev/null
  docker stop -t 30 "$SEED" >/dev/null && docker rm -f "$SEED" >/dev/null
  node "$LEDGER_MJS" record --file "$ledger" --service "$SERVICE" \
    --image "redis:${REDIS_FROM_TAG}" --volume-name "$vol" \
    --volume-created-at "$(docker volume inspect -f '{{.CreatedAt}}' "$vol")" >/dev/null
}

assert_probe() {
  # assert_probe <volume> <image-tag> <expected-aof yes|no>
  local vol="$1" tag="$2" aof="$3" got en
  docker run -d --name "$CHK" -v "${vol}:/data" "redis:${tag}" redis-server --appendonly "$aof" >/dev/null
  wa_wait_redis "$CHK" 30 || fail "verification redis:${tag} did not become ready on '${vol}'."
  got="$(docker exec "$CHK" redis-cli get wa:probe)"
  [ "$got" = "$PROBE_NONCE" ] || fail "probe key mismatch on '${vol}' under redis:${tag} (got '${got}')."
  got="$(docker exec "$CHK" redis-cli dbsize)"
  [ "$got" = "57" ] || fail "DBSIZE on '${vol}' under redis:${tag} is ${got}, expected 57."
  got="$(docker exec "$CHK" redis-cli -n 1 get wa:db1)"
  [ "$got" = "db1-${PROBE_NONCE}" ] || fail "second-database probe mismatch on '${vol}' under redis:${tag} (got '${got}')."
  if [ "$aof" = "yes" ]; then
    en="$(docker exec "$CHK" redis-cli INFO persistence | tr -d '\r' | grep '^aof_enabled:' || true)"
    [ "$en" = "aof_enabled:1" ] || fail "aof_enabled is not 1 on '${vol}' under redis:${tag}."
  fi
  docker rm -f "$CHK" >/dev/null
}

run_path() {
  # run_path <volume> <ledger> [env NAME=VALUE…] — returns the path's exit code.
  local vol="$1" ledger="$2"; shift 2
  local rc=0
  env "$@" UPGRADE_LEDGER_FILE="$ledger" bash "$PATH_SH" \
    --service "$SERVICE" --volume "$vol" \
    --from "$FROM_MAJOR" --to "$TO_MAJOR" \
    --from-tag "$REDIS_FROM_TAG" --to-tag "$REDIS_TO_TAG" \
    --backup-dir "$BACKUPS" \
    --verify-cmd 'test "$(docker exec "$UF_VERIFY_CONTAINER" redis-cli get wa:probe)" = "'"$PROBE_NONCE"'"' \
    || rc=$?
  return $rc
}

wa_log "works-after upgrade-redis: guarded path ${REDIS_FROM_TAG} -> ${REDIS_TO_TAG} (matrix ${SERVICE} ${FROM_MAJOR} -> ${TO_MAJOR})"

# ── 0. fail-closed negatives (no containers) ─────────────────────────────────
wa_info "negatives: downgrade + unlisted hops must FAIL CLOSED at resolve time"
rc=0; node "$RESOLVE" platform-redis 8 7 >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "platform-redis 8 -> 7 (downgrade) resolved rc=${rc}, expected fail-closed 3."
rc=0; node "$RESOLVE" plane-redis 7.2.11 8 >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "plane-redis (valkey) 7.2.11 -> 8 resolved rc=${rc}, expected fail-closed 3."
rc=0; node "$RESOLVE" twenty-redis 7 8 >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "twenty-redis 7 -> 8 (unlisted) resolved rc=${rc}, expected fail-closed 3."
node "$RESOLVE" platform-redis "$FROM_MAJOR" "$TO_MAJOR" >/dev/null \
  || fail "platform-redis ${FROM_MAJOR} -> ${TO_MAJOR} should be a supported matrix transition."

# Cross-fork block: valkey services have no supported hop AND the path pins
# the image repo to the matrix service — a valkey hop refuses pre-mutation.
rc=0
UPGRADE_LEDGER_FILE="${WORK}/never-written.json" bash "$PATH_SH" \
  --service plane-redis --volume "does-not-exist-${RUN_ID}" \
  --from 7.2.11 --to 8 --backup-dir "$BACKUPS" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] || fail "valkey hop through the path exited ${rc}, expected fail-closed 3."
[ ! -f "${WORK}/never-written.json" ] || fail "a refused hop must not touch the ledger."

# ── 1. fixture ───────────────────────────────────────────────────────────────
wa_info "fixture: seeding redis:${REDIS_FROM_TAG} volume (AOF on) + ledger source entry"
mkdir -p "$BACKUPS"
seed_fixture "$VOL1" "$LEDGER1"

# ── 1b. begin refusal: an existing pending journal exits 3, untouched ────────
# (exercises the ERR-trap path through the ledger seam: a begin refusal must
# surface as a fail-closed 3 with NOTHING mutated — never as a fake rollback.)
wa_info "begin refusal: a pre-existing pending journal must exit 3 and stay untouched"
cp "$LEDGER1" "${WORK}/pending.json"
node "$LEDGER_MJS" begin --file "${WORK}/pending.json" --service "$SERVICE" \
  --image "redis:${REDIS_TO_TAG}" --volume-name "$VOL1" \
  --volume-created-at "$(docker volume inspect -f '{{.CreatedAt}}' "$VOL1")" >/dev/null
rc=0; run_path "$VOL1" "${WORK}/pending.json" || rc=$?
[ "$rc" -eq 3 ] || fail "a begin refusal surfaced as exit ${rc}, expected fail-closed 3 (never a fake rollback)."
[ "$(ledger_field "${WORK}/pending.json" 'l.pending && l.pending.service')" = "platform-redis" ] \
  || fail "the pre-existing pending journal must remain exactly as found after a begin refusal."

# ── 2. failure injection (pre-commit): intact source + source ledger ─────────
wa_info "failure injection: UPGRADE_INJECT_FAILURE=post-verify must roll back"
PRE_DIGEST="$(wa_volume_digest "$VOL1")"
rc=0; run_path "$VOL1" "$LEDGER1" UPGRADE_INJECT_FAILURE=post-verify || rc=$?
[ "$rc" -eq 5 ] || fail "injected post-verify failure exited ${rc}, expected pre-commit abort 5."
POST_DIGEST="$(wa_volume_digest "$VOL1")"
[ "$PRE_DIGEST" = "$POST_DIGEST" ] \
  || fail "the source volume's COLD content digest changed across the injected failure (${PRE_DIGEST} -> ${POST_DIGEST}) — the original was touched pre-commit."
[ "$(ledger_field "$LEDGER1" 'l.services["platform-redis"].image')" = "redis:${REDIS_FROM_TAG}" ] \
  || fail "after rollback the ledger must still carry the SOURCE entry."
[ "$(ledger_field "$LEDGER1" 'l.pending')" = "null" ] || fail "after rollback no pending journal may remain."
[ -z "$(docker volume ls -q --filter "name=${VOL1}-ufcand")" ] || fail "rollback leaked a candidate volume."
assert_probe "$VOL1" "$REDIS_FROM_TAG" yes
wa_info "rollback verified: source volume byte-identical under ${REDIS_FROM_TAG}, source ledger entry intact"

# ── 3. positive: guarded upgrade end to end ──────────────────────────────────
wa_info "positive: full guarded upgrade"
run_path "$VOL1" "$LEDGER1" || fail "guarded redis upgrade path failed (exit $?)."
[ "$(ledger_field "$LEDGER1" 'l.services["platform-redis"].image')" = "redis:${REDIS_TO_TAG}" ] \
  || fail "after commit the ledger must carry the TARGET entry."
[ "$(ledger_field "$LEDGER1" 'l.pending')" = "null" ] || fail "after commit no pending journal may remain."
assert_probe "$VOL1" "$REDIS_TO_TAG" yes
ls "$BACKUPS"/${SERVICE}-*.tar >/dev/null 2>&1 || fail "checksummed backup artifact missing."
ls "$BACKUPS"/${SERVICE}-*.tar.sha256 >/dev/null 2>&1 || fail "backup checksum file missing."
wa_info "upgrade verified: data + AOF survived onto ${REDIS_TO_TAG}; ledger committed; backup retained"

# ── 4. interrupted (post-commit): pending journal retained, fail-closed ──────
wa_info "interrupted: UPGRADE_INJECT_FAILURE=cutover-verify must retain the pending journal"
seed_fixture "$VOL2" "$LEDGER2"
rc=0; run_path "$VOL2" "$LEDGER2" UPGRADE_INJECT_FAILURE=cutover-verify || rc=$?
[ "$rc" -eq 4 ] || fail "injected cutover-verify failure exited ${rc}, expected post-commit interruption 4."
[ "$(ledger_field "$LEDGER2" 'l.pending && l.pending.service')" = "platform-redis" ] \
  || fail "an interrupted migration must RETAIN its pending ledger journal (fail-closed evidence)."
[ "$(ledger_field "$LEDGER2" 'l.pending.target.image')" = "redis:${REDIS_TO_TAG}" ] \
  || fail "the retained journal must record the TARGET image it was migrating to."
[ "$(ledger_field "$LEDGER2" 'l.services["platform-redis"].image')" = "redis:${REDIS_FROM_TAG}" ] \
  || fail "the live ledger entry must still be the SOURCE while interrupted."
[ -n "$(docker volume ls -q --filter "name=${VOL2}-ufcand")" ] \
  || fail "an interrupted migration must retain the candidate volume as recovery material."

echo "${_WA_GREEN}==> works-after upgrade-redis PASSED${_WA_RST} — guarded ${REDIS_FROM_TAG} -> ${REDIS_TO_TAG} path: fail-closed negatives, rollback lands on the intact source + source ledger, positive upgrade commits, interruption stays fail-closed."
