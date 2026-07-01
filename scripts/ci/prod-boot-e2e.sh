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

# Required-extension deploy-materialization (cinatra-ai/ops#436). The app boots
# with a NON-DEFAULT agent-install dir (proving the CINATRA_AGENT_INSTALL_DIR
# decoupling) backed by a named volume we pre-seed with STALE state, so the
# assertions below prove: (i) the env override is honored, (ii) the boot phase
# materializes the required-set OAS trees from the image seed into that dir,
# (iii) a stale seed-owned dir is pruned, (iv) a coexisting user dir survives.
AGENT_INSTALL_DIR="/srv/agents"
AGENT_INSTALL_VOL="${RUN_ID}-agents"

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
# WayFlow bridge callback token (cinatra#789 item 3). The app asserts its PRESENCE at
# boot (missing => a clear soft-required WARN, not a boot abort); provided here so the
# positive path exercises the "present" branch. The deploy provisions the real value.
BRIDGE_TOKEN="prod-boot-e2e-bridge-token-0000000000000000"
DB_URL_IN_NET="postgresql://postgres:postgres@${PG}:5432/postgres"

# Negative/rollback-case container + volume names (cinatra#789). Torn down alongside
# the main run so an aborted script never leaks them.
APP_DEGRADED="${RUN_ID}-app-degraded"
APP_MISSING_ENV="${RUN_ID}-app-missing-env"
APP_ROLLBACK="${RUN_ID}-app-rollback"
APP_NO_MOUNT="${RUN_ID}-app-no-mount"

