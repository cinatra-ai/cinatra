#!/usr/bin/env bash
# -E (errtrace): the transaction handler is an ERR trap and MUST fire for a
# failure inside a function (bash does not inherit ERR traps into functions
# without it — a begin refusal would otherwise exit with the raw ledger
# status, bypassing rollback and the documented exit-code contract).
set -Eeuo pipefail
# ============================================================================
# Postgres family — guarded major-version upgrade path (cinatra#1422, epic
# cinatra#1419). The executable mechanism behind `cinatra instance db
# upgrade-major` (cinatra-cli#129): the CLI resolves the instance + eligibility
# and drives THIS frame with its deployed-version ledger wired in through
# UPGRADE_LEDGER_HOOK; the works-after upgrade-from arm
# (scripts/ci/works-after/upgrade-postgres.sh) drives it with the file ledger
# and real docker to PROVE it.
#
# Covers the four Postgres services (matrix ids platform-postgres /
# nango-postgres / twenty-postgres / plane-postgres; mechanism
# logical-dump-restore). Postgres major upgrades are NOT in-place (an N image
# refuses an N-1 cluster); the sanctioned path is a LOGICAL dump under the
# source major -> a FRESH target-major volume -> restore. pg_dump crosses any
# source major in one hop, so a skipped major (the nango 15->17 case exception,
# cinatra#1417) rides the same path. Eligibility is resolved fail-closed against
# docs/architecture/upgrade-matrix.json BEFORE anything is touched.
#
# THE PG18 MOUNT-LAYOUT MOVE. The volume mount target is dictated by each SIDE's
# major (docker-library/postgres#1259): <=17 keeps the legacy .../data child
# mount; >=18 moved PGDATA to <major>/docker and requires the PARENT mount. So a
# 17->18 hop MOVES layouts (source legacy, target parent); the nango 15->17 case
# stays legacy on both sides. Both are handled here.
#
# THE GUARDED TRANSACTION (frame + exit-code contract: scripts/upgrade/lib.sh).
# The ORIGINAL volume is never server-mounted before the commit boundary — it is
# opened READ-ONLY exactly once (the clone) and untouched until cutover:
#   1. eligibility: matrix verdict supported + mechanism logical-dump-restore +
#      family postgres; the image repo comes from the matrix service and
#      --from-tag/--to-tag must BIND to the resolved matrix majors.
#   2. quiesce: no container may still reference the volume; disk prechecks.
#   3. ledger BEGIN (pending journal; the live entry stays the source).
#   4. clone the source volume (READ-ONLY) to the CANDIDATE.
#   5. verified backup OFF THE CANDIDATE: a throwaway SOURCE-major server runs on
#      the CLONE (recovery, if any, happens on the clone — the original is never
#      dirtied); its runtime server_version must match --from; then a
#      `pg_dumpall` (globals + all databases) — pipeline-failure detected,
#      sha256-checksummed, disk-space prechecked; clean stop.
#   6. restore into a FRESH TARGET-major volume: a fresh TARGET cluster is
#      initialised on a NEW volume at the target-major mount, the checksummed
#      dump is restored (psql; pg_dumpall's re-CREATE of the bootstrap superuser
#      is a benign already-exists, the standard pg_dumpall restore posture).
#   7. post-verify the target: server_version matches --to + the caller's
#      --verify-cmd content read-back (run with UF_VERIFY_CONTAINER set).
#   8. COMMIT BOUNDARY -> cut over: the original volume is wiped and the fresh
#      target's bytes are copied in (the volume OBJECT — and its {name,createdAt}
#      ledger identity — is preserved; compose keeps the same named volume,
#      remounted at the target-major target).
#   9. post-cutover verify (target server on the cut-over volume) -> ledger
#      COMMIT -> cleanup (candidate + target volumes removed best-effort AFTER
#      the commit; the dump stays in --backup-dir under the operator's window).
#
# ROLLBACK / RETENTION (identical to the family frame): a pre-commit failure
# rolls back — candidate + target removed, ledger restored (VERIFIED: a failed
# rollback exits 4 with the journal retained), source volume untouched (exit 5).
# A failure at/after cutover leaves the PENDING journal (fail-closed
# "interrupted"), the target volume, and the dump as recovery material (exit 4).
#
# Usage:
#   UPGRADE_LEDGER_FILE=… scripts/upgrade/postgres-upgrade-major.sh \
#     --service platform-postgres --volume cinatra-postgres \
#     --from 17 --to 18 [--from-tag 17-alpine] [--to-tag 18-alpine[@sha256:…]] \
#     --backup-dir <dir> [--superuser postgres] [--verify-cmd <cmd>]
#
# --from/--to are the MATRIX majors; --from-tag/--to-tag the image tags to RUN
# (default <major>-alpine; a digest-bound tag pins the proof to exact bytes).
# --superuser is the cluster superuser for the dump/restore (default postgres;
# nango uses nango). Connections are LOCAL (docker exec -> unix socket -> the
# official image's `local all all trust`), so no password crosses argv/env.
# ============================================================================

