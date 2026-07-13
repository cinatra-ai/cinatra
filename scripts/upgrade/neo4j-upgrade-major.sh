#!/usr/bin/env bash
# -E (errtrace): the transaction handler is an ERR trap and MUST fire for a
# failure inside a function (bash does not inherit ERR traps into functions
# without it — a begin refusal would otherwise exit with the raw ledger
# status, bypassing rollback and the documented exit-code contract).
set -Eeuo pipefail
# ============================================================================
# Neo4j family — guarded major-version upgrade path (cinatra#1421, epic
# cinatra#1419).
#
# Covers the knowledge-graph store (matrix id `neo4j`, volume
# cinatra-neo4j-data; mechanism in-place-store-format). A Neo4j major is a
# ONE-WAY in-place store-format upgrade (semver 5.26 -> the CalVer line, e.g.
# 2026.05): an old binary cannot open a new-format store, so the intact source
# volume + a `neo4j-admin database dump` are the ONLY rollback. This path runs
# the migration EXPLICITLY and OFFLINE — `neo4j-admin database migrate <db>`
# under the TARGET version's tooling, for EVERY database (system + data) — and
# NEVER relies on the server's first-start auto-migration: the migrate step's
# exit status is asserted by THIS frame, on a CANDIDATE clone, so a failure
# aborts back onto the untouched source. The supported source->target hops are
# exactly the matrix's transitions (5.26 -> 2026.05 today; a downgrade / any
# unlisted hop fail-closes at resolve time). Eligibility is resolved fail-closed
# against docs/architecture/upgrade-matrix.json before anything is touched.
#
# THE GUARDED TRANSACTION (frame + exit-code contract: scripts/upgrade/lib.sh).
# The ORIGINAL volume is never server-mounted before the commit boundary — it
# is opened READ-ONLY exactly once (the clone) and untouched until cutover:
#   1. eligibility: matrix verdict must be supported + mechanism
#      in-place-store-format + family neo4j; the image repo comes from the
#      matrix service (no engine swap) and --from-tag/--to-tag must BIND to the
#      resolved matrix versions (uf_require_tag_series).
#   2. quiesce: no container may still reference the volume (the deployment
#      stops its writers first; graphiti re-projection is its OWN concern at
#      next boot — this path migrates the ENGINE STORE only).
#   3. ledger BEGIN (pending journal; the live entry stays the source).
#   4. clone the source volume (READ-ONLY mount) to the CANDIDATE.
#   5. verified backup OFF THE CANDIDATE: a throwaway SOURCE-version server runs
#      on the CLONE (recovery, if any, happens on the clone — the original is
#      never dirtied); its runtime version must match the resolved --from
#      series; the SOURCE content fingerprint (node/rel totals + per-label +
#      per-reltype counts + the caller's read-back) is captured; then a CLEAN
#      stop (SIGTERM, exit 0). With the server stopped, an OFFLINE
#      `neo4j-admin database dump` of EVERY database is taken off the candidate
#      (the RPO floor + post-interrupt recovery material), tar'd and
#      sha256-checksummed.
#   6. migrate the CANDIDATE: OFFLINE `neo4j-admin database migrate <db>` under
#      the TARGET image, for EVERY database, each exit status asserted. No
#      MARIADB_AUTO_UPGRADE-style entrypoint auto-migration is used.
#   7. post-verify the candidate: the TARGET server starts on the clone, its
#      version matches the target series, the content fingerprint EQUALS the
#      captured source, plus the caller's --verify-cmd read-back hook.
#   8. COMMIT BOUNDARY -> cut over: the original volume is wiped and the
#      candidate's bytes are copied in (the volume OBJECT — and its
#      {name, createdAt} ledger identity — is preserved; compose keeps pointing
#      at the same named volume).
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
#   UPGRADE_NEO4J_PASSWORD=… UPGRADE_LEDGER_FILE=… \
#   scripts/upgrade/neo4j-upgrade-major.sh \
#     --service neo4j --volume cinatra-neo4j-data \
#     --from 5.26 --to 2026.05 --backup-dir <dir> \
#     [--from-tag <tag[@digest]>] [--to-tag <tag[@digest]>] [--verify-cmd <cmd>]
#
# --from/--to are the MATRIX versions (the store-format series); --from-tag/
# --to-tag are the image tags to RUN, defaulting to `<version>-community` — a
# caller (the upgrade-from fixture) passes digest-bound tags (e.g.
# `5.26-community@sha256:…`) so the proof is pinned to exact bytes. A tag is
# always appended to the MATRIX service's image repo AND must bind to its
# resolved series, so a pin can neither smuggle in a different engine nor a
# different version.
#
# The neo4j password comes from the ENVIRONMENT (never argv) and is forwarded to
# cypher-shell via NEO4J_PASSWORD on `docker exec` only. It must be the DEPLOYED
# volume's password (on a populated data dir NEO4J_AUTH is ignored — the server
# reads the credential from the migrated system database), so the verify
# read-backs authenticate.
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
[ -n "${UPGRADE_NEO4J_PASSWORD:-}" ] || uf_die 2 "UPGRADE_NEO4J_PASSWORD must be set (the deployed volume's neo4j password; used for the verify read-backs, env-only never argv)"
# The CalVer line enforces an 8-char minimum password; refuse a shorter one up
# front (a verify server would otherwise never accept a login on the target).
[ "${#UPGRADE_NEO4J_PASSWORD}" -ge 8 ] || uf_die 2 "UPGRADE_NEO4J_PASSWORD is shorter than the 8-character minimum the target enforces."
FROM_TAG="${FROM_TAG:-${FROM}-community}"
TO_TAG="${TO_TAG:-${TO}-community}"
uf_require_tag_series --from-tag "$FROM_TAG" "$FROM"
uf_require_tag_series --to-tag "$TO_TAG" "$TO"

