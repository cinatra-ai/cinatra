#!/usr/bin/env bash
# -E (errtrace): the transaction handler is an ERR trap and MUST fire for a
# failure inside a function (bash does not inherit ERR traps into functions
# without it — a begin refusal would otherwise exit with the raw ledger
# status, bypassing rollback and the documented exit-code contract).
set -Eeuo pipefail
# ============================================================================
# MariaDB family — guarded engine upgrade path (cinatra#1421, epic cinatra#1419).
#
# Covers the two MariaDB services (matrix ids `wordpress-mariadb`,
# `drupal-mariadb`; both pinned mariadb:11.4). MariaDB engine upgrades are
# IN-PLACE (`mariadb-upgrade` against the data dir) and SEQUENTIAL-ONLY across
# release series — the supported source ranges are exactly the matrix's
# transitions (11.4 -> 11.8 today; 11.4 -> 12.0 is fail-closed until 11.8 is
# stepped through). Eligibility is resolved fail-closed against
# config/upgrade/upgrade-matrix.json before anything is touched.
#
# THE GUARDED TRANSACTION (frame + exit-code contract: scripts/upgrade/lib.sh).
# The ORIGINAL volume is never server-mounted before the commit boundary — it
# is opened READ-ONLY exactly once (the clone) and untouched until cutover:
#   1. eligibility: matrix verdict must be supported + mechanism
#      in-place-store-format; the image repo comes from the matrix service (no
#      cross-engine swap) and --from-tag/--to-tag must BIND to the resolved
#      matrix versions (uf_require_tag_series).
#   2. quiesce: no container may still reference the volume (the deployment
#      stops its writers first; WordPress/Drupal schema upgrades are the APPS'
#      own job at next boot — this path migrates the ENGINE only).
#   3. ledger BEGIN (pending journal; the live entry stays the source).
#   4. clone the source volume (READ-ONLY mount) to the CANDIDATE.
#   5. verified backup OFF THE CANDIDATE: a throwaway SOURCE-version server
#      runs on the CLONE (crash recovery, if any, happens on the clone — the
#      original is never dirtied); its runtime VERSION() must match the
#      resolved --from series (invocation-contract check); then
#      `mariadb-dump --all-databases` — pipeline-failure detected,
#      sha256-checksummed, disk-space prechecked. The dump doubles as the
#      DUMP/RESTORE FALLBACK input and as post-interrupt recovery material.
#      CLEAN-SHUTDOWN REQUIREMENT: the clone's server is shut down with
#      innodb_fast_shutdown=0 (full purge + change-buffer merge — the state
#      mariadb-upgrade expects) and the frame asserts exit code 0 + the
#      server's own shutdown-complete log line.
#   6. migrate the CANDIDATE: the TARGET-version server starts on the clone
#      and `mariadb-upgrade` runs there EXPLICITLY. The official image's
#      entrypoint auto-upgrade (MARIADB_AUTO_UPGRADE) is deliberately NOT
#      used: pinned-down behavior means the upgrade step's exit status is
#      asserted by THIS frame, not implied by an entrypoint side effect.
#      FALLBACK: if in-place `mariadb-upgrade` fails, the candidate is rebuilt
#      by dump/restore — fresh TARGET-version init on a wiped candidate,
#      restore of the checksum-verified dump, then `mariadb-upgrade` again
#      (system tables from the dump are older-form), a healthcheck-credential
#      re-align (the restore replaced mysql.global_priv), and a restart.
#   7. post-verify the candidate: SELECT VERSION() matches the target series,
#      `mariadb-check --all-databases` is clean, plus the caller's
#      --verify-cmd content read-back hook (run with UF_VERIFY_CONTAINER set).
#   8. COMMIT BOUNDARY -> cut over: the original volume is wiped and the
#      candidate's bytes are copied in (the volume OBJECT — and its
#      {name, createdAt} ledger identity — is preserved; compose keeps
#      pointing at the same named volume).
#   9. post-cutover verify (same checks, on the original volume) -> ledger
#      COMMIT -> cleanup (candidate removal is best-effort AFTER the commit).
#
# ROLLBACK / RETENTION: any failure before the commit boundary rolls back —
# candidate removed, ledger restored (VERIFIED: a failed rollback exits 4
# fail-closed with the journal retained, never a false "clean abort"), source
# volume untouched (exit 5). A failure at/after cutover leaves the PENDING
# ledger journal (the fail-closed "interrupted" finding), the intact candidate
# volume, and the checksummed dump as recovery material (exit 4). After a
# successful commit the candidate volume is removed (best-effort); the dump
# artifact stays in --backup-dir under the operator's own retention window.
#
# Usage:
#   UPGRADE_MARIADB_ROOT_PASSWORD=… UPGRADE_LEDGER_FILE=… \
#   scripts/upgrade/mariadb-upgrade-major.sh \
#     --service wordpress-mariadb --volume cinatra-wordpress-db \
#     --from 11.4 --to 11.8 --backup-dir <dir> \
#     [--from-tag <tag[@digest]>] [--to-tag <tag[@digest]>] [--verify-cmd <cmd>]
#
# --from/--to are the MATRIX versions (release series); --from-tag/--to-tag are
# the image tags to RUN, defaulting to the bare series tag — a caller (the
# upgrade-from fixture) passes digest-bound tags (e.g. `11.4@sha256:…`) so the
# proof is pinned to exact bytes. A tag is always appended to the MATRIX
# service's image repo AND must bind to its resolved series, so a pin can
# neither smuggle in a different engine nor a different version.
#
# The root password comes from the ENVIRONMENT (never argv) and is forwarded
# to in-container clients via MYSQL_PWD on `docker exec` only.
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
[ -n "${UPGRADE_MARIADB_ROOT_PASSWORD:-}" ] || uf_die 2 "UPGRADE_MARIADB_ROOT_PASSWORD must be set (root credentials for dump/upgrade/check; env-only, never argv)"
FROM_TAG="${FROM_TAG:-${FROM}}"
TO_TAG="${TO_TAG:-${TO}}"
uf_require_tag_series --from-tag "$FROM_TAG" "$FROM"
uf_require_tag_series --to-tag "$TO_TAG" "$TO"

