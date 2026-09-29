#!/usr/bin/env bash
# design-build-cache.sh restore | save | rebuild <exit code>
#
# The design suite's runner-local build cache (cinatra#3771).
#
# WHY. The pixel-diff job of .github/workflows/design-visual-verify.yml runs a
# production build on a self-hosted runner, and every one of those builds
# started from nothing: 6.0 to 18.9 minutes per job (median 8.9) over thirty
# design jobs measured on 2026-09-28, on runners that had built the same tree an
# hour earlier. This script keeps the framework's build cache (.next/cache) on
# the runner between jobs, so a job at a head that changed a few files compiles
# what those files reach and reuses the rest.
#
# OFF UNLESS LABELLED (cinatra#3810). The pixel-diff job runs `restore` only
# for a pull request that carries the label `design-build-cache`; every other
# job, a merge-queue run included, skips it and builds exactly as it did
# without the cache. A cold build with the cache on measured 19 to 20 minutes
# and 30 to 31 GB of memory against 7 to 9 minutes and 24.5 to 26 GB with it
# off (2026-09-29), and no base branch cache is written while the merge queue
# is not in use, so without the label the first build of every pull request is
# cold.
#
# THE SWITCH. The build writes a cache a later build can reuse only when
# CINATRA_TURBOPACK_BUILD_FS_CACHE=1 reaches next.config.ts: the framework keeps
# its Turbopack build cache off by default and reads that option from the config
# alone. `restore` answers `fs-cache=1` on its step output when this job may
# set it, and nothing otherwise.
#
# WHERE IT LIVES. One store per runner, `_design-build-cache` under the runner's
# own work root: the parent of $RUNNER_WORKSPACE, the root the job's port step
# already treats as this runner's own. It is outside the checkout, so the
# checkout's clean never reaches it, and it is never uploaded: every upload step
# of the job names a path inside the checkout. A runner runs one job at a time,
# so a store has one user at a time and takes no lock.
#
# THE KEY. "<inputs>-<scope>", two 16-digit hashes:
#   inputs  pnpm-lock.yaml, next.config.ts, the node version, the platform and
#           the checkout path (the build roots itself at the checkout);
#   scope   the branch: a pull request's own ("pull request <number>, branch
#           <head>"), or its base branch's ("branch <base>").
# A pull request restores its own cache, else its base branch's, and keeps what
# it built under its own scope only. A merge-queue run restores and keeps the
# base branch's. So a pull request's cache never seeds another pull request's
# build, and only the queue writes the base branch's cache.
#
# FAIL CLOSED. A save writes the cache and its manifest (format, key, inputs,
# file count, content digest) under a temporary name and publishes both with one
# rename, so a save that never finished leaves no manifest. A restore copies the
# cache into the checkout, digests the copy and keeps it only on an exact match.
# Anything else (no manifest, another key or other inputs in it, a digest that
# differs, a link or a special file in the tree, a copy that fails) discards
# that cache with a `design build cache: DISCARDED ...` line, and the job runs a
# full build. A build that fails with the cache on runs once more from nothing
# with the cache off (`rebuild`), and that build's result is the step's result.
#
# SIZE. After each save the store is pruned, oldest first (by the time a job
# last kept or restored a cache), until it holds at most
# DESIGN_BUILD_CACHE_MAX_MIB (16384 unless set) and its filesystem keeps
# DESIGN_BUILD_CACHE_MIN_FREE_PERCENT (15 unless set) free.
#
# `restore` and `save` never fail the job: any trouble turns the cache off, or
# leaves it unkept, with a `design build cache:` line that says why. `rebuild`
# ends with the build's own result. The branch names arrive through the
# environment and are only ever hashed and printed, never run.
#
# No `set -e`: every failure below is handled where it happens and turns into a
# named line; an unhandled one must not fail a design job over a cache.
set -uo pipefail

readonly FORMAT="design-build-cache/1"
readonly CACHE=".next/cache"
readonly KEY_PATTERN='^[0-9a-f]{16}-[0-9a-f]{16}$'
# Turbopack writes this marker when it gave up on its own cache (a panic).
readonly INVALIDATED="turbopack/__turbo_tasks_invalidated_db"

MAX_MIB="${DESIGN_BUILD_CACHE_MAX_MIB:-16384}"
[[ "$MAX_MIB" =~ ^[1-9][0-9]{0,6}$ ]] || MAX_MIB=16384
MIN_FREE_PERCENT="${DESIGN_BUILD_CACHE_MIN_FREE_PERCENT:-15}"
[[ "$MIN_FREE_PERCENT" =~ ^[0-9]{1,2}$ ]] || MIN_FREE_PERCENT=15

