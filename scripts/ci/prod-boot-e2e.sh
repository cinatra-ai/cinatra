#!/usr/bin/env bash
set -euo pipefail

# Prod-boot e2e — boot the core WITHOUT private extensions cloned (issue #81).
#
# Proves, end to end, that the production image is bootable from its own
# inputs: the image under test was built from a context that EXCLUDES
# extensions/ (.dockerignore) and acquired the required-extension set inside
# `docker build` from the committed SHA-pinned lock
# (cinatra-required-extensions.lock.json). This script then exercises the
# exact prod first-boot sequence that cinatra-ai/ops deploy-instance.sh runs:
#
#   1. fresh Postgres (+ Redis, mirroring the prod platform services) on an
#      ISOLATED docker network — no host ports are published at all, so the
#      test can never collide with a dev server or another CI job;
#   2. one-shot `cinatra setup prod` container against the FRESH database
#      (bundled Better Auth migration, store schema, default org, MCP rows;
#      inside the standalone runtime image the extension acquisition is the
#      documented no-op — the source was baked at image build);
#   3. the app container (Next standalone server.js), CINATRA_RUNTIME_MODE=
#      production — outside development the required-extension activation
#      assert (src/lib/required-extension-activation.ts) THROWS on any miss,
#      so a half-wired boot crashes the server and fails the health gate;
#   4. health gate: GET /api/health must answer 200 {"status":"ok"} — the
#      same unauthenticated readiness endpoint the ops compose healthcheck
#      polls. Probed from INSIDE the network (a one-shot probe container
#      running the image's own node — no extra image pulls);
#   5. page-render smoke: GET / followed through its redirects (route guard
#      307s an unauthenticated request to /sign-in) must end in HTTP 200 —
#      the real page pipeline + a Better Auth session check on the fresh DB;
#   6. data-driven post-boot assertions (no extension-name literals):
#      a. the static-bundle lifecycle anchor seeding wrote platform-scoped
#         anchor rows on the fresh DB, including required-in-prod rows, and
#         live (active|locked) rows — proving the boot loaders ran AND
#         `cinatra.extensions` was readable at runtime;
#      b. the app log carries the StaticBundleLoader boot line and carries
#         NO fatal boot markers (activation-assert failures are loud even
#         when a code path swallows the throw).
#
# Usage (CI runs exactly this; locally too):
#   docker build --build-arg CI=true -t cinatra-prod-boot-e2e:local .
#   IMAGE=cinatra-prod-boot-e2e:local bash scripts/ci/prod-boot-e2e.sh
#
# Env:
#   IMAGE              (required) image ref to boot
#   BOOT_TIMEOUT_SECS  health-gate budget (default 120 — mirrors the ops
#                      deploy health gate of 24 x 5s)

IMAGE="${IMAGE:-}"
BOOT_TIMEOUT_SECS="${BOOT_TIMEOUT_SECS:-120}"

if [ -z "$IMAGE" ]; then
  echo "ERROR: IMAGE env var is required (the cinatra image ref to boot)." >&2
  exit 2
fi

# Unique per-run names so a local re-run (or a leftover from an aborted one)
# never collides; everything is torn down by the EXIT trap.
RUN_ID="cinatra-boot-e2e-$$"
NET="${RUN_ID}-net"
PG="${RUN_ID}-pg"
REDIS="${RUN_ID}-redis"
APP="${RUN_ID}-app"

# The app's public origin must EXACTLY match the origin the probes fetch
# (Better Auth validates its base URL/origin; an origin mismatch is an
# avoidable flake). Probes run inside the network, so the origin is the app
# container's DNS name — no host port is ever published.
APP_ORIGIN="http://${APP}:3000"

# Inert credentials for a throwaway, network-isolated instance.
# CINATRA_ENCRYPTION_KEY must be 64 hex chars (32 bytes) — instance-secrets
# encryption validates the length at use time (src/lib/instance-secrets.ts).
AUTH_SECRET="prod-boot-e2e-throwaway-secret-0000000000000000000000000000"
ENCRYPTION_KEY="00000000000000000000000000000000000000000000000000000000000000e2"
DB_URL_IN_NET="postgresql://postgres:postgres@${PG}:5432/postgres"

