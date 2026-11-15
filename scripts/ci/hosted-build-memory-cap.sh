#!/usr/bin/env bash
# hosted-build-memory-cap.sh run <command> [<argument>...]
# hosted-build-memory-cap.sh buildx-opts
#
# Keeps the production app build from taking the memory that the GitHub-hosted
# runner itself needs.
#
# WHY. On the hosted runner (about 15.6 GiB of RAM) the Turbopack compile of
# `next build` holds the machine at its memory size: a green /agents smoke
# build sampled every 5 s had one build process at 14.6 GB of resident memory
# and under 500 MB available for about four minutes. The worker cap
# (CINATRA_BUILD_CPUS=1) does not touch that phase: it bounds only the
# page-data workers, which run after the compile. Turbopack's memory is native,
# so neither NODE_OPTIONS nor experimental.turbopackMemoryLimit bounds it
# (docs/internals/workflows/constrained-host-builds.md). When the build needs
# a little more, the kernel takes the memory from every process on the
# machine, including the runner's own processes, and swaps. The runner then
# stops answering: the step's timeout never fires, the job is cancelled about
# 10 minutes after its job limit, and the job log is never uploaded.
#
# WHAT. `run` starts <command> in a cgroup of its own whose memory.max is the
# machine's RAM minus a reserve (default 2048 MiB). When the build reaches that
# size, the kernel reclaims and swaps the build's own pages only; the memory of
# the runner and the service containers stays where it is. The build can get
# slow, but the runner keeps answering, so the step's own timeout ends it with
# a log, and an out-of-memory kill inside the cgroup is a red step with a
# clear message. Swap stays as the job set it up (unlimited for the build)
# unless CINATRA_BUILD_SWAP_MAX_MIB is set. A cancel or a step timeout (SIGINT,
# SIGTERM or SIGHUP to the wrapper) still moves the wrapper back and removes
# the cgroup.
#
# `buildx-opts` is the same cap for a docker image build: the `next build` of
# the root Dockerfile runs inside the buildkit container, so the cap goes on
# that container. It writes the step output `driver_opts` for
# docker/setup-buildx-action's `driver-opts`: memory=<cap>m and memory-swap=-1
# (swap as the job set it up; without it Docker would allow only as much swap
# as the memory cap), or memory-swap=<cap + CINATRA_BUILD_SWAP_MAX_MIB>m when
# that is set.
#
# WHERE. Only on a GitHub-hosted runner (RUNNER_ENVIRONMENT=github-hosted). On
# any other runner `run` runs <command> unchanged and `buildx-opts` writes an
# empty value, so a self-hosted machine keeps its own memory rules.
# CINATRA_BUILD_MEMORY_CAP=0 turns the cap off everywhere.
#
# IF THE CAP CANNOT BE SET on a GitHub-hosted runner (no cgroup v2 memory
# controller, a machine under 4096 MiB plus the reserve, a bad setting, a
# write refused), it FAILS CLOSED: one ::error:: line naming the reason, the
# build does not run, and the exit code is 125. An uncapped build is the
# build that loses the runner. CINATRA_BUILD_MEMORY_CAP=0 is the explicit way
# to build uncapped. Otherwise `run` returns the exit code of <command>.
#
# Test seams (tests only): CINATRA_MEMCAP_MEMINFO (default /proc/meminfo),
# CINATRA_MEMCAP_CGROUP_ROOT (default /sys/fs/cgroup), CINATRA_MEMCAP_SUDO
# (default sudo; empty runs the writes directly).
set -uo pipefail

MEMINFO="${CINATRA_MEMCAP_MEMINFO:-/proc/meminfo}"
CGROOT="${CINATRA_MEMCAP_CGROUP_ROOT:-/sys/fs/cgroup}"
SUDO="${CINATRA_MEMCAP_SUDO-sudo}"
RESERVE_MIB="${CINATRA_BUILD_MEMORY_RESERVE_MIB:-2048}"
SWAP_MAX_MIB="${CINATRA_BUILD_SWAP_MAX_MIB:-}"
MIN_CAP_MIB=4096
REFUSED_RC=125

as_root() {
  if [ -n "$SUDO" ]; then "$SUDO" "$@"; else "$@"; fi
}

