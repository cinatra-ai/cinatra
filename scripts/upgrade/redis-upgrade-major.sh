#!/usr/bin/env bash
# -E (errtrace): the transaction handler is an ERR trap and MUST fire for a
# failure inside a function (bash does not inherit ERR traps into functions
# without it — a begin refusal would otherwise exit with the raw ledger
# status, bypassing rollback and the documented exit-code contract).
set -Eeuo pipefail
# ============================================================================
# redis / valkey family — guarded engine upgrade path (cinatra#1421, epic
# cinatra#1419).
#
# Covers the RDB/AOF cache-queue engines (matrix ids `platform-redis`,
# `twenty-redis`, `plane-redis`). Eligibility is STRICTLY per the matrix — no
# blanket cross-major or cross-fork claim: the only supported hop today is
# platform-redis 7 -> 8 (forward-readable RDB/AOF); DOWNGRADES are explicitly
# unsupported (Redis 8 writes RDB v14, Redis 7 refuses it — the crash-loop
# class), and the valkey service has no supported non-hold transition, so any
# valkey hop fail-closes at resolve time. A cross-FORK swap (redis <-> valkey)
# is additionally blocked by pinning the engine image repo to the matrix
# service's baseline pin, and --from-tag/--to-tag must BIND to the resolved
# matrix versions (uf_require_tag_series).
#
# The matrix classes these volumes cache/queue with mechanism
# discard-recreate — the always-available fail-safe (clear the dump, recreate;
# regenerable state). THIS path is the DATA-PRESERVING guarded superset for
# the matrix-supported forward hops: it carries the RDB/AOF bytes forward
# under the same guarded-transaction frame instead of dropping in-flight
# BullMQ queue state, with the verified backup + intact source volume as
# rollback until the commit boundary.
#
# AOF IS HANDLED EXPLICITLY: the persistence mode is detected from the volume
# BEFORE any server starts (multi-part appendonlydir / legacy appendonly.aof /
# RDB-only); the throwaway servers run with the matching --appendonly flag
# (the flag lives in compose command args, not the volume — an implicit
# default would silently ignore the AOF); the backup tars the whole data dir
# (dump.rdb AND the AOF); post-verify asserts aof_enabled on the target when
# the source had AOF.
#
# DATA VERIFICATION is a FULL-STATE digest, not a key-name list: a server-side
# Lua pass (redis.sha1hex) over every non-empty database — sorted key names,
# each key's TYPE, persistence class (volatile/persistent), and a canonical
# LENGTH-PREFIX-FRAMED type-aware value serialization (string GET / hash
# sorted / list / set sorted / zset WITHSCORES / stream XRANGE; framing makes
# delimiter-byte collisions impossible) — deliberately NOT `DUMP` (whose
# encoding is version-dependent and would false-negative across the hop).
#
# THE GUARDED TRANSACTION (frame + exit-code contract: scripts/upgrade/lib.sh).
# The ORIGINAL volume is never server-mounted before the commit boundary — it
# is opened READ-ONLY (AOF detection + the clone) and untouched until cutover:
#   1. eligibility (matrix, fail-closed) + family + cross-fork image-repo block
#   2. quiesce + disk prechecks + explicit AOF detection (read-only)
#   3. ledger BEGIN (pending journal)
#   4. clone the source volume (READ-ONLY mount) to the CANDIDATE
#   5. verified backup OFF THE CANDIDATE: SOURCE-version server on the CLONE
#      (runtime redis_version must match the resolved --from series) ->
#      capture DBSIZE + the full-state digest -> synchronous SAVE -> clean
#      stop (exit 0) -> tar of the clone's /data (dump.rdb + AOF),
#      sha256-checksummed
#   6. migrate the CANDIDATE: start the TARGET version on it (same AOF flag)
#   7. post-verify the candidate: target redis_version series, DBSIZE + the
#      full-state digest equal the captured source state, aof_enabled when
#      the source had AOF, plus the caller's --verify-cmd read-back hook
#   8. COMMIT BOUNDARY -> cut over (wipe original + copy candidate in;
#      volume object and its ledger identity preserved)
#   9. post-cutover verify -> ledger COMMIT -> cleanup (candidate removal is
#      best-effort AFTER the commit; backup artifact stays in --backup-dir
#      under the operator's retention window)
#
# Rollback semantics are the frame's: pre-commit failure -> candidate removed,
# ledger rolled back (VERIFIED — a failed rollback exits 4 fail-closed with
# the journal retained), source volume untouched (exit 5); post-commit
# failure -> pending journal RETAINED (fail-closed interrupted) + candidate +
# backup kept (exit 4).
#
# Usage:
#   UPGRADE_LEDGER_FILE=… scripts/upgrade/redis-upgrade-major.sh \
#     --service platform-redis --volume cinatra-redis \
#     --from 7 --to 8 --from-tag 7-alpine --to-tag 8-alpine \
#     --backup-dir <dir> [--verify-cmd <cmd>]
#
# --from/--to are the MATRIX versions (majors); --from-tag/--to-tag the image
# tags to run (default <version>-alpine, matching the compose pins; a
# digest-bound `<tag>@sha256:…` pins the proof to exact bytes).
# ============================================================================

