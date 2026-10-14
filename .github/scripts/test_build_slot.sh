#!/usr/bin/env bash
# test_build_slot.sh — behaviour tests for build-slot.sh. Plain bash, no bats.
#
# Runs on Linux with util-linux flock (the CI runners, box3). Where no flock(1) is on PATH (macOS) it puts the
# test-only perl stand-in from test-bin/ first on PATH and says so; that stand-in uses the same flock(2) call.
#
# Usage: bash test_build_slot.sh            (all cases)
#        bash test_build_slot.sh t_exit     (cases whose name starts with t_exit)
# Env:   BUILD_SLOT_SCRIPT  the wrapper under test (default: build-slot.sh beside this file)
#        BUILD_SLOT_TEST_ROOT  a NEW directory for the run (default: $RUNNER_TEMP or this dir, + build-slot-test.<pid>)
set -u

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
W=${BUILD_SLOT_SCRIPT:-$HERE/build-slot.sh}
ROOT=${BUILD_SLOT_TEST_ROOT:-${RUNNER_TEMP:-$HERE}/build-slot-test.$$}
FILTER=${1:-t_}

if ! command -v flock >/dev/null 2>&1; then
  PATH="$HERE/test-bin:$PATH"
  FLOCK_IMPL="test-bin/flock (perl flock(2) stand-in; no util-linux flock on this machine)"
else
  FLOCK_IMPL="$(command -v flock) ($(flock --version 2>&1 | head -n 1))"
fi
export PATH

# The shipped wrapper hard-codes SLOT_DIR=/srv/build-slots and SLOT_OWNER_UID=0 and reads no override. The tests
# run COPIES of it with those two lines replaced (wrap_for), so the test user stands in for root: each test slot
# directory is made read-only (0555) after its files, so the test user cannot replace a slot, exactly as `runner`
# cannot on box3. t_shipped_constants checks the shipped file itself.
ME=$(id -u)

mkdir "$ROOT" || { echo "cannot create a new test root $ROOT"; exit 2; }
ROOT=$(cd "$ROOT" && pwd)
OWN_ROOT=$ROOT
mkdir "$ROOT/wrappers"

wrap_for() { # <dir> [uid]: print the path of a copy of the wrapper whose two constants are <dir> and <uid>
  local d=$1 u=${2:-$ME} f
  f="$ROOT/wrappers/$(printf '%s_%s' "$d" "$u" | LC_ALL=C tr -c 'A-Za-z0-9' '_').sh"
  if [[ ! -f $f ]]; then
    sed -e "s|^readonly SLOT_DIR=/srv/build-slots\$|readonly SLOT_DIR=$d|" \
        -e "s|^readonly SLOT_OWNER_UID=0\$|readonly SLOT_OWNER_UID=$u|" "$W" >"$f"
    if ! grep -qx "readonly SLOT_DIR=$d" "$f" || ! grep -qx "readonly SLOT_OWNER_UID=$u" "$f"; then
      echo "cannot patch the constants of $W" >&2; rm -f "$f"; return 1
    fi
  fi
  printf '%s' "$f"
}
WS=$(wrap_for "$ROOT/slots") || exit 2   # the copy most cases use

PASS=0 FAILED=0
declare -A JOBPID=()

kill_jobs() { # end every job this harness started (wrapper and command group); used between tests and at exit
  local n p
  for n in "${!JOBPID[@]}"; do
    if [[ -s $ROOT/$n.pid ]]; then p=$(<"$ROOT/$n.pid"); kill -KILL -- "-$p" 2>/dev/null; kill -KILL "$p" 2>/dev/null; fi
    kill -KILL "${JOBPID[$n]}" 2>/dev/null
  done
  wait 2>/dev/null
  JOBPID=()
}