UF_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/upgrade/lib.sh
source "${UF_HERE}/lib.sh"

SERVICE="" VOLUME="" FROM="" TO="" FROM_TAG="" TO_TAG="" BACKUP_DIR="" VERIFY_CMD="" SUPERUSER="postgres"
while [ $# -gt 0 ]; do
  case "$1" in
    --service|--volume|--from|--to|--from-tag|--to-tag|--backup-dir|--verify-cmd|--superuser)
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
        --superuser)  SUPERUSER="$2" ;;
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

# The pg mount target is dictated by the MAJOR: <=17 legacy .../data, >=18 parent.
pg_mount_target() { if [ "${1%%[.-]*}" -le 17 ]; then echo "/var/lib/postgresql/data"; else echo "/var/lib/postgresql"; fi; }
SRC_MOUNT="$(pg_mount_target "$FROM")"
DST_MOUNT="$(pg_mount_target "$TO")"

# ── 1. eligibility (fail-closed, BEFORE any mutation) ────────────────────────
uf_log "postgres guarded upgrade: ${SERVICE} ${FROM} -> ${TO} on volume '${VOLUME}' (mount ${SRC_MOUNT} -> ${DST_MOUNT})"
VERDICT_JSON="$(uf_resolve "$SERVICE" "$FROM" "$TO")"
echo "$VERDICT_JSON" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c));
  process.stdin.on("end", () => {
    const v = JSON.parse(s);
    if (v.mechanism !== "logical-dump-restore") {
      console.error(`FAIL-CLOSED: matrix mechanism for this transition is ${v.mechanism}, not logical-dump-restore — wrong path for this service.`);
      process.exit(1);
    }
    if (v.service?.family !== "postgres") {
      console.error(`FAIL-CLOSED: matrix family for ${v.serviceId} is ${v.service?.family}, not postgres — wrong path for this service.`);
      process.exit(1);
    }
  });
' || uf_die 3 "mechanism/family check refused (see above)."
IMAGE_REPO="$(uf_matrix_image_repo "$SERVICE")" || uf_die 3 "could not resolve the matrix image repo for ${SERVICE}"
SRC_IMAGE="${IMAGE_REPO}:${FROM_TAG}"
DST_IMAGE="${IMAGE_REPO}:${TO_TAG}"
uf_info "engine images per matrix: ${SRC_IMAGE} -> ${DST_IMAGE}"

# ── 2. quiesce + prechecks ───────────────────────────────────────────────────
uf_volume_exists "$VOLUME" || uf_die 3 "volume '${VOLUME}' does not exist."
uf_require_quiesced "$VOLUME"
mkdir -p "$BACKUP_DIR"
uf_disk_precheck "$VOLUME" "$BACKUP_DIR"