# ── 1. eligibility (fail-closed, BEFORE any mutation) ────────────────────────
uf_log "mariadb guarded upgrade: ${SERVICE} ${FROM} -> ${TO} on volume '${VOLUME}'"
VERDICT_JSON="$(uf_resolve "$SERVICE" "$FROM" "$TO")"
echo "$VERDICT_JSON" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c));
  process.stdin.on("end", () => {
    const v = JSON.parse(s);
    if (v.mechanism !== "in-place-store-format") {
      console.error(`FAIL-CLOSED: matrix mechanism for this transition is ${v.mechanism}, not in-place-store-format — wrong path for this service.`);
      process.exit(1);
    }
    if (v.service?.family !== "mariadb") {
      console.error(`FAIL-CLOSED: matrix family for ${v.serviceId} is ${v.service?.family}, not mariadb — wrong path for this service.`);
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

RUN_ID="uf-mdb-$$"
SRC_C="${RUN_ID}-src"
CAND_C="${RUN_ID}-cand"
FIN_C="${RUN_ID}-fin"
CAND_VOL="${VOLUME}-ufcand-$$"
DUMP="${BACKUP_DIR}/${SERVICE}-${FROM}-to-${TO}-$(date +%Y%m%d%H%M%S).sql"
PHASE="pre-commit"
LEDGER_BEGUN=0
CAND_CREATED=0

# mdb_exec <container> <client…> — run a MariaDB client with root creds via env.
mdb_exec() {
  local c="$1"; shift
  docker exec -e MYSQL_PWD="$UPGRADE_MARIADB_ROOT_PASSWORD" "$c" "$@"
}

# mdb_exec_stdin — same, with stdin attached (dump restore).
mdb_exec_stdin() {
  local c="$1"; shift
  docker exec -i -e MYSQL_PWD="$UPGRADE_MARIADB_ROOT_PASSWORD" "$c" "$@"
}

mdb_wait_healthy() {
  # mdb_wait_healthy <container> <retries> — official-image healthcheck.
  local c="$1" n="${2:-60}" _
  for _ in $(seq 1 "$n"); do
    if docker exec "$c" healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# mdb_require_series <container> <series> <what> — the running server's
# VERSION() must match the series the invocation was resolved for.
mdb_require_series() {
  local c="$1" series="$2" what="$3" v
  v="$(mdb_exec "$c" mariadb -uroot -N -e "SELECT VERSION();")"
  case "$v" in
    "${series}."*) uf_info "version on '${c}': ${v} (matches ${what} series ${series})" ;;
    *) uf_warn "version on '${c}' is '${v}', expected ${what} series ${series}.*"; return 1 ;;
  esac
}

# mdb_clean_stop <container> — the clean-shutdown requirement: full slow
# shutdown (innodb_fast_shutdown=0), SIGTERM stop, assert exit 0 + the
# server's own "Shutdown complete" log line.
mdb_clean_stop() {
  local c="$1" rc
  mdb_exec "$c" mariadb -uroot -e "SET GLOBAL innodb_fast_shutdown=0;" >/dev/null
  docker stop -t 120 "$c" >/dev/null
  rc="$(docker inspect -f '{{.State.ExitCode}}' "$c")"
  [ "$rc" = "0" ] || { uf_warn "server '${c}' exited ${rc} on stop (not a clean shutdown)"; return 1; }
  # NOT `| grep -q`: under pipefail, grep -q's early exit SIGPIPEs a still-
  # writing `docker logs` (exit 141) and a FOUND marker would read as failure.
  local logs
  logs="$(docker logs "$c" 2>&1)"
  case "$logs" in
    *"Shutdown complete"*) : ;;
    *) uf_warn "no 'Shutdown complete' in '${c}' log"; return 1 ;;
  esac
}