# ── 1. eligibility (fail-closed, BEFORE any mutation) ────────────────────────
uf_log "neo4j guarded upgrade: ${SERVICE} ${FROM} -> ${TO} on volume '${VOLUME}'"
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
    if (v.service?.family !== "neo4j") {
      console.error(`FAIL-CLOSED: matrix family for ${v.serviceId} is ${v.service?.family}, not neo4j — wrong path for this service.`);
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

RUN_ID="uf-neo-$$"
SRC_C="${RUN_ID}-src"
CAND_C="${RUN_ID}-cand"
FIN_C="${RUN_ID}-fin"
CAND_VOL="${VOLUME}-ufcand-$$"
BACK_VOL="${VOLUME}-ufback-$$"
BACKUP_TAR="${BACKUP_DIR}/${SERVICE}-${FROM}-to-${TO}-$(date +%Y%m%d%H%M%S).tar"
PHASE="pre-commit"
LEDGER_BEGUN=0
CAND_CREATED=0
BACK_CREATED=0
SRC_FP=""

# neo_cypher <container> <cypher> — run a query with the neo4j password via env
# (never argv), forcing CYPHER 5 so a query is parsed identically on the 5.x
# source and the CalVer target (whose default dialect is CYPHER 25).
neo_cypher() {
  local c="$1" q="$2"
  docker exec -e NEO4J_PASSWORD="$UPGRADE_NEO4J_PASSWORD" "$c" \
    cypher-shell -u neo4j -d neo4j --format plain "CYPHER 5 ${q}"
}

neo_wait() {
  # neo_wait <container> <retries> — the server answers an authenticated query.
  local c="$1" n="${2:-40}" _
  for _ in $(seq 1 "$n"); do
    if docker exec -e NEO4J_PASSWORD="$UPGRADE_NEO4J_PASSWORD" "$c" \
        cypher-shell -u neo4j 'RETURN 1' >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}

# neo_version <container> — the running kernel version (e.g. 5.26.28 / 2026.05.0).
neo_version() {
  neo_cypher "$1" 'CALL dbms.components() YIELD name, versions WHERE name = "Neo4j Kernel" RETURN versions[0];' 2>/dev/null \
    | tail -1 | tr -d '"'
}

# neo_require_series <container> <series> <what> — the running version must
# match the series the invocation was resolved for.
neo_require_series() {
  local c="$1" series="$2" what="$3" v
  v="$(neo_version "$c")"
  case "$v" in
    "${series}."*|"$series") uf_info "version on '${c}': ${v} (matches ${what} series ${series})" ;;
    *) uf_warn "version on '${c}' is '${v}', expected ${what} series ${series}.*"; return 1 ;;
  esac
}

# neo_fingerprint <container> — a deterministic CONTENT digest of the data
# database: node + relationship totals, plus every label and every relationship
# type with its EXACT count, sorted. Captured on the SOURCE and asserted
# byte-for-byte on the target + cut-over volume, so a partial/failed migration
# that drops nodes, relationships, a whole label, or a relationship type is
# caught. A bare version check would pass a lossy migration.
neo_fingerprint() {
  local c="$1" nodes rels labels reltypes
  nodes="$(neo_cypher "$c" 'MATCH (n) RETURN count(n);' | tail -1)"
  rels="$(neo_cypher "$c" 'MATCH ()-[r]->() RETURN count(r);' | tail -1)"
  labels="$(neo_cypher "$c" 'MATCH (n) UNWIND labels(n) AS l WITH l, count(*) AS c RETURN l + "=" + c ORDER BY l;' \
    | tail -n +2 | tr -d '"' | tr '\n' ',')"
  reltypes="$(neo_cypher "$c" 'MATCH ()-[r]->() WITH type(r) AS t, count(*) AS c RETURN t + "=" + c ORDER BY t;' \
    | tail -n +2 | tr -d '"' | tr '\n' ',')"
  echo "nodes=${nodes};rels=${rels};labels=[${labels}];reltypes=[${reltypes}]"
}

