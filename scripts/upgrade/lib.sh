#!/usr/bin/env bash
# ============================================================================
# Guarded-transaction frame — shared helpers for the per-family upgrade paths
# (upgrade-paths epic cinatra#1419, non-Postgres families cinatra#1421).
#
# Every family path (mariadb-upgrade-major.sh, redis-upgrade-major.sh, …) runs
# the SAME frame:
#
#   eligibility (matrix, fail-closed) → quiesce → ledger BEGIN (pending
#   journal) → clone the source volume (READ-ONLY mount) to a CANDIDATE →
#   verified backup OFF THE CANDIDATE → migrate the CANDIDATE → post-verify
#   the candidate → COMMIT BOUNDARY → cut over → post-cutover verify →
#   ledger COMMIT → cleanup (retention rule)
#
# The ORIGINAL volume is never server-mounted before the commit boundary: every
# server (the source-version backup server included) runs on the candidate
# clone, and the original is only ever opened read-only for the clone itself —
# so no failure shape can leave the source dirty or crash-recovered. The intact
# source volume IS the rollback until the explicit commit boundary: a
# pre-commit failure rolls the ledger back to the source entry (VERIFIED — a
# failed rollback is reported fail-closed, never as a clean abort) and leaves
# the source volume untouched; a post-commit failure NEVER rolls the ledger
# back — it leaves the `pending` journal in place (the fail-closed "interrupted
# migration" finding the cinatra-cli preflight refuses on) plus the candidate
# volume and the checksummed backup as recovery material.
#
# EXIT-CODE CONTRACT (stable; consumed by the works-after upgrade-from arms
# and, later, the cinatra-cli integration chain):
#   0  upgraded, verified, ledger committed
#   2  usage / misconfiguration (bad args, missing tool, no ledger configured)
#   3  fail-closed refusal BEFORE any mutation (matrix verdict, cross-fork
#      image, downgrade, un-quiesced volume, missing volume, disk precheck)
#   4  fail-closed INTERRUPTED: a post-commit failure (cutover or post-cutover
#      verify), OR a pre-commit abort whose ledger rollback itself FAILED — in
#      both shapes the pending ledger journal is RETAINED (fail-closed) and the
#      candidate volume + backup are kept as recovery material
#   5  aborted pre-commit: rolled back and VERIFIED — source volume intact,
#      ledger restored to the source entry
#
# LEDGER SEAM. The frame requires a transactional ledger:
#   * UPGRADE_LEDGER_FILE=<path> — the file ledger implemented by
#     scripts/upgrade/ledger.mjs (the harness-drivable default; same
#     begin/commit/rollback journal semantics as the deployed-version ledger).
#   * UPGRADE_LEDGER_HOOK=<cmd>  — overrides the file ledger. Invoked as
#     `<cmd> <begin|commit|rollback|record> <serviceId> <image> <volumeName>`.
#     This is the seam through which the cinatra-cli per-service adapter chain
#     (cinatra-cli#128, extended in the cinatra-cli#129 chain) drives the REAL
#     instance-bound deployed-version ledger. Neither set => the frame refuses
#     (exit 2): a migration without a ledger transaction is exactly the
#     naive-recreate hazard this epic closes.
#
# FAILURE INJECTION (the executable-failure-injectable requirement of
# cinatra#1421): UPGRADE_INJECT_FAILURE=<point> makes the frame fail
# deliberately at that named boundary. Points wired by the family paths:
#   backup-verify | inplace-migrate (mariadb: forces the dump/restore
#   fallback) | post-verify (pre-commit → rollback) | cutover-verify
#   (post-commit → interrupted).
#
# Mirrors the discipline of scripts/ci/works-after/lib.sh: fail loud with
# diagnostics, own your cleanup traps, side-effect-free helpers except where
# noted.
# ============================================================================

UF_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034  # consumed by sourcing family paths
UF_REPO_ROOT="$(cd "${UF_LIB_DIR}/../.." && pwd)"

if [ -t 1 ]; then
  _UF_RED=$'\033[0;31m'; _UF_GREEN=$'\033[0;32m'; _UF_YELLOW=$'\033[1;33m'; _UF_RST=$'\033[0m'
else
  _UF_RED=""; _UF_GREEN=""; _UF_YELLOW=""; _UF_RST=""
fi

uf_log()  { echo "==> $*"; }
uf_info() { echo "    $*"; }
uf_warn() { echo "${_UF_YELLOW}    $*${_UF_RST}"; }

# uf_die <exit-code> <message…> — refuse/abort with the contract exit code.
uf_die() {
  local code="$1"; shift
  echo "${_UF_RED}ERROR: $*${_UF_RST}" >&2
  exit "$code"
}

# ── eligibility (fail-closed matrix resolution) ──────────────────────────────