UF_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/upgrade/lib.sh
source "${UF_HERE}/lib.sh"

SERVICE="" VOLUME="" FROM="" TO="" FROM_TAG="" TO_TAG="" BACKUP_DIR="" VERIFY_CMD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --service|--volume|--from|--to|--from-tag|--to-tag|--backup-dir|--verify-cmd)
      [ $# -ge 2 ] || uf_die 2 "missing value for $1"
      case "$1" in
        --service)    SERVICE="$2" ;;
        --volume)     VOLUME="$2" ;;
        --from)       FROM="$2" ;;
        --to)         TO="$2" ;;
        --from-tag)   FROM_TAG="$2" ;;
        --to-tag)     TO_TAG="$2" ;;
        --backup-dir) BACKUP_DIR="$2" ;;
        --verify-cmd) VERIFY_CMD="$2" ;;
      esac
      shift 2 ;;
    *) uf_die 2 "unknown argument '$1'" ;;
  esac
done
[ -n "$SERVICE" ] && [ -n "$VOLUME" ] && [ -n "$FROM" ] && [ -n "$TO" ] && [ -n "$BACKUP_DIR" ] \
  || uf_die 2 "required: --service --volume --from --to --backup-dir"
command -v docker >/dev/null || uf_die 2 "docker is required"
command -v node   >/dev/null || uf_die 2 "node is required"
FROM_TAG="${FROM_TAG:-${FROM}-alpine}"
TO_TAG="${TO_TAG:-${TO}-alpine}"
uf_require_tag_series --from-tag "$FROM_TAG" "$FROM"
uf_require_tag_series --to-tag "$TO_TAG" "$TO"

# ── 1. eligibility (fail-closed) + family + cross-fork block ─────────────────
uf_log "redis/valkey guarded upgrade: ${SERVICE} ${FROM} -> ${TO} on volume '${VOLUME}'"
VERDICT_JSON="$(uf_resolve "$SERVICE" "$FROM" "$TO")"
echo "$VERDICT_JSON" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c));
  process.stdin.on("end", () => {
    const v = JSON.parse(s);
    if (v.service?.family !== "redis" && v.service?.family !== "valkey") {
      console.error(`FAIL-CLOSED: matrix family for ${v.serviceId} is ${v.service?.family}, not redis/valkey — wrong path for this service.`);
      process.exit(1);
    }
  });