RUN_ID="uf-pg-$$"
SRC_C="${RUN_ID}-src"
DST_C="${RUN_ID}-dst"
FIN_C="${RUN_ID}-fin"
CAND_VOL="${VOLUME}-ufcand-$$"
TARGET_VOL="${VOLUME}-uftarget-$$"
DUMP="${BACKUP_DIR}/${SERVICE}-${FROM}-to-${TO}-$(date +%Y%m%d%H%M%S).sql"
PHASE="pre-commit"
LEDGER_BEGUN=0
CAND_CREATED=0
TARGET_CREATED=0

pg_wait() {
  # pg_wait <container> <retries> — the cluster answers pg_isready.
  local c="$1" n="${2:-45}" _
  for _ in $(seq 1 "$n"); do
    if docker exec "$c" pg_isready -U "$SUPERUSER" -q >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# pg_server_major <container> — the running server's major (SHOW server_version).
pg_server_major() {
  docker exec "$1" psql -U "$SUPERUSER" -d postgres -tAc "SHOW server_version" 2>/dev/null | sed -E 's/^([0-9]+).*/\1/'
}

pg_require_major() {
  # pg_require_major <container> <major> <what>
  local c="$1" want="$2" what="$3" got
  got="$(pg_server_major "$c")"
  [ "$got" = "$want" ] && { uf_info "server_version major on '${c}': ${got} (matches ${what} ${want})"; return 0; }
  uf_warn "server_version major on '${c}' is '${got}', expected ${what} ${want}"; return 1
}

# pg_fingerprint <container> — a deterministic CONTENT digest: for every
# connectable non-template database, every user table (schema.table) and its
# EXACT row count, sorted. Captured on the SOURCE and asserted byte-for-byte on
# the target + cut-over volume, so a PARTIAL restore — a missing database, a
# missing table, OR a table that lost rows (e.g. a COPY that failed mid-stream,
# which pg_dumpall restore can survive with a non-fatal exit) — is caught. A
# bare server-version check would pass a half-restored cluster. (Indexes /
# constraints / sequences are re-asserted by the app's own boot migrations after
# the upgrade; this guard is the DATA-LOSS gate.) The row count for a table with
# no rows is 0, so a dropped table (absent from the list) and an emptied table
# (present, count 0) both diverge from the source.
pg_fingerprint() {
  local c="$1" db tbl out="" dbs tbls cnt schema table
  dbs="$(docker exec "$c" psql -U "$SUPERUSER" -d postgres -tAc \
    "SELECT datname FROM pg_database WHERE datallowconn AND datname NOT IN ('template0','template1') ORDER BY datname" 2>/dev/null)"
  for db in $dbs; do
    tbls="$(docker exec "$c" psql -U "$SUPERUSER" -d "$db" -tAc \
      "SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1" 2>/dev/null)"
    for tbl in $tbls; do
      schema="${tbl%%.*}"; table="${tbl#*.}"
      cnt="$(docker exec "$c" psql -U "$SUPERUSER" -d "$db" -tAc \
        "SELECT count(*) FROM \"${schema}\".\"${table}\"" 2>/dev/null)"
      out="${out}${db}.${tbl}=${cnt};"
    done
  done
  echo "$out"
}

pg_verify() {
  # pg_verify <container> — target major + STRUCTURAL parity against the source +
  # the caller's content read-back.
  local c="$1" fp
  pg_require_major "$c" "$TO" "target" || return 1
  fp="$(pg_fingerprint "$c")"
  [ "$fp" = "$SRC_FP" ] || { uf_warn "structural fingerprint mismatch on '${c}' (got '${fp}', source '${SRC_FP}') — the restore is incomplete; refusing"; return 1; }
  if [ -n "$VERIFY_CMD" ]; then
    UF_VERIFY_CONTAINER="$c" UF_SUPERUSER="$SUPERUSER" bash -c "$VERIFY_CMD" \
      || { uf_warn "--verify-cmd content read-back failed on '${c}'"; return 1; }
  fi
}

pg_clean_stop() {
  # pg_clean_stop <container> — SIGINT is postgres' fast/clean shutdown; assert 0.
  local c="$1" rc
  docker stop -t 60 "$c" >/dev/null
  rc="$(docker inspect -f '{{.State.ExitCode}}' "$c")"
  [ "$rc" = "0" ] || { uf_warn "server '${c}' exited ${rc} on stop (not a clean shutdown)"; return 1; }
}