# write_file <file> <value>: write as root; fail when the write is refused.
write_file() {
  printf '%s\n' "$2" | as_root tee "$1" >/dev/null 2>&1
}

is_whole() {
  case "$1" in '' | *[!0-9]*) return 1 ;; *) return 0 ;; esac
}

# refuse <reason>: the one-line fail-closed error of a hosted run.
refuse() {
  echo "::error title=build memory cap::cannot cap the build memory: ${1}; the build does not run (set CINATRA_BUILD_MEMORY_CAP=0 to build uncapped)"
  return "$REFUSED_RC"
}

# Prints the reason and returns 1 when the cap does not apply here.
cap_applies() {
  if [ "${CINATRA_BUILD_MEMORY_CAP:-}" = "0" ]; then
    echo "turned off (CINATRA_BUILD_MEMORY_CAP=0)"
    return 1
  fi
  if [ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]; then
    echo "not a GitHub-hosted runner (RUNNER_ENVIRONMENT=${RUNNER_ENVIRONMENT:-unset})"
    return 1
  fi
  return 0
}

# Sets CAP_MIB and TOTAL_MIB, or prints the reason and returns 1.
compute_cap() {
  local total_kb
  total_kb="$(awk '/^MemTotal:/ { print $2; exit }' "$MEMINFO" 2>/dev/null || true)"
  if ! is_whole "$total_kb"; then
    echo "cannot read MemTotal from $MEMINFO"
    return 1
  fi
  if ! is_whole "$RESERVE_MIB"; then
    echo "CINATRA_BUILD_MEMORY_RESERVE_MIB=$RESERVE_MIB is not a whole number of MiB"
    return 1
  fi
  if [ -n "$SWAP_MAX_MIB" ] && ! is_whole "$SWAP_MAX_MIB"; then
    echo "CINATRA_BUILD_SWAP_MAX_MIB=$SWAP_MAX_MIB is not a whole number of MiB"
    return 1
  fi
  TOTAL_MIB=$((total_kb / 1024))
  CAP_MIB=$((TOTAL_MIB - RESERVE_MIB))
  if [ "$CAP_MIB" -lt "$MIN_CAP_MIB" ]; then
    echo "the machine has ${TOTAL_MIB} MiB; a cap of ${CAP_MIB} MiB after the ${RESERVE_MIB} MiB reserve is under ${MIN_CAP_MIB} MiB"
    return 1
  fi
  return 0
}

swap_text() {
  if [ -n "$SWAP_MAX_MIB" ]; then echo "${SWAP_MAX_MIB} MiB of swap"; else echo "swap as the job set it up"; fi
}

cmd_buildx_opts() {
  local out="${GITHUB_OUTPUT:-/dev/stdout}" reason opts=""
  if reason="$(cap_applies)"; then
    if reason="$(compute_cap)"; then
      compute_cap >/dev/null
      opts="memory=${CAP_MIB}m"
      if [ -n "$SWAP_MAX_MIB" ]; then
        opts="${opts}
memory-swap=$((CAP_MIB + SWAP_MAX_MIB))m"
      else
        opts="${opts}
memory-swap=-1"
      fi
      echo "::notice title=build memory cap::buildkit container capped at ${CAP_MIB} MiB of RAM (machine ${TOTAL_MIB} MiB, reserve ${RESERVE_MIB} MiB), $(swap_text)"
    else
      refuse "$reason"
      return $?
    fi
  else
    echo "build memory cap: not applied: ${reason}"
  fi
  {
    echo "driver_opts<<CINATRA_MEMCAP_EOF"
    [ -n "$opts" ] && printf '%s\n' "$opts"
    echo "CINATRA_MEMCAP_EOF"
  } >>"$out"
  return 0
}

# Prints the reason and returns 1 when cgroup v2 with the memory controller
# is not usable under CGROOT.
cgroup_ready() {
  if [ ! -r "$CGROOT/cgroup.controllers" ]; then
    echo "no cgroup v2 hierarchy at $CGROOT"
    return 1
  fi
  if ! grep -qw memory "$CGROOT/cgroup.controllers"; then
    echo "the cgroup v2 memory controller is not available at $CGROOT"
    return 1
  fi
  if ! grep -qw memory "$CGROOT/cgroup.subtree_control" 2>/dev/null; then
    if ! write_file "$CGROOT/cgroup.subtree_control" "+memory" \
      || ! grep -qw memory "$CGROOT/cgroup.subtree_control" 2>/dev/null; then
      echo "cannot enable the memory controller for child cgroups at $CGROOT"
      return 1
    fi
  fi
  return 0
}