' || uf_die 3 "family check refused (see above)."
IMAGE_REPO="$(uf_matrix_image_repo "$SERVICE")" || uf_die 3 "could not resolve the matrix image repo for ${SERVICE}"
SRC_IMAGE="${IMAGE_REPO}:${FROM_TAG}"
DST_IMAGE="${IMAGE_REPO}:${TO_TAG}"
uf_info "engine images per matrix (cross-fork pinned to '${IMAGE_REPO}'): ${SRC_IMAGE} -> ${DST_IMAGE}"

# ── 2. quiesce + prechecks ───────────────────────────────────────────────────
uf_volume_exists "$VOLUME" || uf_die 3 "volume '${VOLUME}' does not exist."
uf_require_quiesced "$VOLUME"
mkdir -p "$BACKUP_DIR"
uf_disk_precheck "$VOLUME" "$BACKUP_DIR"

# AOF detection — EXPLICIT, from the volume bytes (read-only), before any
# server starts.
AOF_MODE="no"
AOF_KIND="rdb-only"
if docker run --rm -v "${VOLUME}:/data:ro" alpine test -d /data/appendonlydir; then
  AOF_MODE="yes"; AOF_KIND="multi-part appendonlydir"
elif docker run --rm -v "${VOLUME}:/data:ro" alpine test -f /data/appendonly.aof; then
  AOF_MODE="yes"; AOF_KIND="legacy appendonly.aof"
fi
uf_info "persistence on '${VOLUME}': ${AOF_KIND} (servers will run --appendonly ${AOF_MODE})"

RUN_ID="uf-rds-$$"
SRC_C="${RUN_ID}-src"
CAND_C="${RUN_ID}-cand"
FIN_C="${RUN_ID}-fin"
CAND_VOL="${VOLUME}-ufcand-$$"
BACKUP_TAR="${BACKUP_DIR}/${SERVICE}-${FROM}-to-${TO}-$(date +%Y%m%d%H%M%S).tar"
PHASE="pre-commit"
LEDGER_BEGUN=0
CAND_CREATED=0

