#!/usr/bin/env bash
# design-build-host-lock.sh <command> [<argument>...]
#
# Runs <command> (the design suite's production build) under ONE lock for the
# whole self-hosted machine, so that two design builds on one machine do not
# compile at the same time. It returns the exit code of <command>.
#
# WHY. The Turbopack production build of the design suite needs about 24.5 GB
# of memory cold (the measurement is in design-visual-verify.yml, on the
# restore step). Several self-hosted runners share one machine, and on that
# machine the hosted runners' swap step does not run. Since 2026-10-26, 12 of
# 32 design builds there were killed in the compile with exit 137. All 12 had
# at least one other design build running at the same time (12 of 22 such
# builds died); none of the 10 builds that ran alone died. A build that waits
# here holds its runner, but no build memory.
#
# WHERE THE LOCK IS. The file cinatra-design-build.lock in the first directory
# of DESIGN_BUILD_LOCK_DIRS (default "/run/lock:/tmp") that holds the file or
# lets this job make it. /run/lock comes first because a service's private
# /tmp (systemd PrivateTmp) does not hide it. The lock works only when every
# runner of the machine opens the SAME file. The repository does not record
# how the runners are installed, so this script prints the file's device and
# inode before it waits: two jobs that print the same pair on one machine use
# one lock. The file is opened for reading only and never made again once it
# exists, so a runner account that did not make the file can still lock it.
#
# WAIT. At most DESIGN_BUILD_LOCK_WAIT_SECONDS (default 2700, 45 minutes), so a
# job that waits still has time for its build and its suite inside the job's
# timeout. The kernel drops the lock when its holder ends, also when the
# holder is killed, so a dead job cannot block the next one.
#
# FAIL OPEN. When flock is not on the runner, when no lock file can be opened,
# or when the wait ends without the lock, the build runs without the lock, as
# it did before this script, after a line that starts with
# "design build host lock: NOT TAKEN".
#
# HOSTED RUNNERS. DESIGN_BUILD_LOCK_RUNNER_ENVIRONMENT carries the step's
# ${{ runner.environment }}, the same value the workflows' host steps read. Any
# value other than "self-hosted" runs <command> at once, without a lock: a
# GitHub-hosted runner is one machine for one job, and the swap step serves it.
set -uo pipefail

LOCK_NAME=cinatra-design-build.lock
DEFAULT_WAIT_SECONDS=2700

note() { printf 'design build host lock: %s\n' "$*"; }

if [ "$#" -eq 0 ]; then
  echo "usage: design-build-host-lock.sh <command> [<argument>...]" >&2
  exit 2
fi

runner_environment="${DESIGN_BUILD_LOCK_RUNNER_ENVIRONMENT:-}"
if [ "$runner_environment" != "self-hosted" ]; then
  note "not used: the runner environment is ${runner_environment:-unset}, not self-hosted; building"
  exec "$@"
fi

wait_seconds="${DESIGN_BUILD_LOCK_WAIT_SECONDS:-$DEFAULT_WAIT_SECONDS}"
case "$wait_seconds" in
  '' | *[!0-9]*)
    note "the wait '${wait_seconds}' is not a whole number of seconds; waiting ${DEFAULT_WAIT_SECONDS} s"
    wait_seconds=$DEFAULT_WAIT_SECONDS
    ;;
esac

if ! command -v flock >/dev/null 2>&1; then
  note "NOT TAKEN: flock is not on this runner; building without the lock"
  exec "$@"
fi

# The first directory that holds the lock file or lets this job make it. A
# symbolic link is never used, and an existing file is never made again.
lock_file=""
dirs="${DESIGN_BUILD_LOCK_DIRS:-/run/lock:/tmp}"
IFS=: read -r -a lock_dirs <<<"$dirs"
for dir in "${lock_dirs[@]}"; do
  if [ -z "$dir" ] || [ ! -d "$dir" ]; then continue; fi
  candidate="${dir%/}/${LOCK_NAME}"
  [ -L "$candidate" ] && continue
  if [ ! -e "$candidate" ]; then
    (umask 0022 && : >>"$candidate") 2>/dev/null || true
  fi
  if [ ! -f "$candidate" ] || [ -L "$candidate" ]; then continue; fi
  if { exec 9<"$candidate"; } 2>/dev/null; then
    lock_file="$candidate"
    break
  fi
done

if [ -z "$lock_file" ]; then
  note "NOT TAKEN: no lock file can be opened or made in ${dirs}; building without the lock"
  "$@"
  exit $?
fi

identity="$(stat -L -c 'device %d inode %i' "$lock_file" 2>/dev/null)" || identity="device and inode unreadable"
note "lock file ${lock_file} (${identity}), runner ${RUNNER_NAME:-unnamed}"

started=$SECONDS
if ! flock -n 9 2>/dev/null; then
  note "held by another design build on this machine; waiting up to ${wait_seconds} s"
  if ! flock -w "$wait_seconds" 9 2>/dev/null; then
    note "NOT TAKEN: the lock was not free after $((SECONDS - started)) s; building without the lock"
    exec 9<&-
    "$@"
    exit $?
  fi
fi
note "TAKEN after $((SECONDS - started)) s; building"

# The build does not inherit the lock's descriptor, so nothing it leaves
# running can keep the lock after this script ends.
"$@" 9<&-
rc=$?
exec 9<&-
note "released after the build (exit ${rc})"
exit "$rc"
