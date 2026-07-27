#!/usr/bin/env bash
# Runtime diagnostics for the WP/Drupal UAT lane (cinatra#2131).
#
# WHY THIS EXISTS
# ---------------
# The UAT job co-hosts the docker WordPress + Drupal + nango + wayflow stack,
# the Postgres/Redis service containers, a Next dev server and a Playwright
# Chromium on ONE 4-vCPU / 16-GB runner. When that box runs out of headroom it
# stops making progress entirely: the suite emits nothing further and the job
# ends with no diagnosis. Two evidence gaps made the last such incident nearly
# undiagnosable — nothing to read from the co-hosted stack after a failure, and
# no memory time-series at all (the one useful sample survived by luck).
#
# This script is the single implementation of both captures, shared by the
# `uat-gate` and `nightly` jobs in .github/workflows/wp-drupal-uat.yml so the
# two can never drift.
#
# HONEST SCOPE
# ------------
# Post-failure capture runs for ORDINARY step failures and for runs the
# Playwright run ceiling ends (which is now the normal end state for a stall,
# because the runner ends itself and reports instead of hanging to the job
# ceiling). NOTHING can run after a hard runner teardown — that state remains
# undiagnosable by construction, and no capture here claims otherwise.
#
# ARTIFACT HYGIENE
# ----------------
# Everything this script writes is uploaded as a build artifact of a PUBLIC
# repository. The four per-run minted values (BETTER_AUTH_SECRET,
# NANGO_ENCRYPTION_KEY, CINATRA_BRIDGE_TOKEN, CINATRA_CONTEXT_ATTEST_KEY) are
# registered with the runner's log masker at mint time, but that masker covers
# the LOG STREAM only — it does not touch files. So every byte this script
# writes goes through `scrub` first, and `scan` re-checks the staged output for
# the values before upload as a fail-closed backstop.
set -euo pipefail

# The per-run minted values. Names only ever appear here; values are read from
# the environment inside the filters below and are never passed on a command
# line (argv is world-readable through /proc) and never written to a file.
MINTED_KEYS=(
  BETTER_AUTH_SECRET
  NANGO_ENCRYPTION_KEY
  CINATRA_BRIDGE_TOKEN
  CINATRA_CONTEXT_ATTEST_KEY
)

usage() {
  cat >&2 <<'USAGE'
usage: uat-diagnostics.sh <command> [args]

  sampler-start <out-file> <pid-file> [interval-seconds]
      Start the periodic resource sampler in the background. Writes its own PID
      to <pid-file> so `sampler-stop` can kill exactly that process.

  sampler-stop <pid-file> <out-file>
      Stop the sampler by its RECORDED pid and append one final sample.

  compose-logs <out-dir>
      Write `docker compose logs --tail=500` per service into <out-dir>.

  scan <path> [path...]
      Boolean-only check that no minted value appears under the given paths.
      Exits non-zero if any does. Never prints a value or a matching line.
USAGE
  exit 2
}

# Replace every per-run minted value on stdin with `***`.
#
# Perl reads the values from %ENV, so they never reach argv. Short/empty values
# are dropped: an empty pattern would match every position and turn the whole
# stream into `***`, and a very short one would smear unrelated text.
scrub() {
  perl -pe '
    BEGIN {
      @S = grep { defined($_) && length($_) >= 8 }
           map  { $ENV{$_} }
           qw(BETTER_AUTH_SECRET NANGO_ENCRYPTION_KEY CINATRA_BRIDGE_TOKEN CINATRA_CONTEXT_ATTEST_KEY);
    }
    for my $s (@S) { s/\Q$s\E/***/g }
  '
}

# One sample: the three signals the incident review asked for, plus a UTC
# timestamp so the file reads as a time series.
emit_sample() {
  printf '===== sample %s =====\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  free -m 2>&1 || true
  swapon --show 2>&1 || true
  printf -- '--- top 5 processes by RSS ---\n'
  # `cut` bounds each line: a process command line is attacker-adjacent input
  # (anything the stack execs) and an unbounded dump would bloat the artifact.
  ps -eo rss=,comm=,args= --sort=-rss 2>/dev/null | head -5 | cut -c1-200 || true
  printf '\n'
}