# Full-state digest, computed SERVER-SIDE per database: sorted key names, each
# key's TYPE + persistence class + a canonical type-aware value serialization,
# folded through redis.sha1hex. Version-stable across the hop (canonical READS,
# never DUMP — DUMP payloads embed the writer's RDB encoding).
read -r -d '' LUA_STATE_DIGEST <<'LUA' || true
-- frame(s): LENGTH-PREFIXED so no element/field byte sequence can collide
-- with a delimiter (a one-element list {"a:b"} never hashes like {"a","b"}).
local function frame(x) return string.format("%d:%s", #x, x) end
local function framecat(arr)
  local out = {}
  for i, e in ipairs(arr) do out[i] = frame(e) end
  return table.concat(out)
end
local cursor = "0"
local keys = {}
repeat
  local res = redis.call("SCAN", cursor, "COUNT", 1000)
  cursor = res[1]
  for _, k in ipairs(res[2]) do keys[#keys + 1] = k end
until cursor == "0"
table.sort(keys)
local parts = {}
for _, k in ipairs(keys) do
  local t = redis.call("TYPE", k)["ok"]
  local ttl = redis.call("PTTL", k)
  local ttlclass = (ttl == -1) and "persist" or "volatile"
  local v
  if t == "string" then
    v = frame(redis.call("GET", k))
  elseif t == "hash" then
    local h = redis.call("HGETALL", k)
    local fs = {}
    for i = 1, #h, 2 do fs[#fs + 1] = frame(h[i]) .. frame(h[i + 1]) end
    table.sort(fs)
    v = framecat(fs)
  elseif t == "list" then
    v = framecat(redis.call("LRANGE", k, 0, -1))
  elseif t == "set" then
    local m = redis.call("SMEMBERS", k)
    table.sort(m)
    v = framecat(m)
  elseif t == "zset" then
    v = framecat(redis.call("ZRANGE", k, 0, -1, "WITHSCORES"))
  elseif t == "stream" then
    local es = {}
    for _, e in ipairs(redis.call("XRANGE", k, "-", "+")) do
      es[#es + 1] = frame(e[1]) .. frame(framecat(e[2]))
    end
    v = framecat(es)
  else
    v = "unhandled-type:" .. t
  end
  parts[#parts + 1] = frame(k) .. t .. "|" .. ttlclass .. "|" .. redis.sha1hex(v)
end
return redis.sha1hex(table.concat(parts, "\n"))
LUA

rds_wait() {
  # rds_wait <container> <retries>
  local c="$1" n="${2:-30}" _
  for _ in $(seq 1 "$n"); do
    if [ "$(docker exec "$c" redis-cli ping 2>/dev/null)" = "PONG" ]; then return 0; fi
    sleep 1
  done
  return 1
}

rds_version() { docker exec "$1" redis-cli INFO server | tr -d '\r' | awk -F: '/^redis_version:/ {print $2}'; }
rds_dbsize()  { docker exec "$1" redis-cli dbsize; }

# rds_state_digest <container> — "<db>:<sha1>" per non-empty database, sorted.
rds_state_digest() {
  local c="$1" db out=""
  local dbs
  dbs="$(docker exec "$c" redis-cli INFO keyspace | tr -d '\r' | sed -n 's/^db\([0-9][0-9]*\):.*/\1/p' | sort -n)"
  if [ -z "$dbs" ]; then echo "empty"; return 0; fi
  for db in $dbs; do
    out="${out}${db}:$(docker exec "$c" redis-cli -n "$db" EVAL "$LUA_STATE_DIGEST" 0) "
  done
  echo "$out"
}

# rds_verify <container> — post-verify battery against the captured source state.
rds_verify() {
  local c="$1" v size digest
  v="$(rds_version "$c")"
  case "$v" in
    "${TO}."*) uf_info "redis_version on '${c}': ${v} (matches target series ${TO})" ;;
    *) uf_warn "redis_version on '${c}' is '${v}', expected ${TO}.*"; return 1 ;;
  esac
  size="$(rds_dbsize "$c")"
  [ "$size" = "$SRC_DBSIZE" ] || { uf_warn "DBSIZE on '${c}' is ${size}, source had ${SRC_DBSIZE}"; return 1; }
  digest="$(rds_state_digest "$c")"
  [ "$digest" = "$SRC_DIGEST" ] || { uf_warn "full-state digest mismatch on '${c}' (got '${digest}', source '${SRC_DIGEST}')"; return 1; }
  if [ "$AOF_MODE" = "yes" ]; then
    # NOT `grep -q` (pipefail + early exit can SIGPIPE the upstream writer).
    docker exec "$c" redis-cli INFO persistence | tr -d '\r' | grep '^aof_enabled:1' >/dev/null \
      || { uf_warn "source had AOF but aof_enabled is not 1 on '${c}' — AOF was silently dropped"; return 1; }
  fi
  if [ -n "$VERIFY_CMD" ]; then
    UF_VERIFY_CONTAINER="$c" bash -c "$VERIFY_CMD" \
      || { uf_warn "--verify-cmd content read-back failed on '${c}'"; return 1; }
  fi
}

# rds_clean_stop <container> — SIGTERM stop; assert exit code 0.
rds_clean_stop() {
  local c="$1" rc
  docker stop -t 30 "$c" >/dev/null
  rc="$(docker inspect -f '{{.State.ExitCode}}' "$c")"
  [ "$rc" = "0" ] || { uf_warn "redis '${c}' exited ${rc} on stop (not a clean shutdown)"; return 1; }
}

cleanup_containers() { docker rm -f "$SRC_C" "$CAND_C" "$FIN_C" >/dev/null 2>&1 || true; }

on_err() {
  local line="$1" rc="${2:-1}"
  # In a SUBSHELL (command substitution / pipeline element — errtrace makes
  # the trap fire there too), do NOTHING: propagate the status and let the
  # MAIN shell's trap run the transaction handling exactly once.
  # BASH_SUBSHELL (not BASHPID): stock macOS bash 3.2 has no BASHPID, which
  # would silently disable this guard there and double-run the handler.
  if [ "${BASH_SUBSHELL:-0}" -gt 0 ]; then exit "$rc"; fi
  echo "${_UF_RED}FAILURE (line ${line}, phase ${PHASE})${_UF_RST}" >&2
  cleanup_containers
  if [ "$PHASE" = "pre-commit" ]; then
    # A failure BEFORE this run opened a journal can only be the `begin` call
    # itself (everything earlier refuses via uf_die): nothing was mutated and
    # there is nothing to roll back — report a fail-closed refusal (exit 3),
    # NEVER a "rolled back" result (a pre-existing pending journal, the usual
    # begin refusal, must stay exactly as it was found).
    if [ "$LEDGER_BEGUN" != "1" ]; then
      uf_warn "aborted before this run opened a ledger journal — nothing was mutated and nothing was rolled back; see the ledger refusal above."
      exit 3
    fi
    # Roll back ONLY the journal THIS run opened — and VERIFY it: a failed
    # rollback is a retained journal, i.e. the fail-closed interrupted state.
    if ! uf_ledger_rollback "$SERVICE" "$DST_IMAGE" "$VOLUME"; then
      uf_warn "LEDGER ROLLBACK FAILED — the pending journal is RETAINED (fail-closed interrupted state). The source volume '${VOLUME}' itself is intact (it was only ever opened read-only); the candidate '${CAND_VOL}' is kept as evidence. Resolve the ledger before any retry."
      exit 4
    fi
    uf_warn "pre-commit abort: rolled back — source volume '${VOLUME}' is intact (it was only ever opened read-only for AOF detection + the clone) and the ledger carries the source entry again."
    # Remove ONLY a candidate THIS run created (never a leftover it refused).
    if [ "$CAND_CREATED" = "1" ]; then
      docker volume rm "$CAND_VOL" >/dev/null 2>&1 || true
    fi
    exit 5
  fi
  uf_warn "POST-COMMIT INTERRUPTION: the pending ledger journal is RETAINED (fail-closed 'interrupted migration'); the candidate volume '${CAND_VOL}' and the checksummed backup '${BACKUP_TAR}' are kept as recovery material."
  uf_warn "Recovery: re-run the cutover copy from '${CAND_VOL}' (or restore the backup tar), verify, then commit the ledger."
  exit 4
}
trap 'on_err $LINENO $?' ERR
# The throwaway servers are ALWAYS safe to remove, whatever the exit shape —
# a surviving one would also pin its volume against the caller's sweep.
# (Volume retention is phase-dependent and stays in on_err/success handling.)
trap cleanup_containers EXIT

# ── 3. ledger BEGIN ──────────────────────────────────────────────────────────
uf_ledger_begin "$SERVICE" "$DST_IMAGE" "$VOLUME"
LEDGER_BEGUN=1

# ── 4. clone the source volume (READ-ONLY) to the CANDIDATE ──────────────────
uf_log "cloning '${VOLUME}' (read-only) -> candidate '${CAND_VOL}' — the original is not touched again until cutover"
uf_candidate_create "$CAND_VOL"
CAND_CREATED=1
uf_copy_into_volume "$VOLUME" "$CAND_VOL"

# ── 5. verified backup OFF THE CANDIDATE ─────────────────────────────────────
uf_log "starting throwaway ${SRC_IMAGE} on the CANDIDATE for state capture + durable save"
docker run -d --name "$SRC_C" -v "${CAND_VOL}:/data" "$SRC_IMAGE" redis-server --appendonly "$AOF_MODE" >/dev/null
rds_wait "$SRC_C" || { uf_warn "source redis never answered PONG on the candidate clone — is '${VOLUME}' really a ${FROM} data dir?"; false; }
SRC_V="$(rds_version "$SRC_C")"
case "$SRC_V" in
  "${FROM}."*) uf_info "source redis_version: ${SRC_V} (matches resolved series ${FROM})" ;;
  *) uf_warn "source image runs redis_version '${SRC_V}', but eligibility was resolved for ${FROM}.* — refusing (invocation contract)"; false ;;
