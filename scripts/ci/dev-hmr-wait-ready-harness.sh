#!/usr/bin/env bash
# Outside-CI proof harness for scripts/ci/dev-hmr-wait-ready.sh (cinatra#2514).
#
# Drives the SAME wait_for_dev_server_ready() function the workflow step
# calls against a STUB `curl` prepended to PATH, instead of a real dev
# server — no Next/Turbopack boot, no CI minutes. Two modes, matching the
# two failure shapes cinatra#2514 diagnosed from run 31235590796 (attempt 1
# red, attempt 2 green, same commit):
#
#   fast-404    A stuck Turbopack route map: every probe 404s immediately.
#               The loop burns its full deadline in rapid-fire attempts, all
#               logged as status 404.
#   slow-ready  A healthy cold compile: the first probes time out (curl's
#               --max-time firing on a still-compiling route, status 000),
#               then the route finishes and a later probe returns 200.
#
# Both modes use a short deadline/interval (seconds, not the real 300s/2s)
# so the harness finishes fast; the loop/status-capture/summary logic under
# test is identical to what the workflow step runs.
#
# USAGE
#   scripts/ci/dev-hmr-wait-ready-harness.sh fast-404
#   scripts/ci/dev-hmr-wait-ready-harness.sh slow-ready
#   scripts/ci/dev-hmr-wait-ready-harness.sh both        # default; both transcripts
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/dev-hmr-wait-ready.sh
source "${SCRIPT_DIR}/dev-hmr-wait-ready.sh"

STUB_BIN="$(mktemp -d)"
trap 'rm -rf "$STUB_BIN"' EXIT

run_fast_404() {
  echo "===== mode: fast-404 (stuck route map) ====="
  cat > "${STUB_BIN}/curl" <<'STUB'
#!/usr/bin/env bash
# Stub: every probe 404s immediately, as if the route never registered.
echo -n "404"
exit 0
STUB
  chmod +x "${STUB_BIN}/curl"

  PATH="${STUB_BIN}:${PATH}" wait_for_dev_server_ready \
    "http://stub.invalid/api/auth/get-session" 6 1 10 ""
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "UNEXPECTED: fast-404 mode reported ready (rc=0)"
    return 1
  fi
  echo "EXPECTED: fast-404 mode hit the wall-clock deadline (rc=${rc}) — status-code counts above are all 404."
}

run_slow_ready() {
  echo "===== mode: slow-ready (healthy cold compile) ====="
  local counter_file
  counter_file="$(mktemp)"
  echo 0 > "$counter_file"
  cat > "${STUB_BIN}/curl" <<STUB
#!/usr/bin/env bash
# Stub: first two probes time out (route still compiling, curl's own
# --max-time-exceeded exit code 28), third probe returns 200.
n=\$(cat "${counter_file}")
n=\$((n + 1))
echo "\$n" > "${counter_file}"
if [ "\$n" -lt 3 ]; then
  echo -n "000"
  exit 28
fi
echo -n "200"
exit 0
STUB
  chmod +x "${STUB_BIN}/curl"

  PATH="${STUB_BIN}:${PATH}" wait_for_dev_server_ready \
    "http://stub.invalid/api/auth/get-session" 30 1 10 ""
  local rc=$?
  rm -f "$counter_file"
  if [ "$rc" -ne 0 ]; then
    echo "UNEXPECTED: slow-ready mode hit the deadline (rc=${rc})"
    return 1
  fi
  echo "EXPECTED: slow-ready mode became ready before the deadline (rc=${rc}) — status timeline above shows 000, 000, 200."
}

mode="${1:-both}"
status=0
case "$mode" in
  fast-404) run_fast_404 || status=1 ;;
  slow-ready) run_slow_ready || status=1 ;;
  both)
    run_fast_404 || status=1
    echo
    run_slow_ready || status=1
    ;;
  *)
    echo "usage: $0 {fast-404|slow-ready|both}" >&2
    exit 2
    ;;
esac
exit "$status"