REASON=""
STORE=""
INPUTS=""
OWN_KEY=""
OWN_SCOPE=""
BASE_KEY=""
BASE_SCOPE=""
RESTORED_LINE=""
DIGEST=""

say() { printf 'design build cache: %s\n' "$*"; }

summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf 'design build cache: %s\n\n' "$*" >>"$GITHUB_STEP_SUMMARY" 2>/dev/null || true
  fi
}

# A line in the log and in the job summary.
note() {
  say "$*"
  summary "$*"
}

# The same, raised as a warning annotation.
warn() {
  printf '::warning::design build cache: %s\n' "$*"
  summary "$*"
}

# The value of `name=` in a key=value file, or nothing.
field() {
  awk -v name="$2" 'index($0, name "=") == 1 { print substr($0, length(name) + 2); exit }' "$1" 2>/dev/null
}

state_file() { printf '%s/design-build-cache.state\n' "${RUNNER_TEMP:-}"; }

# The Linux runners' GNU coreutils: `stat -c`, `cp --reflink` and `mv -T` below
# are GNU spellings.
gnu_userland() {
  local tool
  for tool in node sha256sum find xargs sort awk du df cp mv mktemp stat touch uname; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      REASON="${tool} is not on PATH"
      return 1
    fi
  done
  if ! { stat -c %Y . && cp --version && mv --version; } >/dev/null 2>&1; then
    REASON="stat, cp and mv here are not the GNU tools this script is written for"
    return 1
  fi
}

