#!/usr/bin/env bash
# build-slot.sh — hold a build slot on the self-hosted runner box for exactly the life of one build command.
#
# Usage: build-slot.sh <weight 1|2> <wait-seconds> -- <command...>
#
# The box (box3) runs six runners, all as user `runner`, in one memory slice that fits two production builds, not
# three. Two slot files stand for the two builds. A slot is a kernel flock(2) lock on the slot file, held through
# an open descriptor by this script and the command it starts, so it lives exactly as long as they do: exit,
# crash, cancel, timeout or a runner restart releases it without any cleanup. No hook, no stored slot state, no
# reclaim rule.
#
# The lock namespace is NOT writable by the jobs and NOT configurable by them. The directory is the constant
# SLOT_DIR (/srv/build-slots, every ancestor root-owned), owned by root, mode 0755, and slot-1 / slot-2 are
# root-owned regular files made once by the operator (HOST.md). The script reads no environment variable for the
# directory or the owner: a job cannot point it at a namespace of its own. A job cannot unlink or replace a slot file, so a held lock can never be bypassed by
# a fresh inode. The script opens each slot READ-ONLY (flock works on a read-only descriptor) and, before taking
# any lock, refuses (exit 78) unless:
#   - the directory is a real directory (not a symlink), owned by the slot owner (uid 0), not group- or
#     world-writable, and not writable by the calling user;
#   - each slot path is a regular file (not a symlink) owned by the slot owner;
#   - the opened descriptor is the same file (device and inode) as the path.
# The last holder of each slot is noted in SLOT_DIR/holders/slot-N (a runner-writable folder) for the timeout
# message only; the lock never reads it. The note is written to a new temp file and renamed over that path, so a
# FIFO or anything else planted there is replaced without being opened, and the write itself is time-bounded.
#
#   weight 1  a build that runs in the runners' slice (pnpm build). It takes slot-1 or slot-2, whichever is free.
#   weight 2  an image build (docker buildx), which runs in the docker daemon outside the slice. It takes slot-1
#             and then slot-2, always in that order, so two weight-2 builds can never deadlock, and it waits
#             for both before it starts. A weight-1 build never waits while it holds a slot, so mixed weights
#             cannot deadlock either.
#
# <wait-seconds> is a hard deadline on the monotonic /proc/uptime clock (bash EPOCHREALTIME, a wall clock, only where /proc is
# missing, i.e. macOS tests): every blocking flock call gets at most the time left, and the deadline is checked again right before
# the command starts; the command never starts after it. When it passes, the command does NOT run: a GitHub ::error:: annotation names the last recorded
# holders and the script exits 75.
#
# Exit codes: the command's own status (128+N when a signal N ended it); 75 no slot within the wait;
# 78 the slot namespace is missing, mutable or not what it must be (on a self-hosted runner), or a slot cannot be
# opened or locked; 69 no flock(1); 64 usage. In every non-command case the command never runs.
#
# GitHub-hosted runners: only when the slot directory does NOT exist AND the runner says RUNNER_ENVIRONMENT=
# github-hosted does the script run the command directly (one log line), because a job routed by a repository
# variable may land on either kind. A present directory is always used, whatever RUNNER_ENVIRONMENT says; on any
# other runner a missing directory fails the step (fail-closed).
#
# Tests run a COPY of this file with the two constants below replaced (test_build_slot.sh); the shipped file
# must keep exactly these two lines, which that harness checks.
set -u

readonly SLOT_DIR=/srv/build-slots
readonly SLOT_OWNER_UID=0

readonly EX_USAGE=64 EX_UNAVAILABLE=69 EX_TEMPFAIL=75 EX_CONFIG=78
readonly CONFLICT=9   # flock -E: the exit code flock uses for "held by someone else" / "timed out"

log() { printf 'build-slot: %s\n' "$*"; }