# uf_resolve <serviceId> <from> <to> — resolve the transition against the
# committed upgrade matrix (scripts/upgrade/resolve-transition.mjs, which
# fail-closes on skew and on any unlisted tuple). On support: prints the
# verdict JSON on stdout and returns 0. On refusal: prints the verdict and
# EXITS 3 — a family path can never proceed past an unsupported hop.
uf_resolve() {
  local svc="$1" from="$2" to="$3" out rc=0
  out="$(node "${UF_LIB_DIR}/resolve-transition.mjs" "$svc" "$from" "$to" 2>&1)" || rc=$?
  echo "$out"
  if [ "$rc" -ne 0 ]; then
    uf_die 3 "matrix refuses ${svc}: ${from} -> ${to} (fail-closed; see verdict above). No mutation was performed."
  fi
}

# uf_matrix_image_repo <serviceId> — the image repo of the service's baseline
# pin (e.g. redis, valkey/valkey, mariadb). Used for the explicit cross-fork /
# wrong-engine block: the target image repo MUST match the matrix service.
uf_matrix_image_repo() {
  node "${UF_LIB_DIR}/resolve-transition.mjs" --image-repo "$1"
}

# uf_require_tag_series <flag> <tag> <series> — bind an image TAG to the MATRIX
# version it claims to run: the tag must BE the series, or extend it with a
# variant/digest separator (`11.4`, `11.4.5`, `7-alpine`, `8-alpine@sha256:…`
# bind to 11.4 / 11.4 / 7 / 8). Anything else is a misconfigured invocation
# (exit 2): eligibility was resolved for a version the tag would not run.
uf_require_tag_series() {
  local flag="$1" tag="$2" series="$3"
  case "$tag" in
    "$series"|"$series".*|"$series"-*|"$series"@*) : ;;
    *) uf_die 2 "${flag} '${tag}' does not run the matrix version '${series}' it was resolved for (tag must be '${series}' or extend it with . - or @)." ;;
  esac
}

# ── quiesce / volume state ───────────────────────────────────────────────────

uf_volume_exists() { docker volume inspect "$1" >/dev/null 2>&1; }

# uf_require_quiesced <volume> — the deployment must have STOPPED all writers:
# any container (running or created) still referencing the volume is a
# fail-closed stop. The frame never stops someone else's container.
uf_require_quiesced() {
  local vol="$1" using
  using="$(docker ps -a --filter "volume=${vol}" --format '{{.Names}} ({{.Status}})')"
  if [ -n "$using" ]; then
    uf_die 3 "volume '${vol}' is not quiesced — container(s) still reference it: ${using}. Stop and remove them first (quiesce is step 1 of the guarded frame)."
  fi
}

# ── disk-space prechecks ─────────────────────────────────────────────────────

# uf_volume_used_kb <volume> — bytes used inside a named volume (KiB).
uf_volume_used_kb() {
  docker run --rm -v "$1:/uf-vol:ro" alpine du -sk /uf-vol | awk '{print $1}'
}

# uf_volume_fs_free_kb <volume> — free space (KiB) on the filesystem that
# backs docker volumes (measured inside a container mounting the volume, so it
# is correct under Docker Desktop's VM too).
uf_volume_fs_free_kb() {
  docker run --rm -v "$1:/uf-vol:ro" alpine df -Pk /uf-vol | awk 'NR==2 {print $4}'
}

# uf_dir_free_kb <dir> — free space (KiB) at a host path (the backup dir).
uf_dir_free_kb() { df -Pk "$1" | awk 'NR==2 {print $4}'; }

# uf_disk_precheck <volume> <backup-dir> — the frame needs (a) room for the
# candidate clone on the volume filesystem and (b) room for the dump/backup on
# the host, each with a 20% margin. Fails closed (exit 3) BEFORE any mutation.
uf_disk_precheck() {
  local vol="$1" bdir="$2" used vfree bfree need
  used="$(uf_volume_used_kb "$vol")"
  need=$(( used + used / 5 ))
  vfree="$(uf_volume_fs_free_kb "$vol")"
  bfree="$(uf_dir_free_kb "$bdir")"
  uf_info "disk precheck: volume '${vol}' uses ${used} KiB; volume-fs free ${vfree} KiB; backup-dir free ${bfree} KiB (need ~${need} KiB each)"
  [ "$vfree" -ge "$need" ] || uf_die 3 "not enough space on the volume filesystem for a candidate clone of '${vol}' (${vfree} KiB free < ${need} KiB needed)."
  [ "$bfree" -ge "$need" ] || uf_die 3 "not enough space in the backup dir for the verified backup of '${vol}' (${bfree} KiB free < ${need} KiB needed)."
}

# ── candidate-volume mechanics ───────────────────────────────────────────────