# The store: `_design-build-cache` under this runner's own work root, which is
# never inside the checkout.
store_dir() {
  local workspace="${RUNNER_WORKSPACE:-}" root checkout
  case "$workspace" in /?*/?*) ;; *) return 1 ;; esac
  root="${workspace%/*}"
  [ -d "$root" ] && [ -w "$root" ] || return 1
  root="$(cd "$root" && pwd -P)" || return 1
  checkout="$(pwd -P)" || return 1
  case "$root/" in "$checkout"/*) return 1 ;; esac
  printf '%s/_design-build-cache\n' "$root"
}

hash16() { sha256sum | cut -c1-16; }

# Sets INPUTS, OWN_KEY, OWN_SCOPE, BASE_KEY and BASE_SCOPE for this run.
compute_keys() {
  local node_version base
  if [ ! -f pnpm-lock.yaml ] || [ ! -f next.config.ts ]; then
    REASON="pnpm-lock.yaml or next.config.ts is missing from the checkout"
    return 1
  fi
  if ! node_version="$(node --version 2>/dev/null)"; then
    REASON="the node version could not be read"
    return 1
  fi
  if ! INPUTS="$({ sha256sum pnpm-lock.yaml next.config.ts &&
    printf 'node %s\nplatform %s\ncheckout %s\n' "$node_version" "$(uname -sm)" "$(pwd -P)"; } | hash16)" ||
    ! [[ "$INPUTS" =~ ^[0-9a-f]{16}$ ]]; then
    REASON="the build inputs could not be hashed"
    return 1
  fi
  base="${DESIGN_BUILD_CACHE_BASE_BRANCH:-}"
  base="${base#refs/heads/}"
  if [ -z "$base" ]; then
    REASON="this run names no base branch"
    return 1
  fi
  BASE_SCOPE="branch ${base}"
  case "${DESIGN_BUILD_CACHE_EVENT:-}" in
    pull_request)
      if ! [[ "${DESIGN_BUILD_CACHE_PR:-}" =~ ^[1-9][0-9]*$ ]] || [ -z "${DESIGN_BUILD_CACHE_HEAD_BRANCH:-}" ]; then
        REASON="this pull request run names no number or no head branch"
        return 1
      fi
      OWN_SCOPE="pull request ${DESIGN_BUILD_CACHE_PR}, branch ${DESIGN_BUILD_CACHE_HEAD_BRANCH}"
      ;;
    merge_group)
      OWN_SCOPE="$BASE_SCOPE"
      BASE_SCOPE=""
      ;;
    *)
      REASON="a run of the '${DESIGN_BUILD_CACHE_EVENT:-}' event keeps no build cache"
      return 1
      ;;
  esac
  OWN_KEY="${INPUTS}-$(printf '%s' "$OWN_SCOPE" | hash16)"
  BASE_KEY=""
  if [ -n "$BASE_SCOPE" ]; then
    BASE_KEY="${INPUTS}-$(printf '%s' "$BASE_SCOPE" | hash16)"
  fi
}

# Sets DIGEST to "<file count> <sha256>" over every file under $1, path and
# content, or fails with REASON set. Called directly, never in a command
# substitution, so that REASON reaches the caller. Four digest processes run
# at a time, each into a part file of its own, so that no two processes' lines
# can interleave.
tree_digest() {
  local odd parts sums status
  DIGEST=""
  if ! odd="$(cd "$1" && find . ! -type f ! -type d -print -quit)"; then
    REASON="its files could not be listed"
    return 1
  fi
  if [ -n "$odd" ]; then
    REASON="it holds something that is neither a directory nor a plain file"
    return 1
  fi
  if ! parts="$(mktemp -d "${RUNNER_TEMP:-/tmp}/design-build-cache-digest.XXXXXX")"; then
    REASON="no room for its digest"
    return 1
  fi
  # shellcheck disable=SC2016 # expanded by the inner sh, not here
  (cd "$1" && find . -type f -print0 |
    xargs -0 -r -P 4 -n 256 sh -c 'sha256sum -- "$@" >"$(mktemp "$0/part.XXXXXX")"' "$parts")
  status=$?
  sums=""
  if [ "$status" -eq 0 ]; then
    sums="$(find "$parts" -type f -name 'part.*' -exec cat {} + | LC_ALL=C sort)" || status=1
  fi
  rm -rf "$parts"
  if [ "$status" -ne 0 ]; then
    REASON="its files could not be read"
    return 1
  fi
  if [ -z "$sums" ]; then
    REASON="it holds no file"
    return 1
  fi
  DIGEST="$(printf '%s\n' "$sums" | wc -l | tr -d ' ') $(printf '%s\n' "$sums" | sha256sum | cut -c1-64)"
}

mib_of() { printf '%s' "$(((${1:-0} + 1023) / 1024))"; }

# Discards the cache under key $1, saying why ($2).
discard() {
  warn "DISCARDED the cache under key $1: $2; this job runs a full build"
  if [[ "$1" =~ $KEY_PATTERN ]]; then rm -rf "${STORE:?}/${1:?}"; fi
}

# Copies the cache under key $1 into the checkout when, and only when, the copy
# is exactly what its manifest describes. Otherwise discards it.
restore_key() {
  local key="$1" dir="$STORE/$1" manifest="$STORE/$1/manifest" want started=$SECONDS
  if [ -L "$dir" ] || [ -L "$dir/cache" ] || [ -L "$manifest" ] ||
    [ ! -d "$dir/cache" ] || [ ! -f "$manifest" ]; then
    discard "$key" "it has no manifest or no cache directory, so its save never finished"
    return 1
  fi
  if [ "$(field "$manifest" format)" != "$FORMAT" ] || [ "$(field "$manifest" key)" != "$key" ] ||
    [ "$(field "$manifest" inputs)" != "$INPUTS" ]; then
    discard "$key" "its manifest names another format, key or set of build inputs"
    return 1
  fi
  want="$(field "$manifest" files) $(field "$manifest" digest)"
  if ! mkdir -p .next || ! cp -a --reflink=auto "$dir/cache" "$CACHE.restoring" 2>/dev/null; then
    rm -rf "$CACHE.restoring"
    discard "$key" "it could not be copied into the checkout"
    return 1
  fi
  if ! tree_digest "$CACHE.restoring"; then
    rm -rf "$CACHE.restoring"
    discard "$key" "$REASON"
    return 1
  fi
  if [ "$DIGEST" != "$want" ]; then
    rm -rf "$CACHE.restoring"
    discard "$key" "its content does not match its manifest"
    return 1
  fi
  if ! mv -T "$CACHE.restoring" "$CACHE"; then
    rm -rf "$CACHE.restoring" "$CACHE"
    discard "$key" "its copy could not be put in place"
    return 1
  fi
  touch "$manifest" 2>/dev/null || true
  RESTORED_LINE="restored the cache of $(field "$manifest" scope) (key ${key}, $(field "$manifest" files) files, $(mib_of "$(field "$manifest" kib)") MiB) in $((SECONDS - started)) s"
}

# 0 when this job's build may write the cache (WARM or COLD), 1 when it is OFF.
restore_into_checkout() {
  local key found="" restored="" mode
  gnu_userland || return 1
  if [ -z "${RUNNER_TEMP:-}" ] || [ ! -d "$RUNNER_TEMP" ]; then
    REASON="the runner names no temporary directory"
    return 1
  fi
  if ! STORE="$(store_dir)"; then
    REASON="the runner names no writable work root outside the checkout"
    return 1
  fi
  compute_keys || return 1
  if ! mkdir -p "$STORE" 2>/dev/null || [ ! -w "$STORE" ]; then
    REASON="the store under the work root is not writable"
    return 1
  fi
  # A save that died half-way left a temporary directory; with one job per
  # runner, nothing else can be writing one now.
  rm -rf "$STORE"/.incoming.*
  # Whatever an earlier job left in this checkout is not a cache this job trusts.
  rm -rf "$CACHE" "$CACHE.restoring"
  for key in "$OWN_KEY" "$BASE_KEY"; do
    if [ -n "$key" ] && [ -e "$STORE/$key" ]; then
      found="$key"
      break
    fi
  done
  if [ -n "$found" ] && restore_key "$found"; then
    restored="$found"
  fi
  mode=COLD
  [ -n "$restored" ] && mode=WARM
  if ! printf 'store=%s\nkey=%s\nscope=%s\nrestored=%s\nmode=%s\nstarted=%s\n' \
    "$STORE" "$OWN_KEY" "$OWN_SCOPE" "$restored" "$mode" "$(date +%s)" >"$(state_file)"; then
    rm -rf "$CACHE"
    REASON="this job's state could not be written"
    return 1
  fi
  if [ -n "$restored" ]; then
    note "WARM: ${RESTORED_LINE}"
  elif [ -n "$found" ]; then
    note "COLD: the kept cache was discarded (see above); this job builds from nothing and keeps its cache for ${OWN_SCOPE}"
  else
    note "COLD: nothing is kept for ${OWN_SCOPE}${BASE_SCOPE:+ or ${BASE_SCOPE}} under these build inputs; this job builds from nothing and keeps its cache for the next job"
  fi
}

cmd_restore() {
  local switch=""
  if restore_into_checkout; then
    switch=1
  else
    rm -rf "$CACHE" "$CACHE.restoring" 2>/dev/null
    note "OFF: ${REASON}; this job builds exactly as it did without the cache"
  fi
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'fs-cache=%s\n' "$switch" >>"$GITHUB_OUTPUT" || true
  fi
  return 0
}

# 0 when the filesystem of the store keeps MIN_FREE_PERCENT free (or its usage
# cannot be read: the size cap still applies).
free_enough() {
  local size avail
  read -r size avail < <(df -Pk "$STORE" 2>/dev/null | awk 'NR == 2 { print $2, $4 }') || return 0
  [[ "${size:-}" =~ ^[0-9]+$ && "${avail:-}" =~ ^[0-9]+$ && "$size" -gt 0 ]] || return 0
  ((avail * 100 >= size * MIN_FREE_PERCENT))
}

# Oldest first, until the store holds at most MAX_MIB and its filesystem keeps
# MIN_FREE_PERCENT free. Only names this script writes are ever removed; a kept
# cache without a readable manifest cannot be restored, so it goes first.
prune() {
  local dir name kib used listing total=0 cap=$((MAX_MIB * 1024)) now
  now="$(date +%s)"
  listing="$(
    for dir in "$STORE"/*; do
      name="${dir##*/}"
      [[ "$name" =~ $KEY_PATTERN ]] || continue
      kib="$(field "$dir/manifest" kib)"
      if [[ "$kib" =~ ^[0-9]+$ ]] && used="$(stat -c %Y "$dir/manifest" 2>/dev/null)"; then
        printf '%s %s %s\n' "$used" "$kib" "$name"
      else
        printf '0 0 %s\n' "$name"
      fi
    done | LC_ALL=C sort -n
  )"
  while read -r used kib name; do
    [ -n "${name:-}" ] && total=$((total + kib))
  done <<<"$listing"
  while read -r used kib name; do
    [ -n "${name:-}" ] || continue
    if ((total <= cap)) && [ "$used" != 0 ] && free_enough; then break; fi
    rm -rf "${STORE:?}/${name:?}"
    total=$((total - kib))
    if [ "$used" = 0 ]; then
      say "PRUNED the cache under key ${name} (no readable manifest)"
    else
      say "PRUNED the cache under key ${name} ($(mib_of "$kib") MiB, last used $(((now - used) / 3600)) h ago)"
    fi
  done <<<"$listing"
  say "the store holds $(mib_of "$total") MiB of at most ${MAX_MIB} MiB"
}