# mdb_verify <container> — post-verify battery: target series + integrity +
# the caller's content read-back hook.
mdb_verify() {
  local c="$1"
  mdb_require_series "$c" "$TO" "target" || return 1
  local check
  check="$(mdb_exec "$c" mariadb-check -uroot --all-databases)" || { uf_warn "mariadb-check failed on '${c}'"; return 1; }
  # NOT `| grep -q` (pipefail + early exit can SIGPIPE the producer).
  if printf '%s\n' "$check" | grep -iE 'error|corrupt|crashed' >&2; then
    uf_warn "mariadb-check reported problems on '${c}' (matches above)"
    return 1
  fi
  if [ -n "$VERIFY_CMD" ]; then
    UF_VERIFY_CONTAINER="$c" MYSQL_PWD="$UPGRADE_MARIADB_ROOT_PASSWORD" bash -c "$VERIFY_CMD" \
      || { uf_warn "--verify-cmd content read-back failed on '${c}'"; return 1; }
  fi
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
    uf_warn "pre-commit abort: rolled back — source volume '${VOLUME}' is intact (it was only ever opened read-only for the clone) and the ledger carries the source entry again."
    # Remove ONLY a candidate THIS run created (never a leftover it refused).
    if [ "$CAND_CREATED" = "1" ]; then
      docker volume rm "$CAND_VOL" >/dev/null 2>&1 || true
    fi
    exit 5
  fi
  uf_warn "POST-COMMIT INTERRUPTION: the pending ledger journal is RETAINED (fail-closed 'interrupted migration'); the candidate volume '${CAND_VOL}' and the checksummed dump '${DUMP}' are kept as recovery material."
  uf_warn "Recovery: re-run the cutover copy from '${CAND_VOL}' (or restore the dump into a fresh target volume), verify, then commit the ledger."
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
uf_log "starting throwaway ${SRC_IMAGE} on the CANDIDATE for the verified backup"
docker run -d --name "$SRC_C" -v "${CAND_VOL}:/var/lib/mysql" "$SRC_IMAGE" >/dev/null
mdb_wait_healthy "$SRC_C" || { uf_warn "source server never became healthy on the candidate clone — is '${VOLUME}' really a ${FROM} data dir?"; false; }
mdb_require_series "$SRC_C" "$FROM" "source"

uf_log "mariadb-dump --all-databases -> ${DUMP}"
mdb_exec "$SRC_C" mariadb-dump -uroot --all-databases --routines --events --triggers --single-transaction > "$DUMP"
[ -s "$DUMP" ] || { uf_warn "dump is empty"; false; }
grep -q "CREATE TABLE" "$DUMP" || { uf_warn "dump contains no CREATE TABLE — not a plausible full dump"; false; }
uf_write_checksum "$DUMP"
uf_verify_checksum "$DUMP" || { uf_warn "dump checksum verification failed"; false; }
uf_inject backup-verify
uf_info "dump verified ($(wc -c < "$DUMP" | tr -d ' ') bytes, sha256 recorded)"

uf_log "clean shutdown of the clone's source server (innodb_fast_shutdown=0 — the state mariadb-upgrade expects)"
mdb_clean_stop "$SRC_C"
docker rm -f "$SRC_C" >/dev/null

# ── 6. migrate the CANDIDATE ─────────────────────────────────────────────────
uf_log "starting ${DST_IMAGE} on the CANDIDATE + explicit mariadb-upgrade"
docker run -d --name "$CAND_C" -v "${CAND_VOL}:/var/lib/mysql" "$DST_IMAGE" >/dev/null
mdb_wait_healthy "$CAND_C" || { uf_warn "target server did not become healthy on the candidate"; false; }

INPLACE_RC=0
if uf_inject inplace-migrate; then
  mdb_exec "$CAND_C" mariadb-upgrade -uroot >/dev/null || INPLACE_RC=$?
else
  INPLACE_RC=1
fi

if [ "$INPLACE_RC" -ne 0 ]; then
  # ── dump/restore FALLBACK on a rebuilt candidate ──────────────────────────
  uf_log "fallback: in-place mariadb-upgrade failed (rc=${INPLACE_RC}) — dump/restore fallback onto a fresh ${TO} candidate"
  docker rm -f "$CAND_C" >/dev/null
  uf_wipe_volume "$CAND_VOL"
  uf_verify_checksum "$DUMP" || { uf_warn "dump checksum no longer verifies — refusing the fallback restore"; false; }
  docker run -d --name "$CAND_C" -v "${CAND_VOL}:/var/lib/mysql" \
    -e MARIADB_ROOT_PASSWORD="$UPGRADE_MARIADB_ROOT_PASSWORD" "$DST_IMAGE" >/dev/null
  mdb_wait_healthy "$CAND_C" || { uf_warn "fresh target server did not become healthy for the fallback restore"; false; }
  uf_info "restoring the verified dump"
  mdb_exec_stdin "$CAND_C" mariadb -uroot < "$DUMP"
  # The dump carried SOURCE-version system tables; normalize them + reload.
  mdb_exec "$CAND_C" mariadb-upgrade -uroot >/dev/null
  mdb_exec "$CAND_C" mariadb -uroot -e "FLUSH PRIVILEGES;" >/dev/null
  # The --all-databases restore REPLACED mysql.global_priv with the SOURCE
  # deployment's grants — deliberately (users/passwords ARE canonical data).
  # But that clobbers the image-managed `healthcheck` user: its restored
  # password is the SOURCE datadir's, while THIS fresh candidate datadir has
  # its own .my-healthcheck.cnf minted at init. Re-align the user to the
  # candidate's file (the file is what healthcheck.sh — and compose's
  # healthcheck after cutover — reads), or the volume would cut over with a
  # permanently failing container healthcheck.
  # The image mints the credential with arbitrary printable characters, so it
  # must never pass through shell interpolation: it leaves the container only
  # base64-wrapped, and node emits the ALTER statements with the value escaped
  # as a proper SQL string literal, piped to the server over stdin.
  HC_B64="$(docker exec "$CAND_C" sh -c 'sed -n "s/^password=//p" /var/lib/mysql/.my-healthcheck.cnf | head -1 | tr -d "\r\n" | base64 | tr -d "\n"')"
  if [ -n "$HC_B64" ]; then
    node -e '
      const pw = Buffer.from(process.argv[1], "base64").toString("utf8");
      const lit = pw.replace(/\\/g, "\\\\").replace(/\x27/g, "\x27\x27");
      for (const h of ["localhost", "127.0.0.1", "::1"]) {
        process.stdout.write(`CREATE USER IF NOT EXISTS \x27healthcheck\x27@\x27${h}\x27;\n`);
        process.stdout.write(`ALTER USER \x27healthcheck\x27@\x27${h}\x27 IDENTIFIED BY \x27${lit}\x27;\n`);
      }
    ' "$HC_B64" | mdb_exec_stdin "$CAND_C" mariadb -uroot >/dev/null
    uf_info "re-aligned the image-managed healthcheck user to the candidate's .my-healthcheck.cnf"
  else
    uf_warn "no .my-healthcheck.cnf password found on the fallback candidate — image healthcheck may fail"
  fi
  # -t 120: the default 10s restart grace can SIGKILL a server still flushing
  # the just-restored data — the candidate must never be killed mid-flush.
  docker restart -t 120 "$CAND_C" >/dev/null
  mdb_wait_healthy "$CAND_C" || { uf_warn "candidate did not come back healthy after the fallback restore"; false; }
fi

# ── 7. post-verify the candidate ─────────────────────────────────────────────
uf_log "post-verify on the candidate"
mdb_verify "$CAND_C"
uf_inject post-verify
mdb_clean_stop "$CAND_C"
docker rm -f "$CAND_C" >/dev/null

# ── 8. COMMIT BOUNDARY — cut over ────────────────────────────────────────────
uf_log "COMMIT BOUNDARY: candidate verified — cutting over onto '${VOLUME}' (volume identity preserved)"
PHASE="post-commit"
uf_wipe_volume "$VOLUME"
uf_copy_into_volume "$CAND_VOL" "$VOLUME"

# ── 9. post-cutover verify -> ledger COMMIT ──────────────────────────────────
uf_log "post-cutover verify on '${VOLUME}'"
docker run -d --name "$FIN_C" -v "${VOLUME}:/var/lib/mysql" "$DST_IMAGE" >/dev/null
mdb_wait_healthy "$FIN_C" || { uf_warn "target server did not become healthy on the cut-over volume"; false; }
mdb_verify "$FIN_C"
uf_inject cutover-verify
mdb_clean_stop "$FIN_C"
docker rm -f "$FIN_C" >/dev/null

uf_ledger_commit "$SERVICE" "$DST_IMAGE" "$VOLUME"
# Best-effort AFTER the commit: a failed removal must not masquerade as an
# interrupted migration (the journal is already cleared).
docker volume rm "$CAND_VOL" >/dev/null 2>&1 \
  || uf_warn "could not remove the candidate volume '${CAND_VOL}' — remove it manually (the upgrade itself is committed)."
uf_log "${_UF_GREEN}DONE${_UF_RST}: ${SERVICE} upgraded ${FROM} -> ${TO}; ledger committed; backup retained at ${DUMP} (+.sha256) under the operator's retention window."