read_value() {
  local v
  v="$(cat "$1" 2>/dev/null || true)"
  if is_whole "$v"; then echo "$((v / 1024 / 1024)) MiB"; else echo "n/a"; fi
}

event_count() {
  local v
  v="$(awk -v k="$2" '$1 == k { print $2; exit }' "$1" 2>/dev/null || true)"
  if is_whole "$v"; then echo "$v"; else echo 0; fi
}

CG=""
# Moves the wrapper back to the root cgroup and removes its own (best effort;
# safe to call twice).
leave_cgroup() {
  [ -n "$CG" ] || return 0
  write_file "$CGROOT/cgroup.procs" "$$" || true
  as_root rmdir "$CG" 2>/dev/null || true
  CG=""
}

# A cancel or a step timeout: clean up, then end with the signal's exit code.
# Bash runs this after the foreground build has ended.
# shellcheck disable=SC2329  # invoked by the traps in cmd_run
on_signal() {
  trap - INT TERM HUP
  if [ -n "$CG" ]; then echo "build memory cap: stopped by a signal; removing the cgroup $CG"; fi
  leave_cgroup
  exit "$1"
}

cmd_run() {
  if [ "$#" -eq 0 ]; then
    echo "usage: hosted-build-memory-cap.sh run <command> [<argument>...]" >&2
    return 2
  fi
  local reason rc oom maxhits
  if ! reason="$(cap_applies)"; then
    echo "build memory cap: not applied: ${reason}"
    "$@"
    return $?
  fi
  if ! reason="$(compute_cap)" || ! reason="$(cgroup_ready)"; then
    refuse "$reason"
    return $?
  fi
  compute_cap >/dev/null
  CG="$CGROOT/cinatra-build-$$"
  trap 'on_signal 130' INT
  trap 'on_signal 143' TERM
  trap 'on_signal 129' HUP
  if ! as_root mkdir -p "$CG" 2>/dev/null \
    || ! write_file "$CG/memory.max" "$((CAP_MIB * 1024 * 1024))" \
    || { [ -n "$SWAP_MAX_MIB" ] && ! write_file "$CG/memory.swap.max" "$((SWAP_MAX_MIB * 1024 * 1024))"; } \
    || ! write_file "$CG/cgroup.procs" "$$"; then
    reason="cannot set up the cgroup $CG"
    leave_cgroup
    refuse "$reason"
    return $?
  fi
  local cg="$CG"
  echo "::notice title=build memory cap::the build runs capped at ${CAP_MIB} MiB of RAM (machine ${TOTAL_MIB} MiB, reserve ${RESERVE_MIB} MiB), $(swap_text); cgroup $cg"
  export CINATRA_BUILD_CGROUP="$cg"
  "$@"
  rc=$?
  oom="$(event_count "$cg/memory.events" oom_kill)"
  maxhits="$(event_count "$cg/memory.events" max)"
  echo "build memory cap: exit ${rc}; peak RAM $(read_value "$cg/memory.peak"), peak swap $(read_value "$cg/memory.swap.peak"); reached the cap ${maxhits} times; out-of-memory kills ${oom}"
  if [ "$rc" -ne 0 ] && [ "$oom" -gt 0 ]; then
    echo "::error title=build memory cap::the build was killed for memory: it used the whole cap of ${CAP_MIB} MiB of RAM and $(swap_text). The runner stayed responsive, so this is a red step with a log instead of a lost runner."
  fi
  leave_cgroup
  return "$rc"
}

case "${1:-}" in
  run)
    shift
    cmd_run "$@"
    exit $?
    ;;
  buildx-opts)
    cmd_buildx_opts
    exit $?
    ;;
  *)
    echo "usage: hosted-build-memory-cap.sh run <command> [<argument>...] | buildx-opts" >&2
    exit 2
    ;;
esac