cleanup() {
  docker rm -f "$APP" "$PG" "$REDIS" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

dump_logs() {
  echo "::group::prod-boot-e2e failure diagnostics"
  echo "--- docker ps -a (run containers) ---"
  docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- app logs ---"
  docker logs "$APP" 2>&1 | tail -200 || true
  echo "--- postgres logs ---"
  docker logs "$PG" 2>&1 | tail -50 || true
  echo "--- redis logs ---"
  docker logs "$REDIS" 2>&1 | tail -20 || true
  echo "::endgroup::"
}

on_err() {
  echo "ERROR: prod-boot e2e FAILED (line $1)." >&2
  dump_logs
}
trap 'on_err $LINENO' ERR
trap cleanup EXIT

# Loud assertion failure: message + full diagnostics + exit 1. A plain
# `exit 1` would BYPASS the ERR trap (the exit builtin is not a failing
# command), silently dropping the log dump — every assertion path below
# must fail through here.
fail() {
  echo "ERROR: $*" >&2
  dump_logs
  exit 1
}

# One-shot in-network HTTP probe using the image's own node runtime (no extra
# image pulls, no host ports). Arg: <url>. Follows redirects. Prints
# "<status> <final-url>\n<body head>" on success; non-zero exit on network failure.
probe() {
  docker run --rm --network "$NET" "$IMAGE" node -e '
    const url = process.argv[1];
    fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) })
      .then(async (res) => {
        const body = await res.text();
        process.stdout.write(`${res.status} ${res.url}\n${body.slice(0, 300)}`);
        process.exit(0);
      })
      .catch((err) => { console.error(String(err)); process.exit(1); });
  ' "$1"
}

echo "==> prod-boot e2e: image=${IMAGE} origin=${APP_ORIGIN}"

# ── 1. Infrastructure: isolated network + fresh Postgres + Redis ────────────
docker network create "$NET" >/dev/null

# Same service images the repo's e2e jobs use (postgres:17 / redis:7).
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
  postgres:17 >/dev/null
docker run -d --name "$REDIS" --network "$NET" redis:7 >/dev/null

echo "==> waiting for postgres + redis readiness"
for i in $(seq 1 30); do
  if docker exec "$PG" pg_isready -U postgres -q 2>/dev/null; then break; fi
  if [ "$i" -eq 30 ]; then
    fail "postgres did not become ready within 60s."
  fi
  sleep 2
done
for i in $(seq 1 15); do
  if [ "$(docker exec "$REDIS" redis-cli ping 2>/dev/null)" = "PONG" ]; then break; fi
  if [ "$i" -eq 15 ]; then
    fail "redis did not become ready within 30s."
  fi
  sleep 2
done

# ── 2. One-shot `setup prod` on the FRESH database ───────────────────────────
# Mirrors ops deploy-instance.sh: docker run --rm --env-file <secrets>
#   -e CINATRA_RUNTIME_MODE=production <image> \
#     node node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs setup prod
# The CLI is now the PUBLISHED @cinatra-ai/cinatra (cinatra#402 P2), materialized
# into the image at node_modules/@cinatra-ai/cinatra (Dockerfile runtime stage).
# CINATRA_REPO_ROOT=/app is set explicitly: with the published CLI at
# node_modules/, getRepoRoot()'s module-relative candidate no longer resolves, so
# the repo root comes from the cwd-walk (cwd=/app, the image WORKDIR) — the env
# override makes that load-bearing resolution explicit and cwd-independent.
# Asserting exit 0 here covers: the standalone-image acquisition no-op guard
# (runs BEFORE any DB mutation), the bundled Better Auth migration on a fresh
# DB, store schema + default organization + MCP settings rows.
#
# First, prove the DEPLOY-COMPAT LEGACY FORWARDER path (cinatra#402 P2). External
# deploy tooling (cinatra-ai/ops) still invokes `node packages/cli/bin/cinatra.mjs`
# (cwd=/app); the image ships a thin shim at that path that re-execs the published
# CLI. This DB-free `--help` smoke fails the boot gate if that forwarder is broken
# (missing target, wrong exec, non-zero exit), so the legacy path ops depends on
# is proven by CI — not just static review.
echo "==> deploy-compat legacy forwarder smoke (node packages/cli/bin/cinatra.mjs --help)"
LEGACY_HELP="$(docker run --rm "$IMAGE" node packages/cli/bin/cinatra.mjs --help 2>&1)" || {
  printf '%s\n' "$LEGACY_HELP"
  fail "legacy deploy-compat forwarder (packages/cli/bin/cinatra.mjs) did not run --help cleanly."
}
if ! printf '%s' "$LEGACY_HELP" | grep -qiE 'Cinatra setup CLI|Usage:'; then
  printf '%s\n' "$LEGACY_HELP"
  fail "legacy forwarder ran but did not forward to the published CLI (no help banner)."
fi
echo "    legacy forwarder OK — re-execs the published @cinatra-ai/cinatra CLI"