cmd_save() {
  local state key scope mode started took="" incoming files digest kib started_save=$SECONDS
  state="$(state_file)"
  if [ -z "${RUNNER_TEMP:-}" ] || [ ! -f "$state" ]; then
    note "NOT KEPT: the restore step left no state for this job"
    return 0
  fi
  STORE="$(field "$state" store)"
  key="$(field "$state" key)"
  scope="$(field "$state" scope)"
  mode="$(field "$state" mode)"
  started="$(field "$state" started)"
  if [[ "$started" =~ ^[0-9]+$ ]]; then took="$(($(date +%s) - started))"; fi
  if ! [[ "$key" =~ $KEY_PATTERN ]] || [ -z "$STORE" ] || [ ! -d "$STORE" ]; then
    note "NOT KEPT: this job's state names no usable key or store"
    return 0
  fi
  if [ "$(field "$state" repeated)" = 1 ]; then
    note "NOT KEPT: the build ran again without the cache (see the build step)"
    return 0
  fi
  if [ ! -d "$CACHE/turbopack" ]; then
    warn "NOT KEPT: the build left no Turbopack cache under ${CACHE}; check that CINATRA_TURBOPACK_BUILD_FS_CACHE still reaches next.config.ts"
    return 0
  fi
  if [ -e "$CACHE/$INVALIDATED" ]; then
    warn "NOT KEPT: Turbopack marked its own cache invalid during this build"
    return 0
  fi
  if ! gnu_userland; then
    note "NOT KEPT: ${REASON}"
    return 0
  fi
  if ! incoming="$(mktemp -d "$STORE/.incoming.XXXXXX")"; then
    note "NOT KEPT: the store is not writable"
    return 0
  fi
  if ! mv -T "$CACHE" "$incoming/cache"; then
    rm -rf "$incoming"
    note "NOT KEPT: the cache could not be moved into the store"
    return 0
  fi
  if ! tree_digest "$incoming/cache"; then
    rm -rf "$incoming"
    note "NOT KEPT: ${REASON}"
    return 0
  fi
  read -r files digest <<<"$DIGEST"
  kib="$(du -sk "$incoming/cache" 2>/dev/null | cut -f1)"
  [[ "$kib" =~ ^[0-9]+$ ]] || kib=0
  if ((kib > MAX_MIB * 1024)); then
    rm -rf "$incoming"
    warn "NOT KEPT: the cache is $(mib_of "$kib") MiB, more than the whole store may hold (${MAX_MIB} MiB)"
    return 0
  fi
  if ! printf 'format=%s\nkey=%s\ninputs=%s\nscope=%s\nfiles=%s\nkib=%s\ndigest=%s\n' \
    "$FORMAT" "$key" "${key%%-*}" "$scope" "$files" "$kib" "$digest" >"$incoming/manifest"; then
    rm -rf "$incoming"
    note "NOT KEPT: its manifest could not be written"
    return 0
  fi
  rm -rf "${STORE:?}/${key:?}"
  if ! mv -T "$incoming" "$STORE/$key"; then
    rm -rf "$incoming"
    note "NOT KEPT: the cache could not be published in the store"
    return 0
  fi
  note "KEPT the cache of ${scope} (key ${key}, ${files} files, $(mib_of "$kib") MiB) in $((SECONDS - started_save)) s; the ${mode:-unknown} build before it took about ${took:-an unknown number of} s"
  prune
  return 0
}