# Text for a ::error:: annotation or a log line: keep a safe character set, so nothing from a holder note can
# inject a workflow command or spill control characters.
clean() { printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9._/:;,=@+() -' '_' | cut -c1-200; }

fail() { # <exit code> <message>
  printf '::error title=build slot::%s\n' "$(clean "$2")"
  exit "$1"
}

usage() { fail "$EX_USAGE" "usage: build-slot.sh <weight 1|2> <wait-seconds> -- <command...> ($1)"; }

[[ $# -ge 4 ]] || usage "too few arguments"
weight=$1 wait_s=$2
[[ $weight == 1 || $weight == 2 ]] || usage "weight must be 1 or 2"
[[ $wait_s =~ ^[0-9]{1,6}$ ]] || usage "wait-seconds must be a whole number"
wait_s=$((10#$wait_s))
[[ $3 == -- ]] || usage "missing -- before the command"
shift 3
cmd_name=$(clean "${1##*/}")

dir=$SLOT_DIR
owner_uid=$SLOT_OWNER_UID

if [[ ! -e $dir && ! -L $dir ]]; then
  if [[ ${RUNNER_ENVIRONMENT:-} == github-hosted ]]; then
    log "no slot directory on this GitHub-hosted runner; running $cmd_name without a slot"
    exec "$@"
  fi
  fail "$EX_CONFIG" "build slot directory $dir is missing on this self-hosted runner ($(clean "${RUNNER_NAME:-unknown}")); the build did not run. The host needs the one-time step of HOST.md"
fi
command -v flock >/dev/null 2>&1 || fail "$EX_UNAVAILABLE" "flock(1) from util-linux is not installed; the build did not run"

# lstat of a path (no symlink following): "uid mode dev inode type". GNU stat first (Linux), BSD stat for tests.
path_info() {
  stat -c '%u %a %d %i %F' -- "$1" 2>/dev/null || stat -f '%u %Lp %d %i %HT' -- "$1" 2>/dev/null
}
# device and inode of the file an open descriptor refers to. On Linux /dev/fd/N leads to the file itself (GNU
# stat). BSD stat (macOS tests only) reports the fd device's number, so there the device is "-" and only the
# inode is compared.
fd_ident() {
  stat -L -c '%d %i' "/dev/fd/$1" 2>/dev/null || stat -L -f '- %i' "/dev/fd/$1" 2>/dev/null
}

# The namespace must not be mutable by the jobs.
info=$(path_info "$dir") || fail "$EX_CONFIG" "cannot read $dir; the build did not run"
read -r d_uid d_mode _ _ d_type <<<"$info"
d_type=${d_type,,}
[[ $d_type == directory ]] || fail "$EX_CONFIG" "build slot path $dir is a $d_type, not a directory; the build did not run"
[[ $d_uid == "$owner_uid" ]] ||
  fail "$EX_CONFIG" "build slot directory $dir is owned by uid $d_uid, not uid $owner_uid; the build did not run"
(((8#$d_mode & 8#022) == 0)) ||
  fail "$EX_CONFIG" "build slot directory $dir is group- or world-writable (mode $d_mode); the build did not run"
if [[ $EUID != 0 && -w $dir ]]; then
  fail "$EX_CONFIG" "build slot directory $dir is writable by this job's user, so its slot files could be replaced; the build did not run"
fi

# Monotonic time in hundredths of a second: /proc/uptime (Linux, the runner box). Where it is missing (macOS,
# tests only) bash's EPOCHREALTIME: bash SECONDS would be no more monotonic and only whole seconds.
if [[ -r /proc/uptime ]]; then
  now_cs() { local up _; read -r up _ </proc/uptime; up=${up/./}; printf '%s' "$((10#$up))"; }
else
  now_cs() { local t=${EPOCHREALTIME/,/.}; printf '%s' "$((10#${t%.*} * 100 + 10#${t#*.} / 10000))"; }
fi

slot_file() { printf '%s/slot-%s' "$dir" "$1"; }
holder_file() { printf '%s/holders/slot-%s' "$dir" "$1"; }

fd_1="" fd_2=""      # open fd of slot-1 / slot-2 ("" when not open)
held=()              # slot numbers this script holds, in order taken

fd_of() { if [[ $1 == 1 ]]; then printf '%s' "$fd_1"; else printf '%s' "$fd_2"; fi; }

open_slot() { # <n>: verify the slot path, open it read-only, verify the descriptor is that same file
  local f info s_uid s_dev s_ino s_type fid
  f=$(slot_file "$1")
  info=$(path_info "$f") || fail "$EX_CONFIG" "build slot file $f is missing; the build did not run"
  read -r s_uid _ s_dev s_ino s_type <<<"$info"
  s_type=${s_type,,}
  # GNU stat says "regular empty file" for an empty file (the slot files are empty), BSD "regular file"
  [[ $s_type == "regular file" || $s_type == "regular empty file" ]] || fail "$EX_CONFIG" "build slot $f is a $s_type, not a regular file; the build did not run"
  [[ $s_uid == "$owner_uid" ]] || fail "$EX_CONFIG" "build slot $f is owned by uid $s_uid, not uid $owner_uid; the build did not run"
  case $1 in
    1) exec {fd_1}<"$f" ;;
    2) exec {fd_2}<"$f" ;;
  esac 2>/dev/null || fail "$EX_CONFIG" "cannot open build slot file $f for reading; the build did not run"
  fid=$(fd_ident "$(fd_of "$1")") || fail "$EX_CONFIG" "cannot identify the open build slot $f; the build did not run"
  [[ $fid == "$s_dev $s_ino" || $fid == "- $s_ino" ]] || fail "$EX_CONFIG" "build slot $f changed while it was opened; the build did not run"
}

close_slot() { # <n>
  case $1 in
    1) [[ -n $fd_1 ]] && exec {fd_1}<&-; fd_1="" ;;
    2) [[ -n $fd_2 ]] && exec {fd_2}<&-; fd_2="" ;;
  esac
}

release_all() {
  close_slot 1
  close_slot 2
  held=()
}

start_cs=$(now_cs)
deadline_cs=$((start_cs + wait_s * 100))
next_note_cs=$((start_cs + 6000))
waited_s() { printf '%s' "$((($(now_cs) - start_cs) / 100))"; }

# try_lock <n> <hundredths>: 0 = no wait (flock -n); otherwise block at most that long. Returns 0 taken, 1 busy.
# Any other flock result is an error: fail closed.
try_lock() {
  local rc
  if (($2 <= 0)); then
    flock -n -E "$CONFLICT" "$(fd_of "$1")"
  else
    flock -w "$(($2 / 100)).$(printf '%02d' $(($2 % 100)))" -E "$CONFLICT" "$(fd_of "$1")"
  fi
  rc=$?
  case $rc in
    0) held+=("$1"); return 0 ;;
    "$CONFLICT") return 1 ;;
    *) release_all; fail "$EX_CONFIG" "flock failed on $(slot_file "$1") with status $rc; the build did not run" ;;
  esac
}

record_holder() { # informational only; a missing holders folder or a failed write is not an error
  local n h line
  line=$(printf 'runner=%s repo=%s run=%s attempt=%s job=%s weight=%s pid=%s' \
    "${RUNNER_NAME:--}" "${GITHUB_REPOSITORY:--}" "${GITHUB_RUN_ID:--}" "${GITHUB_RUN_ATTEMPT:--}" \
    "${GITHUB_JOB:--}" "$weight" "$$")
  for n in "${held[@]}"; do
    h=$(holder_file "$n")
    [[ -d ${h%/*} && ! -L ${h%/*} && ! -d $h ]] || continue
    # A new temp file (mktemp: O_EXCL, never an existing path), filled by a writer that holds no slot fd and is
    # bounded by timeout(1), then renamed over holders/slot-N: the holder path itself is never opened.
    (
      close_slot 1
      close_slot 2
      tmp=$(mktemp "${h%/*}/.slot-$n.XXXXXX") || exit 0
      # shellcheck disable=SC2016  # $1 and $2 belong to the inner bash
      if timeout -k 1 2 bash -c 'printf "%s\n" "$2" >"$1"' _ "$tmp" "$line"; then
        mv -f -- "$tmp" "$h" || rm -f -- "$tmp"
      else
        rm -f -- "$tmp"
      fi
    ) </dev/null >/dev/null 2>&1 || true
  done
}

holders() { # read only regular holder notes, each read bounded: a FIFO planted there cannot block the timeout
  local n h line out=""
  for n in 1 2; do
    h=$(holder_file "$n") line=""
    if [[ -f $h && ! -L $h ]]; then
      line=$( { timeout -k 1 1 head -c 300 -- "$h" | head -n 1; } 2>/dev/null) || line=""
    fi
    out+="slot-$n: ${line:-unknown}; "
  done
  printf '%s' "${out%; }"
}

time_out() {
  local h
  release_all
  h=$(holders)
  fail "$EX_TEMPFAIL" "no build slot (weight $weight) within $wait_s s on $(clean "${RUNNER_NAME:-this runner}"); the build did not run. Last recorded holders: $h. Re-run the job when the box is less busy."
}

note_wait() {
  if (($(now_cs) >= next_note_cs)); then
    log "weight $weight still waiting for a slot ($(waited_s) of $wait_s s)"
    next_note_cs=$((next_note_cs + 6000))
  fi
}

# The time left, at most 1 s (so signals and the other slot are looked at every second). 0 or less: past the deadline.
slice_cs() {
  local left=$((deadline_cs - $(now_cs)))
  ((left > 100)) && left=100
  printf '%s' "$left"
}

# Signals while waiting: nothing runs yet, so just leave (closing the fds frees any slot taken).
trap 'release_all; exit 130' INT
trap 'release_all; exit 143' TERM
trap 'release_all; exit 129' HUP

open_slot 1
open_slot 2

if ((weight == 1)); then
  turn=1
  # The first look (no wait) is at the start, inside the deadline even for a wait of 0.
  if ! try_lock 1 0 && ! try_lock 2 0; then
    while :; do
      s=$(slice_cs)
      ((s > 0)) || time_out
      note_wait
      try_lock "$turn" "$s" && break      # block on one slot for the time left (at most 1 s), alternating
      (($(slice_cs) > 0)) || time_out
      try_lock "$((3 - turn))" 0 && break # then a quick look at the other one
      turn=$((3 - turn))
    done
  fi
  close_slot "$((3 - held[0]))"   # weight 1 keeps only the slot it took
else
  for n in 1 2; do
    try_lock "$n" 0 && continue
    while :; do
      s=$(slice_cs)
      ((s > 0)) || time_out
      note_wait
      try_lock "$n" "$s" && break
    done
  done
fi

past_deadline() { ((wait_s > 0 && $(now_cs) > deadline_cs)); }

# Never start after the deadline: a lock that came in later than it (scheduling delay) is given back.
past_deadline && time_out
record_holder
# ... and once more after the holder note, immediately before the launch.
past_deadline && time_out
slots_text=$(printf 'slot-%s+' "${held[@]}"); slots_text=${slots_text%+}
log "weight $weight took $slots_text after waiting $(waited_s) s (limit $wait_s s); running $cmd_name"
hold_start_cs=$(now_cs)

# The command runs as a child that inherits the slot fds: the lock also lives while the command lives, even if
# this script is killed. Job control gives it its own process group, so a forwarded signal reaches the whole
# build tree, and SIGINT is not ignored the way it is for a plain background job of a non-interactive shell.
set -m
"$@" &
child=$!
set +m

# shellcheck disable=SC2329  # called from the traps below
forward() { # <signal name>
  kill -s "$1" -- "-$child" 2>/dev/null || kill -s "$1" "$child" 2>/dev/null || true
}
trap 'forward INT' INT
trap 'forward TERM' TERM
trap 'forward HUP' HUP

while :; do
  wait "$child"
  rc=$?
  kill -0 "$child" 2>/dev/null || break   # still alive: the wait was cut short by a forwarded signal
done
# If a signal cut the last wait short just as the child ended, read its real status (bash keeps it).
wait "$child" 2>/dev/null
rc2=$?
((rc2 != 127)) && rc=$rc2

held_s=$((($(now_cs) - hold_start_cs) / 100))
release_all
log "weight $weight released $slots_text after $held_s s; $cmd_name exited $rc"
exit "$rc"