echo "==> cinatra setup prod (fresh database)"
docker run --rm --network "$NET" \
  -e SUPABASE_DB_URL="$DB_URL_IN_NET" \
  -e SUPABASE_SCHEMA=cinatra \
  -e BETTER_AUTH_SECRET="$AUTH_SECRET" \
  -e BETTER_AUTH_URL="$APP_ORIGIN" \
  -e CINATRA_ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  -e CINATRA_RUNTIME_MODE=production \
  -e CINATRA_REPO_ROOT=/app \
  "$IMAGE" node node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs setup prod

# ── 3. Boot the app container (Next standalone server.js) ────────────────────
# Env mirrors the ops app-container contract (environments/cinatra_cinatra_app):
# HOSTNAME=0.0.0.0 so the server binds beyond container loopback;
# CINATRA_RUNTIME_MODE=production matches the ops secrets file and arms the
# fail-closed activation assert. Optional platform services (Nango, Neo4j,
# Graphiti) are deliberately absent — the core must boot and serve without
# them. OPENAI_API_KEY carries an inert placeholder (same set the Dockerfile
# build phase needs at import time).
echo "==> booting app container"
docker run -d --name "$APP" --network "$NET" \
  -e HOSTNAME=0.0.0.0 \
  -e SUPABASE_DB_URL="$DB_URL_IN_NET" \
  -e SUPABASE_SCHEMA=cinatra \
  -e BETTER_AUTH_SECRET="$AUTH_SECRET" \
  -e BETTER_AUTH_URL="$APP_ORIGIN" \
  -e NEXT_PUBLIC_BETTER_AUTH_URL="$APP_ORIGIN" \
  -e NEXT_PUBLIC_APP_URL="$APP_ORIGIN" \
  -e NEXT_PUBLIC_SITE_URL="$APP_ORIGIN" \
  -e REDIS_URL="redis://${REDIS}:6379" \
  -e CINATRA_ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  -e CINATRA_RUNTIME_MODE=production \
  -e NANGO_ENCRYPTION_KEY="prod-boot-e2e-placeholder-not-a-real-key" \
  -e OPENAI_API_KEY="sk-prod-boot-e2e-placeholder" \
  "$IMAGE" >/dev/null

# ── 4. Health gate: /api/health must answer 200 {"status":"ok"} ─────────────
echo "==> waiting for /api/health (budget ${BOOT_TIMEOUT_SECS}s)"
DEADLINE=$((SECONDS + BOOT_TIMEOUT_SECS))
HEALTH_OUT=""
while true; do
  if HEALTH_OUT=$(probe "${APP_ORIGIN}/api/health" 2>/dev/null) \
     && [ "${HEALTH_OUT%% *}" = "200" ]; then
    break
  fi
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    fail "/api/health did not answer 200 within ${BOOT_TIMEOUT_SECS}s."
  fi
  # A crashed container will never become healthy — fail fast with its logs
  # (this is where a thrown required-extension activation assert lands).
  if [ "$(docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null)" != "true" ]; then
    fail "app container exited before becoming healthy."
  fi
  sleep 3
done
if ! printf '%s' "$HEALTH_OUT" | grep -q '"status":"ok"'; then
  fail "/api/health answered 200 but body lacks \"status\":\"ok\": ${HEALTH_OUT}"
fi
echo "    /api/health OK"

# ── 5. Page-render smoke: / -> (route guard) -> sign-up|sign-in -> 200 ──────
# Follows the unauthenticated fresh-instance redirect chain and requires a
# final 200 ON AN AUTH SURFACE — this exercises the real page pipeline (proxy
# route guard, Better Auth session check against the fresh DB, a
# server-rendered page), not just a DB-free route handler. A redirect loop or
# a 500 on first paint fails here; so does a 200 on any OTHER path (an
# unauthenticated `/` must never leak an app page — a fresh instance lands on
# /sign-up, an instance with users on /sign-in; both are guard-approved).
echo "==> page-render smoke: GET ${APP_ORIGIN}/"
PAGE_OUT=$(probe "${APP_ORIGIN}/")
PAGE_STATUS_LINE="${PAGE_OUT%%$'\n'*}"
PAGE_CODE="${PAGE_STATUS_LINE%% *}"
PAGE_URL="${PAGE_STATUS_LINE#* }"
if [ "$PAGE_CODE" != "200" ]; then
  fail "GET / ended with HTTP ${PAGE_CODE} at ${PAGE_URL} (expected 200)."
fi
PAGE_PATH="${PAGE_URL#"${APP_ORIGIN}"}"
case "$PAGE_PATH" in
  /sign-up|/sign-up\?*|/sign-in|/sign-in\?*) ;;
  *) fail "GET / ended 200 at '${PAGE_URL}' — expected the route guard to land on /sign-up or /sign-in, not '${PAGE_PATH}' (unauthenticated leak?)." ;;