neo_verify() {
  # neo_verify <container> — target series + CONTENT parity against the source +
  # the caller's read-back hook.
  local c="$1" fp
  neo_require_series "$c" "$TO" "target" || return 1
  fp="$(neo_fingerprint "$c")"
  [ "$fp" = "$SRC_FP" ] || { uf_warn "content fingerprint mismatch on '${c}' (got '${fp}', source '${SRC_FP}') — the migration is lossy; refusing"; return 1; }
  if [ -n "$VERIFY_CMD" ]; then
    UF_VERIFY_CONTAINER="$c" NEO4J_PASSWORD="$UPGRADE_NEO4J_PASSWORD" bash -c "$VERIFY_CMD" \
      || { uf_warn "--verify-cmd content read-back failed on '${c}'"; return 1; }
  fi
}

# neo_clean_stop <container> — SIGTERM is neo4j's graceful shutdown; assert 0.
neo_clean_stop() {
  local c="$1" rc
  docker stop -t 120 "$c" >/dev/null
  rc="$(docker inspect -f '{{.State.ExitCode}}' "$c")"
  [ "$rc" = "0" ] || { uf_warn "server '${c}' exited ${rc} on stop (not a clean shutdown)"; return 1; }
}

# neo_databases <volume> — the database names on the (stopped) volume, one per
# line: every directory under /data/databases except the store-wide lock file.
# `neo4j-admin database migrate|dump` operate on these names.
neo_databases() {
  docker run --rm -v "$1:/data:ro" alpine \
    sh -ec 'cd /data/databases 2>/dev/null && for d in */; do [ -d "$d" ] && echo "${d%/}"; done' \
    | grep -v '^store_lock$' || true
}

# neo_start <container> <image> <volume> — a throwaway server on <volume>. The
# throwaway servers rely SOLELY on the per-query `CYPHER 5` prefix for
# cross-version parsing — the CalVer `db.query.default_language` config does NOT
# exist on the 5.x source and would crash it, so it is never set here.
# NEO4J_AUTH is passed but IGNORED on a populated volume (auth comes
# from the migrated system db) — it is load-bearing only when a caller points
# this at a fresh volume.
neo_start() {
  docker run -d --name "$1" -v "${3}:/data" \
    -e NEO4J_AUTH="neo4j/${UPGRADE_NEO4J_PASSWORD}" \
    "$2" >/dev/null
}

cleanup_containers() { docker rm -f "$SRC_C" "$CAND_C" "$FIN_C" >/dev/null 2>&1 || true; }