cleanup_containers() { docker rm -f "$SRC_C" "$DST_C" "$FIN_C" >/dev/null 2>&1 || true; }

on_err() {
  local line="$1" rc="${2:-1}"
  # In a SUBSHELL (command substitution / pipeline element — errtrace makes the
  # trap fire there too), do NOTHING: propagate the status and let the MAIN
  # shell's trap run the transaction handling exactly once. BASH_SUBSHELL (not
  # BASHPID): stock macOS bash 3.2 has no BASHPID.
  if [ "${BASH_SUBSHELL:-0}" -gt 0 ]; then exit "$rc"; fi
  echo "${_UF_RED}FAILURE (line ${line}, phase ${PHASE})${_UF_RST}" >&2
  cleanup_containers
  if [ "$PHASE" = "pre-commit" ]; then
    if [ "$LEDGER_BEGUN" != "1" ]; then
      uf_warn "aborted before this run opened a ledger journal — nothing was mutated and nothing was rolled back; see the ledger refusal above."
      exit 3
    fi
    if ! uf_ledger_rollback "$SERVICE" "$DST_IMAGE" "$VOLUME"; then
      uf_warn "LEDGER ROLLBACK FAILED — the pending journal is RETAINED (fail-closed interrupted state). The source volume '${VOLUME}' itself is intact (it was only ever opened read-only); the target '${TARGET_VOL}' is kept as evidence. Resolve the ledger before any retry."
      exit 4
    fi
    uf_warn "pre-commit abort: rolled back — source volume '${VOLUME}' is intact (it was only ever opened read-only for the clone) and the ledger carries the source entry again."
    [ "$CAND_CREATED" = "1" ] && docker volume rm "$CAND_VOL" >/dev/null 2>&1 || true
    [ "$TARGET_CREATED" = "1" ] && docker volume rm "$TARGET_VOL" >/dev/null 2>&1 || true
    exit 5
  fi
  uf_warn "POST-COMMIT INTERRUPTION: the pending ledger journal is RETAINED (fail-closed 'interrupted migration'); the target volume '${TARGET_VOL}' and the checksummed dump '${DUMP}' are kept as recovery material."
  uf_warn "Recovery: re-run the cutover copy from '${TARGET_VOL}' (or restore the dump into a fresh target volume), verify, then commit the ledger."
  exit 4
}
trap 'on_err $LINENO $?' ERR
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
uf_log "starting throwaway ${SRC_IMAGE} on the CANDIDATE for the verified backup (mount ${SRC_MOUNT})"
docker run -d --name "$SRC_C" -v "${CAND_VOL}:${SRC_MOUNT}" \
  -e POSTGRES_PASSWORD=uf -e POSTGRES_USER="$SUPERUSER" "$SRC_IMAGE" >/dev/null
pg_wait "$SRC_C" || { uf_warn "source server never became ready on the candidate clone — is '${VOLUME}' really a pg${FROM} data dir?"; false; }
pg_require_major "$SRC_C" "$FROM" "source"
# Capture the SOURCE structural fingerprint the target/cut-over volume must match
# (the partial-restore guard) BEFORE the dump.
SRC_FP="$(pg_fingerprint "$SRC_C")"
uf_info "source structural fingerprint: ${SRC_FP}"

uf_log "pg_dumpall (globals + all databases) -> ${DUMP}"
docker exec "$SRC_C" pg_dumpall -U "$SUPERUSER" --clean --if-exists > "$DUMP"
[ -s "$DUMP" ] || { uf_warn "dump is empty"; false; }
grep -q "PostgreSQL database dump" "$DUMP" || { uf_warn "dump has no pg_dumpall banner — not a plausible full dump"; false; }
uf_write_checksum "$DUMP"
uf_verify_checksum "$DUMP" || { uf_warn "dump checksum verification failed"; false; }
uf_inject backup-verify
uf_info "dump verified ($(wc -c < "$DUMP" | tr -d ' ') bytes, sha256 recorded)"
pg_clean_stop "$SRC_C"
docker rm -f "$SRC_C" >/dev/null