# Runs after a failed `pnpm build`, with its exit code.
cmd_rebuild() {
  local rc="${1:-}" state restored="" store
  [[ "$rc" =~ ^[1-9][0-9]*$ ]] || rc=1
  if [ "${CINATRA_TURBOPACK_BUILD_FS_CACHE:-}" != 1 ]; then
    say "the build failed (exit ${rc}) with the cache off; that is the build's own result"
    return "$rc"
  fi
  state="$(state_file)"
  if [ -n "${RUNNER_TEMP:-}" ] && [ -f "$state" ]; then
    printf 'repeated=1\n' >>"$state" || true
    store="$(field "$state" store)"
    restored="$(field "$state" restored)"
    if [[ "$restored" =~ $KEY_PATTERN ]] && [ -n "$store" ] && [ -d "$store" ]; then
      rm -rf "${store:?}/${restored:?}"
    else
      restored=""
    fi
  fi
  warn "DISCARDED${restored:+ the cache under key ${restored}}: the build failed (exit ${rc}) with the cache on; it runs again from nothing with the cache off, and that build's result is this step's result"
  rm -rf .next
  CINATRA_TURBOPACK_BUILD_FS_CACHE='' pnpm build
}

case "${1:-}" in
  restore) cmd_restore ;;
  save) cmd_save ;;
  rebuild) cmd_rebuild "${2:-}" ;;
  *)
    printf 'usage: %s restore | save | rebuild <exit code>\n' "${0##*/}" >&2
    exit 2
    ;;
esac
