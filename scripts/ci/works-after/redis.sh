#!/usr/bin/env bash
set -euo pipefail
# works-after :: Redis / BullMQ arm (cinatra#352).
#
# Brings up a candidate Redis (REDIS_TAG, default = the current pin 7-alpine) on
# an ISOLATED docker network (config-light service → ad-hoc `docker run` is
# exactly what compose runs; design §2.2), then runs the bullmq enqueue→run
# round-trip (rt/redis-roundtrip.ts) against it and asserts a THREE-WAY result.
#
# The major lane sets REDIS_TAG=8-alpine. Default keeps the arm green on main.
#
# Env: REDIS_TAG (default 7-alpine), WORKS_AFTER_DEADLINE_MS (default 30000).

WORKS_AFTER_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/works-after/lib.sh
source "${WORKS_AFTER_LIB_DIR}/lib.sh"

REDIS_TAG="${REDIS_TAG:-7-alpine}"
RUN_ID="wa-redis-$$"
NET="${RUN_ID}-net"
REDIS="${RUN_ID}-redis"

cleanup() {
  docker rm -fv "$REDIS" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
dump_diag() {
  wa_group_start "works-after redis failure diagnostics"
  echo "--- docker ps -a (run containers) ---"; docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- redis INFO server (version) ---"; docker exec "$REDIS" redis-cli INFO server 2>&1 | grep -iE 'redis_version|redis_mode' || true
  echo "--- redis logs ---"; docker logs "$REDIS" 2>&1 | tail -40 || true
  wa_group_end
}
on_err() { echo "${_WA_RED}ERROR: works-after redis FAILED (line $1).${_WA_RST}" >&2; dump_diag; }
trap 'on_err $LINENO' ERR
trap cleanup EXIT
fail() { echo "${_WA_RED}ERROR: $*${_WA_RST}" >&2; dump_diag; exit 1; }

wa_log "works-after redis: candidate redis:${REDIS_TAG}"

docker network create "$NET" >/dev/null
# Loopback-only ephemeral host port so the host-side tsx round-trip can connect;
# never a fixed port → no collision with a dev stack or a parallel CI job.
docker run -d --name "$REDIS" --network "$NET" -p 127.0.0.1::6379 "redis:${REDIS_TAG}" >/dev/null

wa_info "waiting for redis readiness"
wa_wait_redis "$REDIS" 30 || fail "redis did not become ready within 60s."

HOST_PORT="$(wa_host_port "$REDIS" 6379)"
[ -n "$HOST_PORT" ] || fail "could not resolve the published host port for redis."

REDIS_URL="redis://127.0.0.1:${HOST_PORT}" \
  wa_node --import tsx "${REPO_ROOT}/scripts/ci/works-after/rt/redis-roundtrip.ts" \
  || fail "redis/bullmq round-trip failed (enqueue→run→assert)."

echo "${_WA_GREEN}==> works-after redis PASSED${_WA_RST} — candidate redis:${REDIS_TAG} ran a bullmq job end to end."