# ── 6. restore into a FRESH TARGET-major volume ──────────────────────────────
uf_log "fresh pg${TO} cluster on new volume '${TARGET_VOL}' (mount ${DST_MOUNT}) + restore"
uf_candidate_create "$TARGET_VOL"
TARGET_CREATED=1
docker run -d --name "$DST_C" -v "${TARGET_VOL}:${DST_MOUNT}" \
  -e POSTGRES_PASSWORD=uf -e POSTGRES_USER="$SUPERUSER" "$DST_IMAGE" >/dev/null
pg_wait "$DST_C" || { uf_warn "fresh target server did not become ready"; false; }
uf_verify_checksum "$DUMP" || { uf_warn "dump checksum no longer verifies — refusing the restore"; false; }
# pg_dumpall restore via psql: the fresh cluster's bootstrap superuser is
# re-CREATEd by the dump (benign already-exists — the standard pg_dumpall restore
# posture), so ON_ERROR_STOP is OFF for per-statement tolerance. But psql's own
# EXIT status is captured: without ON_ERROR_STOP psql exits non-zero ONLY on a
# CONNECTION/fatal failure (e.g. the server dropping mid-restore), which is a
# real restore failure that must NOT be swallowed. A partial restore that still
# exits 0 is caught by the structural-fingerprint parity in pg_verify below.
RESTORE_RC=0
docker exec -i "$DST_C" psql -U "$SUPERUSER" -d postgres -v ON_ERROR_STOP=0 < "$DUMP" >/dev/null 2>&1 || RESTORE_RC=$?
[ "$RESTORE_RC" -eq 0 ] || { uf_warn "psql restore exited ${RESTORE_RC} — a fatal/connection failure mid-restore; refusing to proceed"; false; }
uf_inject restore
docker restart -t 60 "$DST_C" >/dev/null
pg_wait "$DST_C" || { uf_warn "target server did not come back after the restore"; false; }

# ── 7. post-verify the target ────────────────────────────────────────────────
uf_log "post-verify on the fresh target"
pg_verify "$DST_C"
uf_inject post-verify
pg_clean_stop "$DST_C"
docker rm -f "$DST_C" >/dev/null

# ── 8. COMMIT BOUNDARY — cut over ────────────────────────────────────────────
uf_log "COMMIT BOUNDARY: target verified — cutting over onto '${VOLUME}' (volume identity preserved)"
PHASE="post-commit"
uf_wipe_volume "$VOLUME"
uf_copy_into_volume "$TARGET_VOL" "$VOLUME"

# ── 9. post-cutover verify -> ledger COMMIT ──────────────────────────────────
uf_log "post-cutover verify on '${VOLUME}' (mount ${DST_MOUNT})"
docker run -d --name "$FIN_C" -v "${VOLUME}:${DST_MOUNT}" \
  -e POSTGRES_PASSWORD=uf -e POSTGRES_USER="$SUPERUSER" "$DST_IMAGE" >/dev/null
pg_wait "$FIN_C" || { uf_warn "target server did not become ready on the cut-over volume"; false; }
pg_verify "$FIN_C"
uf_inject cutover-verify
pg_clean_stop "$FIN_C"
docker rm -f "$FIN_C" >/dev/null

uf_ledger_commit "$SERVICE" "$DST_IMAGE" "$VOLUME"
# Best-effort AFTER the commit: a failed removal must not masquerade as an
# interrupted migration (the journal is already cleared).
docker volume rm "$CAND_VOL" "$TARGET_VOL" >/dev/null 2>&1 \
  || uf_warn "could not remove a retired volume (${CAND_VOL}/${TARGET_VOL}) — remove it manually (the upgrade itself is committed)."
uf_log "${_UF_GREEN}DONE${_UF_RST}: ${SERVICE} upgraded ${FROM} -> ${TO}; ledger committed; backup retained at ${DUMP} (+.sha256) under the operator's retention window."