cleanup() {
  kill_jobs
  chmod -R u+rwx "$OWN_ROOT" 2>/dev/null
  [[ -n $OWN_ROOT && -d $OWN_ROOT ]] && rm -rf -- "$OWN_ROOT"   # made new by this run (mkdir fails on an existing path)
}
trap cleanup EXIT

ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  { FAILED=$((FAILED + 1)); printf '  FAIL %s\n' "$1"; [[ -n ${2:-} && -f $2 ]] && sed 's/^/       | /' "$2"; }
check() { # <description> <command...>: passes when the command succeeds
  local d=$1; shift
  if "$@"; then ok "$d"; else bad "$d" "${LASTLOG:-}"; fi
}

wait_file() { # <path> <seconds>: 0 once the file exists
  local end=$((SECONDS + $2 + 1))
  while ((SECONDS < end)); do [[ -e $1 ]] && return 0; sleep 0.05; done
  [[ -e $1 ]]
}
absent_for() { # <path> <seconds>: 0 when the file does NOT appear within the time
  ! wait_file "$1" "$2"
}

make_ns() { # <dir>: a protected slot namespace: slot-1, slot-2, holders/ (0700), then the dir made 0555
  mkdir -m 0755 "$1" && : >"$1/slot-1" && : >"$1/slot-2" && chmod 0644 "$1/slot-1" "$1/slot-2" &&
    mkdir -m 0700 "$1/holders" && chmod 0555 "$1"
}