on_err() {
  local line="$1" rc="${2:-1}"
  # In a SUBSHELL (command substitution / pipeline element — errtrace makes the
  # trap fire there too), do NOTHING: propagate the status and let the MAIN
  # shell's trap run the transaction handling exactly once. BASH_SUBSHELL (not
  # BASHPID): stock macOS bash 3.2 has no BASHPID, which would silently disable
  # this guard there and double-run the handler.
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
    # Remove ONLY the volumes THIS run created (never a leftover it refused).
    [ "$CAND_CREATED" = "1" ] && docker volume rm "$CAND_VOL" >/dev/null 2>&1 || true
    [ "$BACK_CREATED" = "1" ] && docker volume rm "$BACK_VOL" >/dev/null 2>&1 || true
    exit 5
  fi
  uf_warn "POST-COMMIT INTERRUPTION: the pending ledger journal is RETAINED (fail-closed 'interrupted migration'); the candidate volume '${CAND_VOL}' and the checksummed dump '${BACKUP_TAR}' are kept as recovery material."
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
uf_log "starting throwaway ${SRC_IMAGE} on the CANDIDATE for state capture"
neo_start "$SRC_C" "$SRC_IMAGE" "$CAND_VOL"
neo_wait "$SRC_C" || { uf_warn "source server never became ready on the candidate clone — is '${VOLUME}' really a neo4j ${FROM} data dir with password UPGRADE_NEO4J_PASSWORD?"; false; }
neo_require_series "$SRC_C" "$FROM" "source"
# Capture the SOURCE content fingerprint the target/cut-over volume must match
# (the lossy-migration guard) BEFORE the migration.
SRC_FP="$(neo_fingerprint "$SRC_C")"
uf_info "source content fingerprint: ${SRC_FP}"
uf_log "clean shutdown of the clone's source server (SIGTERM) before the offline dump + migrate"
neo_clean_stop "$SRC_C"
docker rm -f "$SRC_C" >/dev/null

uf_log "offline neo4j-admin database dump of every database off the candidate -> ${BACKUP_TAR}"
DBS="$(neo_databases "$CAND_VOL")"
[ -n "$DBS" ] || { uf_warn "no databases found on '${VOLUME}' — not a plausible neo4j data dir"; false; }
uf_info "databases: $(echo "$DBS" | tr '\n' ' ')"
uf_candidate_create "$BACK_VOL"
BACK_CREATED=1
# The fresh backup volume is root-owned but neo4j-admin runs as the neo4j user
# (uid 7474 in both the 5.x and CalVer images), so pre-chown it or the offline
# dump cannot write to --to-path.
docker run --rm -v "${BACK_VOL}:/uf-backup" alpine chown 7474:7474 /uf-backup
for db in $DBS; do
  uf_info "dumping database '${db}'"
  docker run --rm -v "${CAND_VOL}:/data" -v "${BACK_VOL}:/uf-backup" "$SRC_IMAGE" \
    neo4j-admin database dump "$db" --to-path=/uf-backup >/dev/null
done
# Stream the dumps out to the host backup file (host redirect — no host-dir bind
# mount needed), then checksum.
docker run --rm -v "${BACK_VOL}:/uf-backup:ro" alpine tar -cf - -C /uf-backup . > "$BACKUP_TAR"
[ -s "$BACKUP_TAR" ] || { uf_warn "backup tar is empty"; false; }
docker run --rm -v "${BACK_VOL}:/uf-backup:ro" alpine sh -ec 'ls /uf-backup/*.dump >/dev/null 2>&1' \
  || { uf_warn "no .dump artifacts were produced — not a plausible full backup"; false; }
uf_write_checksum "$BACKUP_TAR"
uf_verify_checksum "$BACKUP_TAR" || { uf_warn "backup checksum verification failed"; false; }
docker volume rm "$BACK_VOL" >/dev/null 2>&1 || true
BACK_CREATED=0
uf_inject backup-verify
uf_info "backup verified ($(wc -c < "$BACKUP_TAR" | tr -d ' ') bytes, sha256 recorded)"

# ── 6. migrate the CANDIDATE (offline, explicit, every database) ─────────────
uf_log "offline neo4j-admin database migrate under ${DST_IMAGE} — every database, no auto-migration"
if uf_inject store-migrate; then
  for db in $DBS; do
    uf_info "migrating database '${db}' store format"
    MIG_OUT="$(docker run --rm -v "${CAND_VOL}:/data" "$DST_IMAGE" \
      neo4j-admin database migrate "$db" 2>&1)" \
      || { uf_warn "neo4j-admin database migrate '${db}' failed:"; printf '%s\n' "$MIG_OUT" >&2; false; }
  done
else
  false
fi

# ── 7. post-verify the candidate ─────────────────────────────────────────────
uf_log "starting ${DST_IMAGE} on the CANDIDATE + post-verify"
neo_start "$CAND_C" "$DST_IMAGE" "$CAND_VOL"
neo_wait "$CAND_C" || { uf_warn "target server did not become ready on the candidate after migration"; false; }
neo_verify "$CAND_C"
uf_inject post-verify
neo_clean_stop "$CAND_C"
docker rm -f "$CAND_C" >/dev/null

# ── 8. COMMIT BOUNDARY — cut over ────────────────────────────────────────────
uf_log "COMMIT BOUNDARY: candidate verified — cutting over onto '${VOLUME}' (volume identity preserved)"
PHASE="post-commit"
uf_wipe_volume "$VOLUME"
uf_copy_into_volume "$CAND_VOL" "$VOLUME"

# ── 9. post-cutover verify -> ledger COMMIT ──────────────────────────────────
uf_log "post-cutover verify on '${VOLUME}'"
neo_start "$FIN_C" "$DST_IMAGE" "$VOLUME"
neo_wait "$FIN_C" || { uf_warn "target server did not become ready on the cut-over volume"; false; }
neo_verify "$FIN_C"
uf_inject cutover-verify
neo_clean_stop "$FIN_C"
docker rm -f "$FIN_C" >/dev/null

uf_ledger_commit "$SERVICE" "$DST_IMAGE" "$VOLUME"
# Best-effort AFTER the commit: a failed removal must not masquerade as an
# interrupted migration (the journal is already cleared).
docker volume rm "$CAND_VOL" >/dev/null 2>&1 \
  || uf_warn "could not remove the candidate volume '${CAND_VOL}' — remove it manually (the upgrade itself is committed)."
uf_log "${_UF_GREEN}DONE${_UF_RST}: ${SERVICE} upgraded ${FROM} -> ${TO}; ledger committed; backup retained at ${BACKUP_TAR} (+.sha256) under the operator's retention window."
