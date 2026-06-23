#!/usr/bin/env bash
# Shared helpers for the works-after proof harness (cinatra#352).
#
# Sourced by the orchestrator (works-after-proof.sh) and each per-service arm.
# Mirrors the proven discipline of scripts/ci/upgrade-proof.sh and
# scripts/ci/prod-boot-e2e.sh: a fail() that dumps diagnostics and exits 1
# (never a bare `exit 1`, which would bypass the ERR trap and drop the dump).
#
# Every function here is intentionally side-effect-free except where noted; the
# arms own their own container lifecycle + cleanup trap.

# Repo root (absolute), resolved from this file's location: scripts/ci/works-after/.
# REPO_ROOT is consumed by the scripts that source this lib (arms + orchestrator).
WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034  # used by sourcing arm scripts
REPO_ROOT="$(cd "${WORKS_AFTER_LIB_DIR}/../../.." && pwd)"

# ANSI (only when stdout is a TTY).
if [ -t 1 ]; then
  _WA_RED=$'\033[0;31m'; _WA_GREEN=$'\033[0;32m'; _WA_YELLOW=$'\033[1;33m'; _WA_DIM=$'\033[2m'; _WA_RST=$'\033[0m'
else
  _WA_RED=""; _WA_GREEN=""; _WA_YELLOW=""; _WA_DIM=""; _WA_RST=""
fi

wa_log()  { echo "==> $*"; }
wa_info() { echo "    $*"; }

# A GitHub-Actions ::group:: wrapper (collapses to a plain header off CI).
wa_group_start() { echo "::group::$*"; }
wa_group_end()   { echo "::endgroup::"; }

# wa_node — run node with nvm/PATH already set by the caller environment.
# CI installs node via actions/setup-node; locally the orchestrator sources nvm.
wa_node() { node "$@"; }

# wa_wait_tcp <container> <port> <retries> <sleep_s> — wait until a TCP port
# inside <container> accepts connections (probed from the host via docker exec
# using the container's own runtime where possible). Generic readiness gate.
wa_wait_pg() {
  # wa_wait_pg <container> <user> <retries>
  local c="$1" u="$2" n="${3:-30}" _
  for _ in $(seq 1 "$n"); do
    if docker exec "$c" pg_isready -U "$u" -q 2>/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}

wa_wait_redis() {
  # wa_wait_redis <container> <retries>
  local c="$1" n="${2:-15}" _
  for _ in $(seq 1 "$n"); do
    if [ "$(docker exec "$c" redis-cli ping 2>/dev/null)" = "PONG" ]; then return 0; fi
    sleep 2
  done
  return 1
}

wa_wait_http() {
  # wa_wait_http <url> <retries> <sleep_s> — host-side curl readiness probe.
  local url="$1" n="${2:-40}" s="${3:-3}" _
  for _ in $(seq 1 "$n"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep "$s"
  done
  return 1
}

# wa_host_port <container> <container_port> — resolve the docker-assigned host
# port for an ephemeral `-p 127.0.0.1::<port>` publication (loopback-only, never
# a fixed port → no collision with a dev stack or a parallel CI job).
wa_host_port() {
  docker port "$1" "$2/tcp" 2>/dev/null | head -1 | sed -E 's/.*:([0-9]+)$/\1/'
}

# wa_throwaway_b64key — a 32-byte base64 key minted per call (Nango/Neo4j/etc.).
# NEVER an ops secret; the harness mints its own throwaway crypto material.
wa_throwaway_b64key() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))'; }
wa_throwaway_hexkey() { node -e 'process.stdout.write(require("crypto").randomBytes(Number(process.argv[1]||32)).toString("hex"))' "$@"; }