cleanup() {
  docker rm -f "$APP" "$APP_DEGRADED" "$APP_MISSING_ENV" "$APP_ROLLBACK" "$APP_NO_MOUNT" \
    "$PG" "$REDIS" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$AGENT_INSTALL_VOL" "${RUN_ID}-agents-nomount" >/dev/null 2>&1 || true
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

# Negative-case helper (cinatra#789 items 1+3): run a throwaway app container with
# EXTRA env args, poll to TERMINAL readiness, and echo `<state> <http-code> <body>`:
#   "healthy 200 <json>"    — /api/health answered 200 status:"ok" (fully ready)
#   "degraded <code> <json>"— a TERMINAL non-ok status (degraded|error); code is the
#                             HTTP code so the caller can assert 503
#   "crashed 0 -"           — the container exited before serving
#   "timeout 0 -"           — never reached a terminal state within the budget
# IMPORTANT: status:"starting" is TRANSIENT (boot not yet at markBootReady) — the
# helper KEEPS POLLING on it, never treating it as terminal (so a slow boot does not
# false-return degraded before the durable-degraded probe or the settled state).
# It NEVER trips the global ERR trap (all branches echo + return 0), uses a DISTINCT
# container name, and the caller tears the container down.
# Args: <container-name> <budget-secs> [extra docker -e/-v args...]
run_boot_case() {
  local cname="$1"; shift
  local budget="$1"; shift
  docker rm -f "$cname" >/dev/null 2>&1 || true
  docker run -d --name "$cname" --network "$NET" \
    -e HOSTNAME=0.0.0.0 \
    -e SUPABASE_DB_URL="$DB_URL_IN_NET" \
    -e SUPABASE_SCHEMA=cinatra \
    -e BETTER_AUTH_SECRET="$AUTH_SECRET" \
    -e BETTER_AUTH_URL="http://${cname}:3000" \
    -e NEXT_PUBLIC_BETTER_AUTH_URL="http://${cname}:3000" \
    -e NEXT_PUBLIC_APP_URL="http://${cname}:3000" \
    -e NEXT_PUBLIC_SITE_URL="http://${cname}:3000" \
    -e REDIS_URL="redis://${REDIS}:6379" \
    -e CINATRA_ENCRYPTION_KEY="$ENCRYPTION_KEY" \
    -e CINATRA_RUNTIME_MODE=production \
    -e NANGO_ENCRYPTION_KEY="prod-boot-e2e-placeholder-not-a-real-key" \
    -e OPENAI_API_KEY="sk-prod-boot-e2e-placeholder" \
    -e CINATRA_BRIDGE_TOKEN="$BRIDGE_TOKEN" \
    "$@" \
    "$IMAGE" >/dev/null 2>&1 || { echo "crashed 0 -"; return 0; }

  local origin="http://${cname}:3000"
  local deadline=$((SECONDS + budget))
  while true; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$cname" 2>/dev/null)" != "true" ]; then
      echo "crashed 0 -"; return 0
    fi
    local out
    if out=$(probe "${origin}/api/health" 2>/dev/null); then
      local code="${out%% *}"
      local body="${out#*$'\n'}"
      if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"status":"ok"'; then
        echo "healthy ${code} ${body}"; return 0
      fi
      # TERMINAL not-ready states (durable-degraded or fatal). NOTE: "starting" is
      # transient — fall through and keep polling.
      if printf '%s' "$body" | grep -qE '"status":"(degraded|error)"'; then
        echo "degraded ${code} ${body}"; return 0
      fi
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "timeout 0 -"; return 0
    fi
    sleep 3
  done
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
# ── 2b. Pre-seed the agent-install volume with STALE state (ops#436) ─────────
# Before boot, plant into the (non-default) install dir:
#   - a STALE seed-owned dir: vendor `zz-stale`/slug `gone-agent` carrying the
#     ownership marker `.cinatra-required-seed.json` — NOT in the image seed, so
#     the boot reconcile must PRUNE it;
#   - a USER dir: vendor `acme`/slug `user-agent` with NO marker — the reconcile
#     must NEVER touch it.
# This proves the prune is ownership-bounded and user-installs are preserved.
echo "==> pre-seeding agent-install volume with stale + user dirs"
docker run --rm -v "${AGENT_INSTALL_VOL}:${AGENT_INSTALL_DIR}" "$IMAGE" sh -c "
  set -e
  mkdir -p '${AGENT_INSTALL_DIR}/zz-stale/gone-agent/cinatra'
  echo '{\"openapi\":\"3.1.0\"}' > '${AGENT_INSTALL_DIR}/zz-stale/gone-agent/cinatra/oas.json'
  echo '{\"vendor\":\"zz-stale\",\"slug\":\"gone-agent\",\"kind\":\"required-oas-seed\"}' \
    > '${AGENT_INSTALL_DIR}/zz-stale/gone-agent/.cinatra-required-seed.json'
  mkdir -p '${AGENT_INSTALL_DIR}/acme/user-agent/cinatra'
  echo '{\"openapi\":\"3.1.0\"}' > '${AGENT_INSTALL_DIR}/acme/user-agent/cinatra/oas.json'
"

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
  -e CINATRA_BRIDGE_TOKEN="$BRIDGE_TOKEN" \
  -e CINATRA_AGENT_INSTALL_DIR="$AGENT_INSTALL_DIR" \
  -v "${AGENT_INSTALL_VOL}:${AGENT_INSTALL_DIR}" \
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

# ── 6c. Required-extension deploy-materialization assertion (ops#436) ────────
# The app booted with CINATRA_AGENT_INSTALL_DIR=${AGENT_INSTALL_DIR} (a
# non-default, pre-seeded-stale dir). Prove the boot reconcile:
#   (i)   honored the env override (the install dir is the one we set);
#   (ii)  materialized the image seed's required agent OAS trees into it
#         (the dir now mirrors /app/.cinatra-required-oas-seed's manifest);
#   (iii) PRUNED the stale seed-owned dir (zz-stale/gone-agent);
#   (iv)  PRESERVED the coexisting user dir (acme/user-agent, no marker).
echo "==> ops#436 assertion: required-extension materialization into ${AGENT_INSTALL_DIR}"
MAT_CHECK=$(docker exec "$APP" node -e '
  const fs = require("fs");
  const path = require("path");
  const installDir = process.env.CINATRA_AGENT_INSTALL_DIR;
  const seedDir = "/app/.cinatra-required-oas-seed";
  const manifest = JSON.parse(fs.readFileSync(path.join(seedDir, "manifest.json"), "utf8"));
  const slugs = manifest.slugs || [];
  // (ii) every seeded required slug is present in the install dir AND its FULL
  // projected surface (cinatra/**, skills/**, package.json, the seed marker) is
  // byte-identical to the seed — not just oas.json. A regression that stops
  // copying skills/ or package.json fails here.
  const listFiles = (root, rel = "") => {
    const out = [];
    for (const name of fs.readdirSync(path.join(root, rel || "."))) {
      const r = rel ? rel + "/" + name : name;
      const st = fs.lstatSync(path.join(root, r));
      if (st.isDirectory()) out.push(...listFiles(root, r));
      else if (st.isFile()) out.push(r);
    }
    return out.sort();
  };
  for (const { vendor, slug } of slugs) {
    const liveDir = path.join(installDir, vendor, slug);
    const seedSlugDir = path.join(seedDir, vendor, slug);
    if (!fs.existsSync(liveDir)) { console.error("MISSING " + vendor + "/" + slug); process.exit(1); }
    for (const rel of listFiles(seedSlugDir)) {
      const live = path.join(liveDir, rel);
      const seed = path.join(seedSlugDir, rel);
      if (!fs.existsSync(live)) { console.error("MISSING-FILE " + vendor + "/" + slug + "/" + rel); process.exit(1); }
      if (!fs.readFileSync(live).equals(fs.readFileSync(seed))) {
        console.error("STALE " + vendor + "/" + slug + "/" + rel); process.exit(1);
      }
    }
  }
  // (iii) the stale seed-owned dir was pruned.
  if (fs.existsSync(path.join(installDir, "zz-stale", "gone-agent"))) {
    console.error("STALE-NOT-PRUNED zz-stale/gone-agent"); process.exit(1);
  }
  // (iv) the coexisting user dir (no marker) survived.
  if (!fs.existsSync(path.join(installDir, "acme", "user-agent", "cinatra", "oas.json"))) {
    console.error("USER-DIR-PRUNED acme/user-agent"); process.exit(1);
  }
  console.log("seeded=" + slugs.length + " pruned-stale preserved-user");
') || fail "ops#436 materialization assertion failed (see node error above)."
echo "    materialize OK (${MAT_CHECK})"

# ── 7a. Health-readiness gate REJECTS a durable-degraded boot (cinatra#789 item 1) ─
# The KEY acceptance: a NON-fatal (durable `degraded`-policy) phase failure must make
# the TOP-LEVEL health status non-"ok" + HTTP 503, so a deploy health gate polling
# top-level status REJECTS the instance (previously top-level status was hard-coded
# "ok" and a degraded boot passed). We drive a deterministic durable-degraded boot via
# the DOUBLE-armed test seam (CINATRA_BOOT_E2E=1 + CINATRA_BOOT_SIMULATE_DEGRADED=1 —
# inert in any real deploy) and assert the SAME poll the forward gate uses would fail.
echo "==> item 1 assertion: health gate REJECTS a durable-degraded boot"
DEGRADED_RESULT=$(run_boot_case "$APP_DEGRADED" 90 \
  -e CINATRA_BOOT_E2E=1 -e CINATRA_BOOT_SIMULATE_DEGRADED=1 \
  -e CINATRA_AGENT_INSTALL_DIR="$AGENT_INSTALL_DIR")
DEGRADED_STATE="${DEGRADED_RESULT%% *}"        # first token: state
DEGRADED_REST="${DEGRADED_RESULT#* }"          # drop state
DEGRADED_CODE="${DEGRADED_REST%% *}"           # second token: HTTP code
DEGRADED_BODY="${DEGRADED_REST#* }"            # remainder: body
if [ "$DEGRADED_STATE" != "degraded" ]; then
  echo "--- degraded-case result: ${DEGRADED_RESULT}"
  docker logs "$APP_DEGRADED" 2>&1 | tail -80 || true
  fail "a durable-degraded boot did NOT fail the health gate (state=${DEGRADED_STATE}); the deploy would have accepted a degraded instance."
fi
# The deploy REJECTS it via BOTH the top-level status AND the HTTP code. Assert 503
# explicitly so a regression to `200 {"status":"degraded"}` (which a status-only gate
# might still pass) is caught.
if [ "$DEGRADED_CODE" != "503" ]; then
  echo "--- degraded-case result: ${DEGRADED_RESULT}"
  fail "durable-degraded boot returned HTTP ${DEGRADED_CODE}, expected 503 — a top-level-status health gate that also checks HTTP would not reject it."
fi
if ! printf '%s' "$DEGRADED_BODY" | grep -q '"status":"degraded"'; then
  echo "--- degraded-case result: ${DEGRADED_RESULT}"
  fail "durable-degraded boot reported a non-'degraded' top-level status: ${DEGRADED_BODY}"
fi
if ! printf '%s' "$DEGRADED_BODY" | grep -q '"blockingPhases":\["boot-degrade-probe"\]'; then
  echo "--- degraded-case result: ${DEGRADED_RESULT}"
  fail "durable-degraded boot did not list boot-degrade-probe in blockingPhases: ${DEGRADED_BODY}"
fi
docker rm -f "$APP_DEGRADED" >/dev/null 2>&1 || true
echo "    health gate REJECTS durable-degraded boot (status:degraded + HTTP 503; blockingPhases=[boot-degrade-probe])"

# ── 7b. Missing required env fails clearly + early (cinatra#789 item 3) ──────────
# Omit TWO hard-required env vars (BETTER_AUTH_SECRET + CINATRA_ENCRYPTION_KEY) and
# assert the boot does NOT become healthy AND the import-time preflight aborts with a
# CLEAR, AGGREGATED message naming BOTH — proving the new preflight (not just the
# narrower auth.ts backstop) fired and aggregates. Either way the container never
# reaches a healthy /api/health.
echo "==> item 3 assertion: a missing required env fails the boot early with a clear aggregated message"
docker rm -f "$APP_MISSING_ENV" >/dev/null 2>&1 || true
docker run -d --name "$APP_MISSING_ENV" --network "$NET" \
  -e HOSTNAME=0.0.0.0 \
  -e SUPABASE_DB_URL="$DB_URL_IN_NET" \
  -e SUPABASE_SCHEMA=cinatra \
  -e REDIS_URL="redis://${REDIS}:6379" \
  -e CINATRA_RUNTIME_MODE=production \
  -e CINATRA_BRIDGE_TOKEN="$BRIDGE_TOKEN" \
  "$IMAGE" >/dev/null 2>&1 || true
# Wait a bounded time; the container must NOT become healthy.
MISSING_ENV_HEALTHY=no
DEADLINE=$((SECONDS + 60))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$APP_MISSING_ENV" 2>/dev/null)" != "true" ]; then
    break  # crashed as expected
  fi
  if OUT=$(probe "http://${APP_MISSING_ENV}:3000/api/health" 2>/dev/null) \
     && printf '%s' "$OUT" | grep -q '"status":"ok"'; then
    MISSING_ENV_HEALTHY=yes; break
  fi
  sleep 3
done
# Capture a BOUNDED tail of the (crash-looping) container's logs. A crash loop repeats
# the preflight abort many times; the last 200 lines carry it. Bounding avoids feeding
# a multi-MB string into `grep -q`, whose early exit would SIGPIPE a `printf | grep`
# pipe (a false "not found"). Assertions below use herestrings (no pipe → no SIGPIPE).
MISSING_ENV_LOGS=$(docker logs "$APP_MISSING_ENV" 2>&1 | tail -200 || true)
if [ "$MISSING_ENV_HEALTHY" = "yes" ]; then
  printf '%s\n' "$MISSING_ENV_LOGS"
  fail "boot with MISSING hard-required env became healthy — a misconfigured deploy must fail clearly, not serve."
fi
# The import-time preflight must have fired with its clear aggregated message.
if ! grep -qF '[required-env-preflight]' <<<"$MISSING_ENV_LOGS"; then
  printf '%s\n' "$MISSING_ENV_LOGS"
  fail "boot failed but the [required-env-preflight] aggregated message is absent — the preflight did not fire first."
fi
# It must NAME both omitted hard vars (aggregation), not just the first.
for VAR in BETTER_AUTH_SECRET CINATRA_ENCRYPTION_KEY; do
  if ! grep -qF "$VAR" <<<"$MISSING_ENV_LOGS"; then
    printf '%s\n' "$MISSING_ENV_LOGS"
    fail "the preflight failure did not NAME the missing var ${VAR} (aggregation/clarity gap)."
  fi
done
docker rm -f "$APP_MISSING_ENV" >/dev/null 2>&1 || true
echo "    missing required env fails boot early + clearly ([required-env-preflight] names BETTER_AUTH_SECRET + CINATRA_ENCRYPTION_KEY)"

# ── 7c. Reverse rollback: an OLDER seed prunes NEWER seed-owned dirs, keeps user ──
# The forward direction (6c) proved a newer image prunes STALE seed-owned dirs. The
# reverse: after the forward reconcile settled, plant a NEWER seed-owned dir (marker
# present, ABSENT from the current image manifest — i.e. a dir a FUTURE image had
# installed) into the SAME install volume, then RESTART the app (a real second boot
# whose current, relatively-OLDER seed must PRUNE that newer seed-owned dir) while the
# user dir survives. (cinatra#789 item 2.)
echo "==> item 2 assertion: reverse rollback prunes a newer seed-owned dir, preserves user installs"
docker run --rm -v "${AGENT_INSTALL_VOL}:${AGENT_INSTALL_DIR}" "$IMAGE" sh -c "
  set -e
  mkdir -p '${AGENT_INSTALL_DIR}/zz-newer/future-agent/cinatra'
  echo '{\"openapi\":\"3.1.0\"}' > '${AGENT_INSTALL_DIR}/zz-newer/future-agent/cinatra/oas.json'
  echo '{\"vendor\":\"zz-newer\",\"slug\":\"future-agent\",\"kind\":\"required-oas-seed\"}' \
    > '${AGENT_INSTALL_DIR}/zz-newer/future-agent/.cinatra-required-seed.json'
"
docker restart "$APP" >/dev/null
echo "    waiting for app to become healthy again after restart (budget ${BOOT_TIMEOUT_SECS}s)"
DEADLINE=$((SECONDS + BOOT_TIMEOUT_SECS))
while true; do
  if HEALTH_OUT=$(probe "${APP_ORIGIN}/api/health" 2>/dev/null) \
     && [ "${HEALTH_OUT%% *}" = "200" ] \
     && printf '%s' "${HEALTH_OUT#*$'\n'}" | grep -q '"status":"ok"'; then
    break
  fi
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    fail "app did not become healthy again within ${BOOT_TIMEOUT_SECS}s after the rollback restart."
  fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$APP" 2>/dev/null)" != "true" ]; then
    fail "app container exited during the rollback restart."
  fi
  sleep 3