# Internal entry point for the detached sampler process. Not part of the public
# command surface.
sampler_loop() {
  local out=$1 interval=$2 pidfile=$3
  printf '%s\n' "$$" >"$pidfile"
  while true; do
    emit_sample 2>&1 | scrub >>"$out"
    sleep "$interval"
  done
}

cmd_sampler_start() {
  local out=${1:?out-file required} pidfile=${2:?pid-file required} interval=${3:-30}
  mkdir -p "$(dirname "$out")" "$(dirname "$pidfile")"
  : >"$out"
  rm -f "$pidfile"
  # setsid + nohup + fully detached stdio: the sampler must outlive THIS step's
  # shell, and must not hold the step's stdout open (that would stall the step).
  setsid nohup "$0" __sampler-loop "$out" "$interval" "$pidfile" \
    </dev/null >/dev/null 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$pidfile" ] && break
    sleep 1
  done
  # LIVENESS, not just "a pid file appeared". A child that writes its pid and
  # then dies (fork/disk pressure, a missing tool) would otherwise report a
  # healthy start and leave the run with no series at all — the exact blind spot
  # this sampler exists to remove. Wait for the FIRST sample to land, which
  # proves the whole loop body works end to end.
  local pid=""
  [ -s "$pidfile" ] && pid=$(cat "$pidfile")
  if [ -n "$pid" ]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      { kill -0 "$pid" 2>/dev/null && grep -q '^===== sample ' "$out" 2>/dev/null; } && break
      sleep 1
    done
  fi
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null || ! grep -q '^===== sample ' "$out" 2>/dev/null; then
    # Deliberately a WARNING, never a failure: this is a diagnostic aid, and
    # turning it into a new way for the required UAT gate to go red would trade
    # a real signal for a worse one. The warning is loud enough to notice.
    echo "::warning::resource sampler did not produce a first sample — this run will have no resource series"
    return 0
  fi
  echo "resource sampler started (pid $pid, interval ${interval}s) -> $out"
}

cmd_sampler_stop() {
  local pidfile=${1:?pid-file required} out=${2:?out-file required}
  if [ -s "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile")
    # Kill ONLY the recorded pid's own process GROUP — never a name match, which
    # on a shared runner could take out an unrelated process.
    #
    # The group matters: `sampler-start` launches the loop under `setsid`, so the
    # recorded pid is a session leader whose process-group id equals it, and its
    # `sleep` / `emit_sample | scrub` children live in that group. Signalling the
    # leader alone leaves an in-flight sampling pipeline running, which can append
    # to the file AFTER the leak scan has read it and BEFORE the upload — a race
    # that could publish unscanned content. `kill -- -PID` closes it; the bare pid
    # is kept as a fallback for the (unexpected) case where the group is gone.
    if [ -n "$pid" ]; then
      local note="stopped"
      # Sweep the group even when the LEADER is already gone: a sampling child
      # can outlive its leader and still be appending to the file. Signal 0 to a
      # group (`kill -0 -- -PID`) answers "is anything left in it", which is the
      # question that actually matters here.
      kill -0 "$pid" 2>/dev/null || note="leader already gone, group swept"
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5; do
        kill -0 -- "-$pid" 2>/dev/null || break
        sleep 1
      done
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      # WAIT for extinction rather than assuming SIGKILL took effect instantly.
      # Everything downstream — the final sample, the leak scan, the upload —
      # rests on "nothing can still write this file", so that has to be observed
      # rather than asserted.
      local drained=0
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        if ! kill -0 -- "-$pid" 2>/dev/null; then
          drained=1
          break
        fi
        sleep 1
      done
      if [ "$drained" -eq 1 ]; then
        echo "resource sampler $note (pid $pid, process group -$pid drained)"
      else
        echo "::warning::resource sampler process group -$pid did not exit; the sample file may still be written to"
      fi
    fi
    rm -f "$pidfile"
  else
    echo "no resource sampler pid recorded"
  fi
  if [ -f "$out" ]; then
    # Non-fatal by design. This runs under `if: always()`, so letting a failed
    # final append (a missing tool, a full disk) exit non-zero would turn a
    # diagnostic into a fresh way for the required gate to go red — and would do
    # it precisely on the runs whose diagnostics matter most.
    if ! { printf -- '--- final sample (sampler stopped) ---\n'; emit_sample; } 2>&1 | scrub >>"$out"; then
      echo "::warning::could not append the final resource sample"
    fi
    echo "resource samples: $(grep -c '^===== sample ' "$out" || true) recorded in $out"
  fi
  return 0
}