reset_slots() {
  kill_jobs
  chmod -R u+w "$ROOT" 2>/dev/null
  rm -rf -- "$ROOT/slots" "$ROOT"/*.started "$ROOT"/*.release "$ROOT"/*.done "$ROOT"/*.pid "$ROOT"/*.term "$ROOT"/*.int "$ROOT"/*.log 2>/dev/null
  make_ns "$ROOT/slots"
}

# job <name> <weight> <wait> [exit code]: starts the wrapper in the background around a command that marks
# <name>.started, writes its pid, waits for <name>.release, then exits with the code. Forwarded TERM/INT are
# recorded as <name>.term / <name>.int and end the command with 7 / 8.
job() {
  local n=$1 w=$2 t=$3 code=${4:-0}
  # Job control on while starting it: a background job of a non-interactive shell starts with SIGINT ignored,
  # and a signal ignored on entry cannot be trapped. On a runner the wrapper is a foreground step command.
  set -m
  RUNNER_ENVIRONMENT=self-hosted RUNNER_NAME=runner-$n GITHUB_JOB=$n \
  GITHUB_REPOSITORY=test/repo GITHUB_RUN_ID=1 GITHUB_RUN_ATTEMPT=1 SECRET_TOKEN=s3cr3t-value-$n \
    bash "$WS" "$w" "$t" -- bash -c '
      trap "touch \"$1.term\"; exit 7" TERM
      trap "touch \"$1.int\"; exit 8" INT
      echo $$ >"$1.pid"; touch "$1.started"
      while [ ! -e "$1.release" ]; do sleep 0.05; done
      touch "$1.done"; exit "$2"' _ "$ROOT/$n" "$code" >"$ROOT/$n.log" 2>&1 &
  JOBPID[$n]=$!
  set +m
}
release() { touch "$ROOT/$1.release"; }
rc_of() { # <name>: wait for the wrapper (in this shell, never in a $(...) subshell); its exit code goes to RC.
  # Watchdog: a wrapper still running after 60 s is killed and RC is 999, so a fault fails a case, never hangs.
  local end=$((SECONDS + 60)) p=${JOBPID[$1]}
  while kill -0 "$p" 2>/dev/null && ((SECONDS < end)); do sleep 0.05; done
  if kill -0 "$p" 2>/dev/null; then
    kill -KILL "$p" 2>/dev/null; wait "$p" 2>/dev/null
    [[ -s $ROOT/$1.pid ]] && kill -KILL -- "-$(<"$ROOT/$1.pid")" 2>/dev/null   # and its command's group
    unset 'JOBPID[$1]'; RC=999; return
  fi
  wait "$p"; RC=$?
  unset 'JOBPID[$1]'
}
started() { wait_file "$ROOT/$1.started" "${2:-5}"; }
not_started() { absent_for "$ROOT/$1.started" "${2:-2}"; }
log_has() { grep -q -- "$2" "$ROOT/$1.log"; }
log_lacks() { ! grep -q -- "$2" "$ROOT/$1.log"; }

# ---------------------------------------------------------------------------------------------------------
t_two_run_third_waits() {
  reset_slots
  job A 1 30; job B 1 30
  check "two weight-1 jobs run together (A)" started A
  check "two weight-1 jobs run together (B)" started B
  job C 1 30
  LASTLOG=$ROOT/C.log check "a third weight-1 job waits while both slots are held" not_started C 2
  release A
  LASTLOG=$ROOT/C.log check "the third starts once one holder ends" started C 5
  release B; release C
  local a b c
  rc_of A; a=$RC; rc_of B; b=$RC; rc_of C; c=$RC
  check "all three exit 0 (A=$a B=$b C=$c)" test "$a$b$c" = 000
  LASTLOG=$ROOT/C.log check "the acquire line names the weight, the slot and the wait" log_has C 'build-slot: weight 1 took slot-[12] after waiting [0-9]* s (limit 30 s)'
  LASTLOG=$ROOT/C.log check "the release line names the slot, hold time and exit" log_has C 'build-slot: weight 1 released slot-[12] after [0-9]* s; bash exited 0'
}

t_third_times_out_75() {
  reset_slots
  job A 1 30; job B 1 30
  started A; started B
  job C 1 2
  local c
  rc_of C; c=$RC
  LASTLOG=$ROOT/C.log check "the third job exits 75 after its wait (got $c)" test "$c" = 75
  check "the timed-out job never ran its command" test ! -e "$ROOT/C.started"
  LASTLOG=$ROOT/C.log check "the timeout is a ::error:: annotation" log_has C '^::error title=build slot::no build slot (weight 1) within 2 s'
  LASTLOG=$ROOT/C.log check "the annotation names the holders" log_has C 'slot-1: runner=runner-[AB] repo=test/repo run=1 attempt=1 job=[AB] weight=1'
  LASTLOG=$ROOT/C.log check "no secret env value is printed" log_lacks C 's3cr3t'
  # shellcheck disable=SC2016  # $1 expands inside the inner bash
  check "no secret env value is in a slot or holder file" bash -c '! grep -rq s3cr3t "$1"' _ "$ROOT/slots"
  job D 1 0
  local d
  rc_of D; d=$RC
  check "wait 0 with both slots busy exits 75 at once (got $d)" test "$d" = 75
  release A; release B; rc_of A >/dev/null; rc_of B >/dev/null
}

t_killed_holder_releases() {
  reset_slots
  job A 1 30; job B 1 30
  started A; started B
  job C 1 30
  not_started C 1
  # SIGKILL the whole holder: wrapper and command (the command leads its own process group).
  kill -KILL -- "-$(<"$ROOT/A.pid")"; kill -KILL "${JOBPID[A]}" 2>/dev/null
  LASTLOG=$ROOT/C.log check "a SIGKILLed holder frees its slot at once (waiter starts)" started C 3
  rc_of A >/dev/null
  # Only the wrapper killed: the command still holds the slot fd, so the slot stays taken.
  job D 1 30
  not_started D 1
  kill -KILL "${JOBPID[B]}"; rc_of B >/dev/null
  LASTLOG=$ROOT/D.log check "a killed wrapper whose command still runs keeps the slot" not_started D 2
  release B
  LASTLOG=$ROOT/D.log check "the slot frees when that command ends" started D 3
  release C; release D; rc_of C >/dev/null; rc_of D >/dev/null
}

t_weight2_waits_and_blocks() {
  reset_slots
  job A 1 30; started A
  job B 1 30; started B
  job X 2 30
  LASTLOG=$ROOT/X.log check "weight 2 waits while any slot is held" not_started X 2
  release A
  LASTLOG=$ROOT/X.log check "weight 2 still waits with one slot free" not_started X 2
  job D 1 1
  local d
  rc_of D; d=$RC
  LASTLOG=$ROOT/D.log check "a weight-1 job cannot take the slot weight 2 took (75, got $d)" test "$d" = 75
  release B
  LASTLOG=$ROOT/X.log check "weight 2 starts when both slots are free" started X 5
  LASTLOG=$ROOT/X.log check "weight 2 logs both slots" log_has X 'weight 2 took slot-1+slot-2 after waiting'
  job E 1 1
  local e
  rc_of E; e=$RC
  LASTLOG=$ROOT/E.log check "weight 1 is blocked while weight 2 runs (75, got $e)" test "$e" = 75
  release X
  local x a b
  rc_of X; x=$RC; rc_of A; a=$RC; rc_of B; b=$RC
  check "weight 2 exits 0 (got $x)" test "$x" = 0
  job F 1 5
  LASTLOG=$ROOT/F.log check "weight 1 runs again after weight 2 ends" started F 5
  release F; rc_of F >/dev/null
}

t_weight2_times_out_and_frees_slot1() {
  reset_slots
  job A 1 30; started A          # A takes slot-1
  job B 1 30; started B          # B takes slot-2
  release A; rc_of A >/dev/null  # slot-1 free, slot-2 held by B
  job X 2 2
  local x
  rc_of X; x=$RC
  LASTLOG=$ROOT/X.log check "weight 2 holding slot-1 times out on slot-2 with 75 (got $x)" test "$x" = 75
  check "the timed-out weight-2 job never ran" test ! -e "$ROOT/X.started"
  job C 1 3
  LASTLOG=$ROOT/C.log check "the timed-out weight 2 gave slot-1 back" started C 4
  release B; release C; rc_of B >/dev/null; rc_of C >/dev/null
}

t_two_weight2_no_deadlock() {
  reset_slots
  local x y both=0
  for _ in 1 2 3; do
    rm -f "$ROOT"/[XY].*
    job X 2 30; job Y 2 30
    wait_file "$ROOT/X.started" 5 || wait_file "$ROOT/Y.started" 5
    if [[ -e $ROOT/X.started && -e $ROOT/Y.started ]]; then both=1; fi
    sleep 0.5
    if [[ -e $ROOT/X.started && -e $ROOT/Y.started ]]; then both=1; fi
    if [[ -e $ROOT/X.started ]]; then release X; started Y 5 || both=2; release Y
    else release Y; started X 5 || both=2; release X; fi
    rc_of X; x=$RC; rc_of Y; y=$RC
    [[ $x$y == 00 ]] || both=3
  done
  check "two weight-2 jobs never run together and never deadlock (3 rounds, code $both)" test "$both" = 0
}

t_sigterm_forwarded() {
  reset_slots
  job A 1 30 0; job B 1 30 0
  started A; started B
  kill -TERM "${JOBPID[A]}"
  local a
  rc_of A; a=$RC
  check "SIGTERM to the wrapper reaches the command" wait_file "$ROOT/A.term" 3
  LASTLOG=$ROOT/A.log check "the wrapper exits with the command's status after TERM (7, got $a)" test "$a" = 7
  job C 1 3
  LASTLOG=$ROOT/C.log check "the slot is free after the TERM" started C 4
  kill -INT "${JOBPID[B]}"
  local b
  rc_of B; b=$RC
  check "SIGINT to the wrapper reaches the command" wait_file "$ROOT/B.int" 3
  LASTLOG=$ROOT/B.log check "the wrapper exits with the command's status after INT (8, got $b)" test "$b" = 8
  job D 1 3
  LASTLOG=$ROOT/D.log check "the slot is free after the INT" started D 4
  release C; release D; rc_of C >/dev/null; rc_of D >/dev/null
}

t_sigterm_while_waiting() {
  reset_slots
  job A 1 30; job B 1 30; started A; started B
  job C 1 30; not_started C 1
  kill -TERM "${JOBPID[C]}"
  local c
  rc_of C; c=$RC
  check "TERM while waiting exits 143 without running the command (got $c)" test "$c" = 143 -a ! -e "$ROOT/C.started"
  release A; release B; rc_of A >/dev/null; rc_of B >/dev/null
}

t_missing_dir_fails_closed() {
  local rc out=$ROOT/missing.log
  RUNNER_ENVIRONMENT=self-hosted bash "$(wrap_for "$ROOT/nope")" 1 5 -- touch "$ROOT/ran" >"$out" 2>&1; rc=$?
  LASTLOG=$out check "missing dir on a self-hosted runner: exit 78 (got $rc)" test "$rc" = 78
  check "missing dir: the command did not run" test ! -e "$ROOT/ran"
  LASTLOG=$out check "missing dir: ::error:: annotation" grep -q '^::error title=build slot::build slot directory .* is missing' "$out"
  bash -c 'unset RUNNER_ENVIRONMENT; exec bash "$@"' _ "$(wrap_for "$ROOT/nope")" 1 5 -- touch "$ROOT/ran" >"$out" 2>&1; rc=$?
  check "missing dir with RUNNER_ENVIRONMENT unset: exit 78 (got $rc)" test "$rc" = 78 -a ! -e "$ROOT/ran"
  RUNNER_ENVIRONMENT=github-hosted bash "$(wrap_for "$ROOT/nope")" 2 5 -- bash -c 'touch "$1"; exit 5' _ "$ROOT/ran" >"$out" 2>&1; rc=$?
  LASTLOG=$out check "missing dir on a GitHub-hosted runner: runs unslotted, status passes (5, got $rc)" test "$rc" = 5 -a -e "$ROOT/ran"
  rm -f "$ROOT/ran"
  : >"$ROOT/afile"
  RUNNER_ENVIRONMENT=github-hosted bash "$(wrap_for "$ROOT/afile")" 1 5 -- touch "$ROOT/ran" >"$out" 2>&1; rc=$?
  check "a slot path that is a file fails closed even on GitHub-hosted (78, got $rc)" test "$rc" = 78 -a ! -e "$ROOT/ran"
  if [[ $(id -u) != 0 ]]; then
    reset_slots
    chmod 0000 "$ROOT/slots/slot-2"
    RUNNER_ENVIRONMENT=self-hosted bash "$WS" 1 5 -- touch "$ROOT/ran" >"$out" 2>&1; rc=$?
    LASTLOG=$out check "an unreadable slot file fails closed (78, got $rc)" test "$rc" = 78 -a ! -e "$ROOT/ran"
    chmod 0644 "$ROOT/slots/slot-2"
  else
    echo "  skip unreadable-slot case: running as root"
  fi
}

ns_run() { # <dir> <outfile> [owner uid]: run weight 1 against a namespace, command touches $ROOT/ran; sets RC
  local d=$1 o=$2 w
  w=$(wrap_for "$d" "${3:-$ME}") || { RC=990; return; }
  rm -f "$ROOT/ran"
  RUNNER_ENVIRONMENT=self-hosted bash "$w" 1 3 -- touch "$ROOT/ran" >"$o" 2>&1; RC=$?
}

t_namespace_must_be_protected() {
  local o=$ROOT/ns.log n
  reset_slots
  ns_run "$ROOT/slots" "$o"
  LASTLOG=$o check "a protected namespace works (0, got $RC)" test "$RC" = 0 -a -e "$ROOT/ran"
  ns_run "$ROOT/slots" "$o" 0
  LASTLOG=$o check "by default the namespace must be owned by uid 0 (78, got $RC)" test "$RC" = 78 -a ! -e "$ROOT/ran"
  LASTLOG=$o check "  ... and the annotation says so" grep -q 'not uid 0' "$o"
  for n in w1 w2 gw sym slotsym slotdir slotmissing; do
    chmod -R u+w "$ROOT/ns-$n" 2>/dev/null; rm -rf -- "$ROOT/ns-$n" "$ROOT/ns-$n-real"; make_ns "$ROOT/ns-$n"
  done
  chmod 0755 "$ROOT/ns-w1"
  ns_run "$ROOT/ns-w1" "$o"
  LASTLOG=$o check "a namespace the job user can write fails closed (78, got $RC)" test "$RC" = 78 -a ! -e "$ROOT/ran"
  chmod 0575 "$ROOT/ns-gw"
  ns_run "$ROOT/ns-gw" "$o"
  LASTLOG=$o check "a group-writable namespace fails closed (78, got $RC)" test "$RC" = 78 -a ! -e "$ROOT/ran"
  chmod 0557 "$ROOT/ns-w2"
  ns_run "$ROOT/ns-w2" "$o"
  LASTLOG=$o check "a world-writable namespace fails closed (78, got $RC)" test "$RC" = 78 -a ! -e "$ROOT/ran"
  mv "$ROOT/ns-sym" "$ROOT/ns-sym-real" && ln -s "$ROOT/ns-sym-real" "$ROOT/ns-sym"
  ns_run "$ROOT/ns-sym" "$o"
  LASTLOG=$o check "a symlinked slot directory fails closed (78, got $RC)" test "$RC" = 78 -a ! -e "$ROOT/ran"
  chmod u+w "$ROOT/ns-slotsym"; : >"$ROOT/elsewhere"; rm -f "$ROOT/ns-slotsym/slot-1"
  ln -s "$ROOT/elsewhere" "$ROOT/ns-slotsym/slot-1"; chmod 0555 "$ROOT/ns-slotsym"
  ns_run "$ROOT/ns-slotsym" "$o"
  LASTLOG=$o check "a symlinked slot file fails closed (78, got $RC)" test "$RC" = 78 -a ! -e "$ROOT/ran"
  chmod u+w "$ROOT/ns-slotdir"; rm -f "$ROOT/ns-slotdir/slot-2"; mkdir "$ROOT/ns-slotdir/slot-2"; chmod 0555 "$ROOT/ns-slotdir"
  ns_run "$ROOT/ns-slotdir" "$o"
  LASTLOG=$o check "a slot that is a directory fails closed (78, got $RC)" test "$RC" = 78 -a ! -e "$ROOT/ran"
  chmod u+w "$ROOT/ns-slotmissing"; rm -f "$ROOT/ns-slotmissing/slot-1"; chmod 0555 "$ROOT/ns-slotmissing"
  ns_run "$ROOT/ns-slotmissing" "$o"
  LASTLOG=$o check "a missing slot file fails closed and is not created (78, got $RC)" test "$RC" = 78 -a ! -e "$ROOT/ran" -a ! -e "$ROOT/ns-slotmissing/slot-1"
}

t_peer_cannot_replace_a_held_slot() {
  local o=$ROOT/peer.log c
  reset_slots
  job A 1 30; job B 1 30; started A; started B
  # A peer job (same user as every runner) tries to swap slot-1 for a fresh inode while it is held.
  { rm -f "$ROOT/slots/slot-1" || mv "$ROOT/slots/slot-1" "$ROOT/slots/old"; } 2>/dev/null
  : 2>/dev/null >"$ROOT/slots/slot-1.new"
  check "the peer could not unlink, move or add a file in the namespace" \
    test -f "$ROOT/slots/slot-1" -a ! -e "$ROOT/slots/old" -a ! -e "$ROOT/slots/slot-1.new"
  job C 1 2
  rc_of C; c=$RC
  LASTLOG=$ROOT/C.log check "with both slots held a third job still gets none (75, got $c)" test "$c" = 75 -a ! -e "$ROOT/C.started"
  # The peer makes the namespace writable (only root can on box3) and recreates slot-1: every new job refuses.
  chmod u+w "$ROOT/slots"; rm -f "$ROOT/slots/slot-1"; : >"$ROOT/slots/slot-1"
  job D 1 2
  rc_of D
  LASTLOG=$ROOT/D.log check "a namespace made mutable is refused, never a third holder (78, got $RC)" test "$RC" = 78 -a ! -e "$ROOT/D.started"
  release A; release B; rc_of A >/dev/null; rc_of B >/dev/null
}

t_deadline_is_strict() {
  reset_slots
  job A 1 30; job B 1 30; started A; started B
  local t0 t1 el p
  t0=$EPOCHREALTIME
  job C 1 2
  p=${JOBPID[C]}
  since() { awk -v a="$1" -v b="$EPOCHREALTIME" 'BEGIN { printf "%.2f", b - a }'; }
  # Watch C until it exits or 2.5 s pass, then free a slot: half a second AFTER C's deadline.
  while kill -0 "$p" 2>/dev/null && awk -v e="$(since "$t0")" 'BEGIN { exit !(e < 2.5) }'; do sleep 0.02; done
  t1=$EPOCHREALTIME
  while awk -v e="$(since "$t0")" 'BEGIN { exit !(e < 2.5) }'; do sleep 0.02; done
  release A
  rc_of C
  el=$(awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.2f", b - a }')
  LASTLOG=$ROOT/C.log check "a slot freed after the deadline is not taken (75, got $RC)" test "$RC" = 75
  check "the command never started after the deadline" test ! -e "$ROOT/C.started"
  # /proc/uptime (Linux) and the macOS fallback EPOCHREALTIME are both exact to 10 ms or better.
  local lo=1.9
  LASTLOG=$ROOT/C.log check "the timeout came at the deadline, not up to 1 s later (${el} s incl. startup)" \
    awk -v e="$el" -v lo="$lo" 'BEGIN { exit !(e >= lo && e < 2.4) }'
  release B; rc_of A >/dev/null; rc_of B >/dev/null
}

t_exit_status_passes() {
  reset_slots
  local code rc out=$ROOT/exit.log
  for code in 0 3 42; do
    RUNNER_ENVIRONMENT=self-hosted bash "$WS" 1 5 -- bash -c "exit $code" >"$out" 2>&1; rc=$?
    LASTLOG=$out check "exit status $code passes through (got $rc)" test "$rc" = "$code"
  done
  RUNNER_ENVIRONMENT=self-hosted bash "$WS" 2 5 -- bash -c 'kill -KILL $$' >"$out" 2>&1; rc=$?
  LASTLOG=$out check "a command killed by SIGKILL gives 137 (got $rc)" test "$rc" = 137
  RUNNER_ENVIRONMENT=self-hosted bash "$WS" 1 5 -- /nonexistent/cmd >"$out" 2>&1; rc=$?
  LASTLOG=$out check "a missing command gives 127 (got $rc)" test "$rc" = 127
}

t_usage() {
  local rc out=$ROOT/usage.log args
  reset_slots
  for args in "3 10 -- true" "1 x -- true" "1 10 true" "1 10 --" "0 10 -- true" "1 -5 -- true"; do
    # shellcheck disable=SC2086
    RUNNER_ENVIRONMENT=self-hosted bash "$WS" $args >"$out" 2>&1; rc=$?
    LASTLOG=$out check "usage error for '$args' exits 64 (got $rc)" test "$rc" = 64
  done
}

t_shipped_constants() {
  check "the shipped wrapper hard-codes SLOT_DIR=/srv/build-slots (exactly one line)" \
    test "$(grep -cx 'readonly SLOT_DIR=/srv/build-slots' "$W")" = 1
  check "the shipped wrapper hard-codes SLOT_OWNER_UID=0 (exactly one line)" \
    test "$(grep -cx 'readonly SLOT_OWNER_UID=0' "$W")" = 1
  # shellcheck disable=SC2016  # literal text to search for
  check "the shipped wrapper names no BUILD_SLOT_* variable" bash -c '! grep -q "BUILD_SLOT_" "$1"' _ "$W"
  # shellcheck disable=SC2016  # literal text to search for
  check "dir and owner come only from the constants" \
    test "$(grep -cE '^(dir|owner_uid)=' "$W")|$(grep -cx 'dir=$SLOT_DIR' "$W")|$(grep -cx 'owner_uid=$SLOT_OWNER_UID' "$W")" = "2|1|1"
  if [[ ! -e /srv/build-slots ]]; then
    local o=$ROOT/shipped.log rc
    reset_slots
    BUILD_SLOT_DIR=$ROOT/slots BUILD_SLOT_OWNER_UID=$ME RUNNER_ENVIRONMENT=self-hosted \
      bash "$W" 1 3 -- touch "$ROOT/ran" >"$o" 2>&1; rc=$?
    LASTLOG=$o check "env overrides are ignored: the shipped wrapper looks only at /srv/build-slots (78, got $rc)" \
      test "$rc" = 78 -a ! -e "$ROOT/ran"
    LASTLOG=$o check "  ... and names /srv/build-slots" grep -q '/srv/build-slots is missing' "$o"
  else
    echo "  skip the env-override run: /srv/build-slots exists on this machine"
  fi
}

t_present_dir_is_always_used() {
  reset_slots
  local o=$ROOT/present.log rc
  RUNNER_ENVIRONMENT=github-hosted bash "$WS" 1 3 -- touch "$ROOT/ran" >"$o" 2>&1; rc=$?
  LASTLOG=$o check "RUNNER_ENVIRONMENT=github-hosted with the directory present takes a slot (0, got $rc)" \
    grep -q 'build-slot: weight 1 took slot-1' "$o"
  chmod u+w "$ROOT/slots"; chmod 0755 "$ROOT/slots"
  RUNNER_ENVIRONMENT=github-hosted bash "$WS" 1 3 -- touch "$ROOT/ran2" >"$o" 2>&1; rc=$?
  LASTLOG=$o check "  ... and a bad present namespace still fails closed there (78, got $rc)" test "$rc" = 78 -a ! -e "$ROOT/ran2"
  rm -f "$ROOT/ran" "$ROOT/ran2"
}

t_fifo_at_holder_path() {
  reset_slots
  mkfifo "$ROOT/slots/holders/slot-1" "$ROOT/slots/holders/slot-2"
  local t0 el
  t0=$EPOCHREALTIME
  job A 1 5
  LASTLOG=$ROOT/A.log check "a FIFO planted at the holder path does not block the start" started A 3
  el=$(awk -v a="$t0" -v b="$EPOCHREALTIME" 'BEGIN { printf "%.2f", b - a }')
  check "  ... the start took ${el} s" awk -v e="$el" 'BEGIN { exit !(e < 2.5) }'
  check "  ... and the FIFO was replaced by a regular holder note" test -f "$ROOT/slots/holders/slot-1" -a ! -p "$ROOT/slots/holders/slot-1"
  check "  ... that names the holder" grep -q 'job=A weight=1' "$ROOT/slots/holders/slot-1"
  job B 1 5; started B
  # FIFOs at both holder paths again, both slots held: a slot freed after C's deadline is not taken.
  rm -f "$ROOT/slots/holders/slot-1" "$ROOT/slots/holders/slot-2"
  mkfifo "$ROOT/slots/holders/slot-1" "$ROOT/slots/holders/slot-2"
  job C 1 2
  sleep 2.5
  release A
  rc_of C
  LASTLOG=$ROOT/C.log check "with FIFOs planted, a slot freed after the deadline is not taken (75, got $RC)" test "$RC" = 75
  check "  ... and the command never started" test ! -e "$ROOT/C.started"
  release B; rc_of A >/dev/null; rc_of B >/dev/null
}

# ---------------------------------------------------------------------------------------------------------
echo "build-slot tests: wrapper $W"
echo "flock: $FLOCK_IMPL"
echo "bash: $BASH_VERSION, uname: $(uname -sr)"
for t in $(declare -F | awk '{print $3}' | grep '^t_'); do
  [[ $t == "$FILTER"* ]] || continue
  echo "$t"
  LASTLOG=""
  "$t"
done
echo "passed $PASS, failed $FAILED"
((FAILED == 0))