# uf_candidate_create <dst-volume> — create the EMPTY candidate volume.
# REFUSES a pre-existing dst (returns 1 so the caller's frame rolls back): a
# same-named leftover may be RETAINED RECOVERY MATERIAL from an interrupted
# run (or a pid-reuse collision) — it is never silently overlaid. The caller
# sets its ownership flag (CAND_CREATED=1) IMMEDIATELY after this returns —
# before the fill — so a mid-copy failure still removes the partial candidate
# the run owns, while a refused leftover is never touched. The fill itself is
# uf_copy_into_volume with the source mounted READ-ONLY.
uf_candidate_create() {
  local dst="$1"
  if uf_volume_exists "$dst"; then
    uf_warn "candidate volume '${dst}' already exists — refusing to overlay it (it may be retained recovery material from an interrupted run; remove it explicitly first)."
    return 1
  fi
  docker volume create "$dst" >/dev/null
}

# uf_wipe_volume <volume> — empty a volume in place (the volume OBJECT — and
# with it the {name, createdAt} identity the ledger binds to — is preserved;
# only its contents are replaced by the subsequent copy).
uf_wipe_volume() {
  docker run --rm -v "$1:/uf-vol" alpine \
    sh -ec 'find /uf-vol -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
}

# uf_copy_into_volume <src-volume> <dst-volume> — byte-copy into an EXISTING
# (already wiped) volume. Cutover = uf_wipe_volume + uf_copy_into_volume.
uf_copy_into_volume() {
  docker run --rm -v "$1:/uf-from:ro" -v "$2:/uf-to" alpine \
    sh -ec 'cd /uf-from && cp -a . /uf-to'
}

# ── verified-backup helpers ──────────────────────────────────────────────────

# uf_sha256 <file> — portable sha256 (node's crypto; no shasum/sha256sum
# divergence between macOS and the CI runner).
uf_sha256() {
  node -e 'const{createHash}=require("crypto");const{readFileSync}=require("fs");process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "$1"
}

# uf_write_checksum <file> — write <file>.sha256 next to the artifact.
uf_write_checksum() { uf_sha256 "$1" > "$1.sha256"; }

# uf_verify_checksum <file> — recompute and compare against <file>.sha256.
uf_verify_checksum() {
  local f="$1" want got
  want="$(cat "$f.sha256")"
  got="$(uf_sha256 "$f")"
  [ -n "$want" ] && [ "$want" = "$got" ]
}

# ── failure injection ────────────────────────────────────────────────────────

# uf_inject <point> — deliberate failure at a named frame boundary when
# UPGRADE_INJECT_FAILURE names it. Returns 1 (letting the caller's abort
# handling run) so injected failures exercise EXACTLY the real failure paths.
uf_inject() {
  if [ "${UPGRADE_INJECT_FAILURE:-}" = "$1" ]; then
    echo "${_UF_RED}INJECTED FAILURE at '${1}' (UPGRADE_INJECT_FAILURE)${_UF_RST}" >&2
    return 1
  fi
  return 0
}

# ── ledger transaction (the cinatra-cli seam) ────────────────────────────────

# uf_volume_created_at <volume> — the docker-reported creation timestamp; with
# the name it forms the volume identity a ledger entry is bound to (a destroyed
# + recreated same-named volume gets a NEW createdAt → identity mismatch →
# fail-closed, mirroring the cinatra-cli#128 ledger).
uf_volume_created_at() { docker volume inspect -f '{{.CreatedAt}}' "$1"; }

_uf_ledger() {
  # _uf_ledger <op> <serviceId> <image> <volumeName>
  local op="$1" svc="$2" image="$3" vol="$4"
  if [ -n "${UPGRADE_LEDGER_HOOK:-}" ]; then
    "$UPGRADE_LEDGER_HOOK" "$op" "$svc" "$image" "$vol"
    return $?
  fi
  if [ -z "${UPGRADE_LEDGER_FILE:-}" ]; then
    uf_die 2 "no ledger configured: set UPGRADE_LEDGER_FILE (file ledger, scripts/upgrade/ledger.mjs) or UPGRADE_LEDGER_HOOK (the cinatra-cli adapter seam). The guarded frame never migrates without a ledger transaction."
  fi
  node "${UF_LIB_DIR}/ledger.mjs" "$op" \
    --file "$UPGRADE_LEDGER_FILE" \
    --service "$svc" \
    --image "$image" \
    --volume-name "$vol" \
    --volume-created-at "$(uf_volume_created_at "$vol")"
}

# uf_ledger_begin <serviceId> <target-image> <volume> — open the pending
# journal (source entry captured; live entry untouched). MUST precede any
# mutation of any volume.
uf_ledger_begin()    { _uf_ledger begin    "$1" "$2" "$3"; }
# uf_ledger_commit — promote the candidate target entry; ONLY after the
# post-cutover verify passed.
uf_ledger_commit()   { _uf_ledger commit   "$1" "$2" "$3"; }
# uf_ledger_rollback — restore the source entry (pre-commit aborts only).
uf_ledger_rollback() { _uf_ledger rollback "$1" "$2" "$3"; }