done
ROLLBACK_CHECK=$(docker exec "$APP" node -e '
  const fs = require("fs");
  const path = require("path");
  const installDir = process.env.CINATRA_AGENT_INSTALL_DIR;
  const seedDir = "/app/.cinatra-required-oas-seed";
  const manifest = JSON.parse(fs.readFileSync(path.join(seedDir, "manifest.json"), "utf8"));
  const slugs = manifest.slugs || [];
  // Current (relatively-older) seed dirs must still be present.
  for (const { vendor, slug } of slugs) {
    if (!fs.existsSync(path.join(installDir, vendor, slug))) {
      console.error("CURRENT-SEED-MISSING " + vendor + "/" + slug); process.exit(1);
    }
  }
  // The NEWER seed-owned dir (marker present, not in the current manifest) must be PRUNED.
  if (fs.existsSync(path.join(installDir, "zz-newer", "future-agent"))) {
    console.error("NEWER-SEED-NOT-PRUNED zz-newer/future-agent"); process.exit(1);
  }
  // The user dir (no marker) must STILL survive the rollback.
  if (!fs.existsSync(path.join(installDir, "acme", "user-agent", "cinatra", "oas.json"))) {
    console.error("USER-DIR-PRUNED-ON-ROLLBACK acme/user-agent"); process.exit(1);
  }
  console.log("current-seed-kept newer-pruned user-preserved");
') || fail "reverse-rollback assertion failed (see node error above)."
echo "    reverse rollback OK (${ROLLBACK_CHECK})"

# ── 7d. User-store durable-mount detection is not silent (cinatra#789 item 5) ────
# Boot WITHOUT a durable /data/extensions/packages mount and assert the app STILL
# serves (the check is non-deploy-blocking) BUT the missing durable mount is DETECTED
# — surfaced in health boot.degradedPhases (retryable failure) and named in the logs
# — so user installs are never SILENTLY treated as ephemeral.
echo "==> item 5 assertion: missing durable user-store mount is DETECTED (not silent)"
# Give this case its own agent-install volume so the fail-closed materialize succeeds
# (the seed reconciles fine); the point under test is the SEPARATE durable USER store
# (/data/extensions/packages), which is deliberately NOT mounted here.
NO_MOUNT_AGENT_VOL="${RUN_ID}-agents-nomount"
NO_MOUNT_RESULT=$(run_boot_case "$APP_NO_MOUNT" 90 \
  -e CINATRA_AGENT_INSTALL_DIR="$AGENT_INSTALL_DIR" \
  -v "${NO_MOUNT_AGENT_VOL}:${AGENT_INSTALL_DIR}")
NO_MOUNT_STATE="${NO_MOUNT_RESULT%% *}"       # state
NO_MOUNT_REST="${NO_MOUNT_RESULT#* }"
NO_MOUNT_CODE="${NO_MOUNT_REST%% *}"          # HTTP code
NO_MOUNT_BODY="${NO_MOUNT_REST#* }"           # body
# Non-blocking: the app must still be healthy (status:ok / 200) even without the mount.
if [ "$NO_MOUNT_STATE" != "healthy" ] || [ "$NO_MOUNT_CODE" != "200" ]; then
  echo "--- no-mount result: ${NO_MOUNT_RESULT}"
  docker logs "$APP_NO_MOUNT" 2>&1 | tail -60 || true
  fail "boot WITHOUT the durable user-store mount was not healthy (state=${NO_MOUNT_STATE} code=${NO_MOUNT_CODE}); the mount check must be non-blocking (a retryable failure keeps status:ok/200)."
fi
# But the deficit must be VISIBLE: the phase is recorded in degradedPhases.
if ! printf '%s' "$NO_MOUNT_BODY" | grep -q 'user-store-mount-check'; then
  echo "--- no-mount health body: ${NO_MOUNT_BODY}"
  fail "missing durable user-store mount was NOT surfaced in health degradedPhases (silent — user installs would vanish on restart undetected)."
fi
NO_MOUNT_LOGS=$(docker logs "$APP_NO_MOUNT" 2>&1 | tail -300 || true)
if ! grep -qF 'user-store-mount-check' <<<"$NO_MOUNT_LOGS"; then
  printf '%s\n' "$NO_MOUNT_LOGS" | tail -40
  fail "missing durable user-store mount was not logged clearly."
fi
docker rm -f "$APP_NO_MOUNT" >/dev/null 2>&1 || true
echo "    missing durable user-store mount DETECTED (health degradedPhases + logs; non-blocking)"

echo "==> prod-boot e2e PASSED: the image boots and serves with only the lock-acquired required-extension set (no private extensions cloned); required-extension set materialized into the deploy-managed agent dir (ops#436); health gate rejects a durable-degraded boot; missing required env fails clearly; reverse rollback prunes newer seed-owned dirs and preserves user installs; missing durable user-store mount is detected (cinatra#789)."
