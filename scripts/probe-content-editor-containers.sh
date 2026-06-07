#!/usr/bin/env bash
# Pre-flight container health gate for the WayFlow content-editor
# stack. Boots the wayflow-drupal-content-editor (port 3020) and
# wayflow-wordpress-content-editor (port 3021) containers and probes
# /.well-known/agent-card.json on each. Exits 0 only when BOTH return 200.
#
# This script is the canonical entry point that an operator session
# opens with. The Cinatra Next.js dev server runs separately on port 3000.
#
# Usage:
#   bash scripts/probe-content-editor-containers.sh
#
# Exit codes:
#   0 — both containers healthy and curl probe returned HTTP 200 on both ports
#   non-zero — one or both containers failed to become healthy in 60s window
set -euo pipefail

echo "→ pre-flight container health gate (drupal-content-editor + wordpress-content-editor)"

# ---------------------------------------------------------------------------
# Detect a portable timeout command so docker compose image pulls cannot
# block indefinitely. 300s = 5 min — generous enough for a cold image pull
# on a slow connection.
# ---------------------------------------------------------------------------
TIMEOUT_CMD=""
if command -v gtimeout &>/dev/null; then
  TIMEOUT_CMD="gtimeout 300"
elif command -v timeout &>/dev/null; then
  TIMEOUT_CMD="timeout 300"
else
  echo "→ Note: neither gtimeout nor timeout found; docker compose runs without a time cap"
fi

# ---------------------------------------------------------------------------
# Boot containers. Prefer compose v2 native --wait (blocks until healthy);
# if --wait is unavailable on the operator's compose version, the curl probe
# loop below provides a 12-attempt × 5-second fallback (60-second window
# total — enough buffer for image pulls and slow-start containers).
# ---------------------------------------------------------------------------
echo "→ Booting wayflow-drupal-content-editor (--profile drupal)"
${TIMEOUT_CMD} docker compose --profile drupal up -d --wait wayflow-drupal-content-editor || {
  echo "  ✗ docker compose (drupal) failed or timed out (5-minute cap)"; exit 1
}

echo "→ Booting wayflow-wordpress-content-editor (--profile wordpress)"
${TIMEOUT_CMD} docker compose --profile wordpress up -d --wait wayflow-wordpress-content-editor || {
  echo "  ✗ docker compose (wordpress) failed or timed out (5-minute cap)"; exit 1
}

# ---------------------------------------------------------------------------
# Curl probe loop — re-verifies /.well-known/agent-card.json directly even
# when --wait reports healthy. 12 attempts × 5 seconds = 60-second window.
# On the final attempt, print the failure message and exit
# immediately — no misleading "retrying in 5s" message and no wasted sleep.
# ---------------------------------------------------------------------------
for port in 3020 3021; do
  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$port/.well-known/agent-card.json" || echo "000")
    if [[ "$code" == "200" ]]; then echo "  ✓ port $port (200)"; break; fi
    if [[ "$attempt" == "12" ]]; then
      echo "  ✗ port $port FAILED after 12 attempts (60s); last HTTP code: $code"
      exit 1
    fi
    echo "  attempt $attempt/12: port $port returned $code; retrying in 5s..."
    sleep 5
  done
done

echo "→ All WayFlow content-editor containers healthy. Cinatra dev server should run on port 3000."
exit 0
