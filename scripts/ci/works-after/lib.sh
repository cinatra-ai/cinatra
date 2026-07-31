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

# wa_matrix_pin <serviceId> [--coupled <imageRepo>] [--tag] — the DIGEST-BOUND
# image the upgrade matrix (config/upgrade/upgrade-matrix.json) records for a
# service, read at RUNTIME through the shared fail-closed consumption contract
# (scripts/upgrade/resolve-transition.mjs --pin).
#
# WHY: an arm's candidate default must be the pin the repo actually ships. A
# hand-copied digest literal here was a THIRD carrier of a value docker-compose.yml
# and the matrix already carry — Renovate pairs those two in one PR (cinatra#1863)
# but knows nothing about a fixture literal, so every digest wave was born red on
# the drift guard (cinatra#2194) until a human hand-synced this file (cinatra#2302).
# Deriving deletes the carrier: there is one source of truth, and the compose↔matrix
# equality is gated by scripts/check-upgrade-matrix.mjs check #4.
#
# Fail-closed: unknown service, a missing/ambiguous coupled image, a pin that is
# not digest-bound, or matrix revision skew all exit non-zero, and the arm's
# `set -e` turns that into a refusal rather than a silently floating image.
wa_matrix_pin() {
  node "${REPO_ROOT}/scripts/upgrade/resolve-transition.mjs" --pin "$@"
}

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

# wa_volume_digest <volume> — deterministic content digest of a named volume
# taken COLD (read-only mount, no server): sorted per-file sha256 plus the
# sorted entry list, folded once more. The upgrade-from arms use it to prove
# byte-level "the source volume was not touched" across an injected failure.
wa_volume_digest() {
  docker run --rm -v "$1:/wa-vol:ro" alpine     sh -ec 'cd /wa-vol && { find . -type f | sort | xargs -r sha256sum; find . | sort; } | sha256sum' | awk '{print $1}'
}

# wa_throwaway_b64key — a 32-byte base64 key minted per call (Nango/Neo4j/etc.).
# NEVER an ops secret; the harness mints its own throwaway crypto material.
wa_throwaway_b64key() { node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))'; }
wa_throwaway_hexkey() { node -e 'process.stdout.write(require("crypto").randomBytes(Number(process.argv[1]||32)).toString("hex"))' "$@"; }