esac
SRC_DBSIZE="$(rds_dbsize "$SRC_C")"
SRC_DIGEST="$(rds_state_digest "$SRC_C")"
uf_info "captured source state: DBSIZE=${SRC_DBSIZE}, full-state digest ${SRC_DIGEST}"
docker exec "$SRC_C" redis-cli save >/dev/null
rds_clean_stop "$SRC_C"
docker rm -f "$SRC_C" >/dev/null

uf_log "verified backup: tar of the clone's /data (dump.rdb + AOF) -> ${BACKUP_TAR}"
docker run --rm -v "${CAND_VOL}:/data:ro" alpine tar -cf - -C /data . > "$BACKUP_TAR"
[ -s "$BACKUP_TAR" ] || { uf_warn "backup tar is empty"; false; }
uf_write_checksum "$BACKUP_TAR"
uf_verify_checksum "$BACKUP_TAR" || { uf_warn "backup checksum verification failed"; false; }
uf_inject backup-verify
uf_info "backup verified ($(wc -c < "$BACKUP_TAR" | tr -d ' ') bytes, sha256 recorded)"

# ── 6. migrate the CANDIDATE ─────────────────────────────────────────────────
uf_log "starting ${DST_IMAGE} on the CANDIDATE (--appendonly ${AOF_MODE})"
docker run -d --name "$CAND_C" -v "${CAND_VOL}:/data" "$DST_IMAGE" redis-server --appendonly "$AOF_MODE" >/dev/null
rds_wait "$CAND_C" || { uf_warn "target redis did not come up on the candidate"; false; }