esac
echo "    GET / -> ${PAGE_CODE} at ${PAGE_URL}"

# ── 6a. Fresh-DB anchor assertion (data-driven; no extension-name literals) ──
# The StaticBundleLoader seeds ONE platform-scoped lifecycle anchor row per
# bundled serverEntry package BEFORE its allow-list gate (static-bundle-
# lifecycle.ts), and required-in-prod anchors auto-lock in production. All
# three counts must be non-zero on a fresh DB — this proves the boot loaders
# ran against the real schema AND `cinatra.extensions` was readable
# at runtime, without naming a single extension.
echo "==> fresh-DB assertion: static-bundle lifecycle anchor rows"
ANCHOR_COUNTS=$(docker exec "$PG" psql -U postgres -d postgres -tA -F ' ' -c "
  SELECT count(*),
         count(*) FILTER (WHERE required_in_prod),
         count(*) FILTER (WHERE status IN ('active','locked'))
  FROM cinatra.installed_extension
  WHERE owner_level = 'platform'
    AND source->>'type' = 'local'
    AND source->>'path' LIKE 'static-bundle:%';
")
read -r ANCHORS REQUIRED_ANCHORS LIVE_ANCHORS <<<"$ANCHOR_COUNTS"
echo "    anchors=${ANCHORS} required_in_prod=${REQUIRED_ANCHORS} live=${LIVE_ANCHORS}"
if [ "${ANCHORS:-0}" -eq 0 ] || [ "${REQUIRED_ANCHORS:-0}" -eq 0 ] || [ "${LIVE_ANCHORS:-0}" -eq 0 ]; then
  fail "static-bundle anchor seeding left a zero count (anchors=${ANCHORS}, required=${REQUIRED_ANCHORS}, live=${LIVE_ANCHORS})."
fi

# ── 6a-bis. Required-set EQUALITY (still data-driven; no extension-name
# literals). The required_in_prod anchor rows on the fresh DB must equal —
# exactly, both directions — the image's OWN `cinatra.extensions`
# declaration. After the bootable-set shrink (cinatra#7) this pins that a
# fresh prod DB is seeded with ONLY the declared required/system set: a
# stale image declaration, a leftover hardcoded list, or a seeding path that
# resurrects demoted packages all fail here.
echo "==> fresh-DB assertion: required anchors == the image's declared required set"
DECLARED_REQUIRED=$(docker exec "$APP" node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("/app/package.json", "utf8"));
  const names = ((pkg.cinatra && pkg.cinatra.extensions) || []).map((e) => {
    const at = e.lastIndexOf("@");
    return at <= 0 ? e : e.slice(0, at);
  });
  if (names.length === 0) { console.error("image declaration is empty"); process.exit(1); }
  console.log(names.sort().join("\n"));
')
DB_REQUIRED=$(docker exec "$PG" psql -U postgres -d postgres -tA -c "
  SELECT package_name FROM cinatra.installed_extension
  WHERE owner_level = 'platform'
    AND required_in_prod
    AND source->>'type' = 'local'
    AND source->>'path' LIKE 'static-bundle:%'
  ORDER BY package_name;
")
if [ "$DECLARED_REQUIRED" != "$DB_REQUIRED" ]; then
  echo "--- declared (image package.json):"; printf '%s\n' "$DECLARED_REQUIRED"
  echo "--- required_in_prod anchors (fresh DB):"; printf '%s\n' "$DB_REQUIRED"
  fail "required_in_prod anchor set != the image's declared extensions."
fi
echo "    required anchors == declared required set ($(printf '%s\n' "$DB_REQUIRED" | wc -l | tr -d ' ') packages)"

# ── 6b. Boot-log assertion: loader line present, fatal markers absent ────────
APP_LOGS=$(docker logs "$APP" 2>&1)
if ! printf '%s' "$APP_LOGS" | grep -q '\[boot\] StaticBundleLoader:'; then
  fail "app log lacks the '[boot] StaticBundleLoader:' line — the bundled loader never reported."
fi
for FATAL in 'did not activate' 'StaticBundleLoader failed'; do
  if printf '%s' "$APP_LOGS" | grep -qF "$FATAL"; then
    fail "app log contains fatal boot marker: '${FATAL}'."
  fi
done
echo "    boot log OK (loader reported; no fatal markers)"

echo "==> prod-boot e2e PASSED: the image boots and serves with only the lock-acquired required-extension set (no private extensions cloned)."
