#!/usr/bin/env bash
# Deadline-bound dev-server readiness probe (cinatra#2514).
#
# WHY THIS EXISTS
# ----------------
# The "Wait for dev server ready" step in .github/workflows/dev-hmr-smoke.yml
# used to be attempt-bounded (`for i in $(seq 1 90)`) with a bare
# `curl -fsS` — no per-request timeout and no record of the HTTP status it
# observed. Two very different failure shapes surfaced identically as "did
# not become ready in time":
#   - a healthy cold boot, where each curl blocks tens of seconds inside
#     Turbopack's on-demand route compile and eventually returns 200
#     ("slow-ready"), and
#   - a stuck Turbopack route map, where the server fast-404s every probe
#     and all 90 attempts burn in ~5 minutes ("fast-404").
# Diagnosing which one happened required re-deriving status/timing from run
# artifacts after the fact. This function makes both visible AT RUN TIME: it
# is wall-clock deadline-bound (not attempt-bound), every probe carries
# `--max-time` so no single curl can block the budget, and every attempt's
# status code is logged as it happens.
#
# Extracted into its own file (rather than inlined in the workflow YAML) so
# the loop can be exercised outside CI: scripts/ci/dev-hmr-wait-ready-harness.sh
# sources this file and drives wait_for_dev_server_ready() against a STUB
# `curl` to prove the fast-404 and slow-ready modes produce distinguishable
# logs, without booting a real dev server or spending CI minutes.
#
# The function never sets -e itself and guards its own curl call with
# `|| true` so it is safe to source into a strict-mode (`set -e`) caller —
# a non-zero curl exit (connection refused, --max-time firing) is an
# EXPECTED, looped-over outcome here, not a fatal error.

# wait_for_dev_server_ready URL DEADLINE_SECONDS POLL_INTERVAL_SECONDS CURL_MAX_TIME [DEV_LOG_FILE]
#
# Polls URL until it returns HTTP 200 or the wall-clock deadline passes.
# Logs one "attempt N: status S (Es elapsed)" line per probe to stdout.
#
# Returns 0 the moment a probe returns 200. Returns 1 once the deadline
# passes, after printing a last-observed-status + per-status count summary
# (also appended to $GITHUB_STEP_SUMMARY when that's set) and, when
# DEV_LOG_FILE is given and readable, its last 100 lines.
#
# Status counts are tracked with a pair of plain indexed arrays (parallel
# "code" / "count" lists) rather than an associative array (`declare -A`,
# bash 4+) — the macOS-default `/bin/bash` this harness is proved against
# locally is 3.2, and GitHub's ubuntu-latest runner's default shell is bash
# too; staying on indexed arrays keeps the function portable to both without
# relying on the runner's bash version.
wait_for_dev_server_ready() {
  local url="$1" deadline_s="$2" interval_s="$3" max_time="$4" log_file="${5:-}"
  local start_ts deadline_ts now_ts remaining probe_timeout attempt=0
  local http_status last_status="" i found
  local status_codes=() status_tallies=()

  start_ts=$(date +%s)
  deadline_ts=$(( start_ts + deadline_s ))

  while :; do
    now_ts=$(date +%s)
    remaining=$(( deadline_ts - now_ts ))
    # Deadline reached (or passed) before starting another attempt — stop
    # WITHOUT probing again, rather than letting the loop-top check alone
    # (which only bounds when the NEXT attempt starts, not how long the
    # current one can run) let a single curl overrun the budget.
    [ "$remaining" -le 0 ] && break

    attempt=$((attempt + 1))
    # Cap this probe's own timeout to whatever's left of the deadline, so an
    # attempt that starts a moment before the deadline can't itself run past
    # it by up to the full --max-time.
    probe_timeout="$max_time"
    [ "$remaining" -lt "$max_time" ] && probe_timeout="$remaining"

    http_status=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$probe_timeout" "$url" 2>/dev/null || true)
    http_status="${http_status:-000}"
    last_status="$http_status"

    found=0
    for i in "${!status_codes[@]}"; do
      if [ "${status_codes[$i]}" = "$http_status" ]; then
        status_tallies[i]=$(( status_tallies[i] + 1 ))
        found=1
        break
      fi
    done
    if [ "$found" -eq 0 ]; then
      status_codes+=("$http_status")
      status_tallies+=(1)
    fi

    echo "attempt ${attempt}: status ${http_status} ($(( $(date +%s) - start_ts ))s elapsed)"

    if [ "$http_status" = "200" ]; then
      echo "dev server ready after ${attempt} attempt(s), status 200."
      return 0
    fi

    # Stop WITHOUT sleeping once less than a full poll interval remains —
    # capping this attempt's --max-time (above) already keeps a single probe
    # inside the budget, but a full `sleep "$interval_s"` here could still
    # carry the deadline past 0 on its own (e.g. curl returns fast with 1s
    # left and interval_s is 2s). No further probe could start after this
    # sleep anyway once remaining <= interval_s, so there is nothing to gain
    # from taking it.
    now_ts=$(date +%s)
    remaining=$(( deadline_ts - now_ts ))
    [ "$remaining" -le "$interval_s" ] && break
    sleep "$interval_s"
  done

  echo "::error::dev server did not become ready within ${deadline_s}s (deadline-bound)."
  echo "----- status-code counts -----"
  for i in "${!status_codes[@]}"; do
    echo "  ${status_codes[$i]}: ${status_tallies[$i]}"
  done
  echo "last observed status: ${last_status}"

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### dev-hmr-smoke: dev server not ready"
      echo ""
      echo "Last observed status: \`${last_status}\`"
      echo ""
      echo "| status | count |"
      echo "|---|---|"
      for i in "${!status_codes[@]}"; do
        echo "| ${status_codes[$i]} | ${status_tallies[$i]} |"
      done
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  if [ -n "$log_file" ]; then
    echo "----- last 100 lines of dev log -----"
    tail -n 100 "$log_file" 2>/dev/null || true
  fi

  return 1
}

# Allow direct execution as well as sourcing:
#   scripts/ci/dev-hmr-wait-ready.sh URL DEADLINE INTERVAL MAX_TIME [LOG_FILE]
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  wait_for_dev_server_ready "$@"
fi