# ── 7. post-verify the candidate ─────────────────────────────────────────────
uf_log "post-verify on the candidate"
rds_verify "$CAND_C"
uf_inject post-verify
rds_clean_stop "$CAND_C"
docker rm -f "$CAND_C" >/dev/null

# ── 8. COMMIT BOUNDARY — cut over ────────────────────────────────────────────
uf_log "COMMIT BOUNDARY: candidate verified — cutting over onto '${VOLUME}' (volume identity preserved)"
PHASE="post-commit"
uf_wipe_volume "$VOLUME"
uf_copy_into_volume "$CAND_VOL" "$VOLUME"

# ── 9. post-cutover verify -> ledger COMMIT ──────────────────────────────────
uf_log "post-cutover verify on '${VOLUME}'"
docker run -d --name "$FIN_C" -v "${VOLUME}:/data" "$DST_IMAGE" redis-server --appendonly "$AOF_MODE" >/dev/null
rds_wait "$FIN_C" || { uf_warn "target redis did not come up on the cut-over volume"; false; }
rds_verify "$FIN_C"
uf_inject cutover-verify
rds_clean_stop "$FIN_C"
docker rm -f "$FIN_C" >/dev/null

uf_ledger_commit "$SERVICE" "$DST_IMAGE" "$VOLUME"
# Best-effort AFTER the commit: a failed removal must not masquerade as an
# interrupted migration (the journal is already cleared).
docker volume rm "$CAND_VOL" >/dev/null 2>&1 \
  || uf_warn "could not remove the candidate volume '${CAND_VOL}' — remove it manually (the upgrade itself is committed)."
uf_log "${_UF_GREEN}DONE${_UF_RST}: ${SERVICE} upgraded ${FROM} -> ${TO}; ledger committed; backup retained at ${BACKUP_TAR} (+.sha256) under the operator's retention window."
