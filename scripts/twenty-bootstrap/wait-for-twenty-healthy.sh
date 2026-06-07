#!/usr/bin/env bash
# Wait for the local Twenty stack (twenty-server, twenty-worker, twenty-db, twenty-redis)
# to reach a state where the bootstrap proof can run.
#
# Per-service signal:
#   - twenty-db    : container .State.Health.Status == "healthy"  (pg_isready)
#   - twenty-redis : container .State.Health.Status == "healthy"  (redis-cli ping)
#   - twenty-server: container .State.Health.Status == "healthy"  (curl /healthz)
#                    AND HTTP GET ${TWENTY_SERVER_URL}/healthz == 200
#   - twenty-worker: container .State.Running == "true" (no healthcheck on worker)
#
# Container names mirror `docker-compose.yml` (cinatra-twenty-{db,redis,worker}-1
# plus cinatra-twenty-1 for the server — its container_name is not the
# default `cinatra-twenty-server-1`, by design).
#
# Loud-fail diagnostics on timeout: compose ps + tail of server + worker logs.

set -u

SERVER_URL="${TWENTY_SERVER_URL:-http://localhost:3300}"
TIMEOUT_SECS="${TIMEOUT_SECS:-300}"
INTERVAL=3

# service-name => container-name (mirrors docker-compose container_name fields)
declare -A CONTAINER_OF=(
  [twenty-db]="cinatra-twenty-db-1"
  [twenty-redis]="cinatra-twenty-redis-1"
  [twenty-server]="cinatra-twenty-1"
  [twenty-worker]="cinatra-twenty-worker-1"
)

HEALTHCHECK_SERVICES=(twenty-db twenty-redis twenty-server)
RUNNING_ONLY_SERVICES=(twenty-worker)

deadline=$(( $(date +%s) + TIMEOUT_SECS ))

while [ "$(date +%s)" -lt "$deadline" ]; do
  all_ok=1

  for svc in "${HEALTHCHECK_SERVICES[@]}"; do
    container="${CONTAINER_OF[$svc]}"
    state=$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null)
    if [ -z "$state" ]; then state="missing"; fi
    if [ "$state" != "healthy" ]; then
      all_ok=0
      echo "[wait-for-twenty] $svc ($container) health=$state"
    fi
  done

  for svc in "${RUNNING_ONLY_SERVICES[@]}"; do
    container="${CONTAINER_OF[$svc]}"
    running=$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null)
    if [ -z "$running" ]; then running="missing"; fi
    if [ "$running" != "true" ]; then
      all_ok=0
      echo "[wait-for-twenty] $svc ($container) running=$running"
    fi
  done

  if [ "$all_ok" -eq 1 ]; then
    code=$(curl -sS -o /dev/null -w "%{http_code}" "${SERVER_URL}/healthz" 2>/dev/null || echo "000")
    if [ "$code" = "200" ]; then
      echo "[wait-for-twenty] all containers healthy + ${SERVER_URL}/healthz=200"
      exit 0
    fi
    echo "[wait-for-twenty] containers healthy but ${SERVER_URL}/healthz=$code (retrying)"
  fi

  sleep "$INTERVAL"
done

echo "[wait-for-twenty] TIMEOUT after ${TIMEOUT_SECS}s — dumping diagnostics"
echo "----- docker compose --profile twenty ps -----"
docker compose --profile twenty ps 2>&1 | tail -n 30 || true
echo "----- docker inspect --State (all twenty containers) -----"
for svc in twenty-db twenty-redis twenty-server twenty-worker; do
  c="${CONTAINER_OF[$svc]}"
  echo "[$svc -> $c]"
  docker inspect --format '  Running={{.State.Running}} Health={{.State.Health.Status}} ExitCode={{.State.ExitCode}}' "$c" 2>&1 || true
done
echo "----- twenty-db logs (tail 60) -----"
docker logs --tail 60 cinatra-twenty-db-1 2>&1 | tail -n 60 || true
echo "----- twenty-redis logs (tail 40) -----"
docker logs --tail 40 cinatra-twenty-redis-1 2>&1 | tail -n 40 || true
echo "----- twenty-server logs (tail 120) -----"
docker logs --tail 120 cinatra-twenty-1 2>&1 | tail -n 120 || true
echo "----- twenty-worker logs (tail 80) -----"
docker logs --tail 80 cinatra-twenty-worker-1 2>&1 | tail -n 80 || true
echo "----- HTTP probe to ${SERVER_URL}/healthz -----"
curl -sS -o - -w "\nHTTP=%{http_code} CONNECT=%{time_connect}s TOTAL=%{time_total}s\n" "${SERVER_URL}/healthz" 2>&1 || true
exit 1
