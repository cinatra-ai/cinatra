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
# how the runners are installed, so this script prints the device and inode of
# the file it opened, read through the open descriptor, before it waits: two
# jobs that print the same pair on one machine lock one file. The file is
# opened for reading only and never made again once it exists, so a runner
# account that did not make the file can still lock it.
#
# NO SYMBOLIC LINK IS USED. A candidate that is a symbolic link is skipped
# before it is opened. Bash cannot open a file without following a link, so
# after the open the script compares the open file (through its descriptor)
# with the path itself (not followed). It uses the file only when the path
# still names that same regular file; when the path was replaced, is now a
# link, or either identity cannot be read, the file is not used. A link put in
# place in the instant between the check and the open is opened before it is
# refused (a named pipe there would make the open wait).
#
# WHO HOLDS THE LOCK. The lock belongs to the open file, which this script and
# <command> share: <command> inherits the descriptor. The lock is therefore
# held while either of them runs, so when this script alone is killed,
# <command> keeps the lock until it ends. When <command> ends, this script
# releases the lock (flock -u), so a process that <command> leaves running
# does not keep it. When this script is killed and <command> then leaves a
# process running, that process keeps the lock until it ends; the next job
# waits at most its wait and then builds without the lock. The kernel drops
# the lock when every process that holds the descriptor has ended, also when
# they are killed.
#
# WAIT. At most DESIGN_BUILD_LOCK_WAIT_SECONDS (default 2700, 45 minutes); the
# workflows keep it at most half of the job's timeout. The wait counts against
# that timeout. With the measured worst setup (20 minutes) and a build of up
# to 17 minutes, a design-visual-verify.yml job that waits the full 45 minutes
# ends its build at minute 82 of 90. The cache step, the server start, a
# readiness wait of up to 240 polls 2 s apart and a suite of up to 60 minutes
# come after the build, so such a job can reach its 90-minute limit. In
# design-baselines-refresh.yml (a wait of 20 minutes, a 70-minute job), a job
# that waits the full 20 minutes ends its build at minute 57. That leaves 13
# minutes for the server start, the same readiness wait and a suite of up to
# 30 minutes, so that job can reach its 70-minute limit too.
#
# FAIL OPEN. When the wait is not a whole number of seconds, when flock is not
# on the runner, when no lock file can be opened (or none is shown to be the
# file that its path names), or when the wait ends without the lock, the build
# runs without the lock, as it did before this script, after a line that
# starts with "design build host lock: NOT TAKEN".
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
    note "NOT TAKEN: the wait '${wait_seconds}' is not a whole number of seconds; building without the lock"
    exec "$@"
    ;;
esac

if ! command -v flock >/dev/null 2>&1; then
  note "NOT TAKEN: flock is not on this runner; building without the lock"
  exec "$@"
fi

# The first directory that holds the lock file or lets this job make it. A
# symbolic link is never used, and an existing file is never made again.
lock_file=""
identity=""
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
  if ! { exec 9<"$candidate"; } 2>/dev/null; then continue; fi
  # The open file, read through its descriptor, must be the regular file that
  # the path itself (not followed) names now; otherwise it is not used.
  opened="$(stat -L -c 'device %d inode %i' /proc/self/fd/9 2>/dev/null)" || opened=""
  named="$(stat -c 'device %d inode %i' -- "$candidate" 2>/dev/null)" || named=""
  if [ -n "$opened" ] && [ "$opened" = "$named" ] && [ -f /proc/self/fd/9 ]; then
    lock_file="$candidate"
    identity="$opened"
    break
  fi
  exec 9<&-
  note "not using ${candidate}: the file that was opened is not shown to be the regular file this path names"
done

if [ -z "$lock_file" ]; then
  note "NOT TAKEN: no lock file can be opened or made in ${dirs}; building without the lock"
  "$@"
  exit $?
fi

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

# The build inherits the locked descriptor, so the lock stays taken while the
# build runs, also when this script alone is killed. After the build, flock -u
# releases the lock for every holder of the descriptor, so nothing the build
# leaves running keeps it.
"$@"
rc=$?
flock -u 9
exec 9<&-
note "released after the build (exit ${rc})"
exit "$rc"