# Run a command under a wall-clock bound when coreutils `timeout` is available.
# The bound matters because this capture runs on an ALREADY failing job and must
# never become the reason the job hangs; the fallback keeps the capture working
# on a runner image that ships without it instead of writing the shell's
# "command not found" into the artifact and calling that a log.
run_bounded() {
  local seconds=$1
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  else
    "$@"
  fi
}

cmd_compose_logs() {
  local outdir=${1:?out-dir required}
  mkdir -p "$outdir"
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is not available on this runner — no compose logs captured" >"$outdir/UNAVAILABLE.txt"
    return 0
  fi
  # `config --services` is the authoritative per-profile service list and works
  # even when a container never started (exactly the case worth reading). A
  # service with no container simply produces no output and is skipped below.
  local services
  services=$(docker compose --profile wordpress --profile drupal config --services 2>/dev/null || true)
  if [ -z "$services" ]; then
    echo "docker compose could not enumerate services from this working directory" >"$outdir/UNAVAILABLE.txt"
    return 0
  fi
  local svc captured=0
  while IFS= read -r svc; do
    [ -z "$svc" ] && continue
    if run_bounded 60 docker compose --profile wordpress --profile drupal \
      logs --no-color --tail=500 "$svc" 2>&1 | scrub >"$outdir/$svc.log"; then :; fi
    if [ -s "$outdir/$svc.log" ]; then
      captured=$((captured + 1))
    else
      rm -f "$outdir/$svc.log"
    fi
  done <<<"$services"
  if run_bounded 30 docker ps --all --no-trunc \
    --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>&1 | scrub >"$outdir/docker-ps.txt"; then :; fi
  echo "compose logs captured for $captured service(s) -> $outdir"
}

cmd_scan() {
  [ "$#" -ge 1 ] || usage
  local key missing=0
  local -a values=()
  for key in "${MINTED_KEYS[@]}"; do
    local v="${!key-}"
    if [ -z "$v" ] || [ "${#v}" -lt 8 ]; then
      echo "::error::$key is unset or too short to scan for — refusing to report a green leak check."
      missing=1
    else
      values+=("$v")
    fi
  done
  if [ "$missing" -ne 0 ]; then
    return 1
  fi

  local status=0 path scanned=0 found=0
  for path in "$@"; do
    [ -e "$path" ] || continue
    scanned=$((scanned + 1))
    # Patterns arrive on STDIN (`-f -`), so no value ever reaches argv; `-q`
    # keeps the matching line out of the log if there ever is one.
    #
    # The exit code is read explicitly rather than through `if`, because grep
    # answers 0=match, 1=no-match and 2=ERROR — and an `if` would fold that
    # error into "clean". A path this scan could not fully read is NOT a green
    # result; fail closed instead.
    local rc=0
    printf '%s\n' "${values[@]}" | grep -R -F -q -f - "$path" || rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "leak_check path=$path minted_value_present=true"
      found=1
      status=1
    elif [ "$rc" -eq 1 ]; then
      echo "leak_check path=$path minted_value_present=false"
    else
      echo "::error::leak scan could not read $path (grep exit $rc) — refusing to report it clean."
      status=1
    fi
  done
  if [ "$scanned" -eq 0 ]; then
    echo "leak_check nothing_staged=true"
  fi
  if [ "$found" -ne 0 ]; then
    echo "::error::A per-run minted value was found in content staged for upload. Failing before the artifact is published."
  fi
  return "$status"
}

case "${1-}" in
sampler-start)
  shift
  cmd_sampler_start "$@"
  ;;
sampler-stop)
  shift
  cmd_sampler_stop "$@"
  ;;
compose-logs)
  shift
  cmd_compose_logs "$@"
  ;;
scan)
  shift
  cmd_scan "$@"
  ;;
__sampler-loop)
  shift
  sampler_loop "$@"
  ;;
*)
  usage
  ;;
esac
