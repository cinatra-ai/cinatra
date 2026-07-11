#!/usr/bin/env bash
set -euo pipefail

# Previous-release upgrade proof (closeout W3, cinatra#74).
#
# Proves the OPERATOR UPGRADE PATH end to end: a database that was provisioned
# by the PREVIOUS published release, carrying real rows, survives an in-place
# upgrade to the CURRENT checkout (the release candidate) — the migration
# ledger ends up consistent and the pre-existing data is preserved.
#
# WHY this is the real engineering (not just another boot gate): a fresh
# database is the easy case — the bootstrap DDL emits the CURRENT shape and
# the migration chain is LEDGER-FAKED (recorded, never executed; see
# packages/migrations/src/core-migrations.mjs `isFreshCoreSchema`). The path that can
# actually lose user data is the EXISTING deployment: the bootstrap DDL runs
# additively over real tables and then the migration chain EXECUTES its
# transformations (drops/renames/retypes/backfills) against rows that already
# exist. This script exercises exactly that path against the artifact a real
# operator upgrades FROM — the previous release's published image.
#
# The exercised sequence mirrors the production upgrade documented in
# migrations/README.md ("Existing deployments / operator upgrade path") and the
# boot order in src/instrumentation.node.ts (bootstrap DDL -> core migrations):
#
#   1. fresh Postgres on an ISOLATED docker network, reachable in-network by
#      DNS; an EPHEMERAL loopback port (127.0.0.1::5432, docker-assigned) is
#      published only so the host-side candidate tooling can connect — bound to
#      loopback and never a fixed port, so it cannot collide with a dev server
#      or another CI job;
#   2. PREVIOUS RELEASE: `cinatra setup prod` from the ${PREV_IMAGE} image
#      against the fresh DB — provisions the OLD schema shape + its `metadata`
#      table (the freshness key that makes the later chain EXECUTE, not fake);
#   3. SEED representative data-bearing rows into a table that the upgrade
#      preserves (notifications: kept across the upgrade — only additively
#      ALTERed). These rows stand in for real user data and MUST survive;
#   4. UPGRADE to the candidate (this checkout): apply the candidate bootstrap
#      DDL (buildCreateStoreSchemaQueries — the exact `ensureStoreSchema` boot
#      pass) and then run the candidate core migration chain through the SAME
#      runner production uses (`cinatra db migrate`). Because `metadata` exists,
#      the chain EXECUTES against the seeded data;
#   5. ASSERT, on the upgraded DB:
#      (a) MIGRATION-LEDGER INTEGRITY — every candidate core__NNNN migration
#          listed in migrations/manifest.json is present in the `pgmigrations`
#          ledger with a non-null run_on, the ledger count matches, and ledger
#          ids are strictly distinct (no double-apply);
#      (b) DATA PRESERVATION — every seeded row still exists, byte-identical
#          payload;
#      (c) re-running the chain is a NO-OP (idempotent — "No migrations to run").
#
# A NOTE ON THE agent_templates PLACEHOLDER (deliberately NOT a seed target):
# the previous release ships agent_templates as the legacy (id, payload)
# placeholder; the candidate bootstrap DDL detects that shape and DROPs+rebuilds
# it into the typed schema (src/lib/drizzle-store.ts "Pre-structured-column
# schema detection and cleanup"), repopulating from the source schema on
# setup-branch. That is intended structural replacement, not data loss, so the
# preservation assertion uses notifications — a table the upgrade evolves
# purely additively.
#
# Usage (CI runs exactly this; locally too):
#   PREV_IMAGE=ghcr.io/cinatra-ai/cinatra:0.1.0 bash scripts/ci/upgrade-proof.sh
#
# On Apple Silicon the published amd64 image runs under emulation; the script
# passes --platform "$PREV_IMAGE_PLATFORM" (default linux/amd64) to the
# previous-release container so the proof runs on a developer laptop too.
#
# Env:
#   PREV_IMAGE           (required) the PREVIOUS release image ref to upgrade
#                        FROM (e.g. ghcr.io/cinatra-ai/cinatra:0.1.0). It must
#                        be a published, bootable standalone prod image.
#   PREV_IMAGE_PLATFORM  docker --platform for the previous-release container
#                        (default linux/amd64 — the published images are amd64).
#   CANDIDATE_IMAGE      when set, the CANDIDATE side runs the RELEASE IMAGE'S
#                        OWN schema-sync instead of the checkout-side
#                        DDL+migrate: `setup prod` through the image's
#                        deploy-compat forwarder (node packages/cli/bin/
#                        cinatra.mjs, command surface auto-probed) — the exact
#                        container + entrypoint cinatra-ai/ops
#                        deploy-instance.sh runs against the EXISTING database
#                        on every deploy. This is the RELEASE-PROOF mode (the
#                        build-image.yml `upgrade-proof` job): the incident it
#                        bars was an image whose setup ran the versioned chain
#                        BEFORE its bootstrap DDL on an existing database —
#                        the checkout-side sequence hardcodes the correct
#                        order, so only running the image's own sequence can
#                        catch an ordering defect inside the image. Unset ->
#                        the original checkout-candidate behavior (the
#                        works-after dispatch arm), unchanged.
#   CANDIDATE_IMAGE_PLATFORM  docker --platform for the candidate container
#                        (default linux/amd64; mirrors PREV_IMAGE_PLATFORM —
#                        in CI the just-built candidate is runner-native amd64).
#   SUPABASE_SCHEMA      app schema (default cinatra).
#
# The CANDIDATE side, in the DEFAULT (checkout) mode, runs from the current
# checkout (this repo): its bootstrap DDL via the image schema-bootstrap
# bundle (built here from the checkout — the exact artifact the runtime image
# bakes) + its migration runner via the published `cinatra` CLI resolved from
# node_modules (@cinatra-ai/cinatra, a pinned devDependency; cinatra#402 P2).
# Run from the repo root (so node_modules/.bin/cinatra and the migrations/ +
# packages/migrations checkout sentinel are present). In CANDIDATE_IMAGE mode
# neither node_modules nor esbuild is needed — every candidate-side command
# runs inside the image, which already bakes its bundle.
#
# NOTE (cinatra#402 P2 transition — the deploy-compat forwarder era): the
# PREV_IMAGE side AUTO-DETECTS the provisioning entrypoint the previous release
# actually ships. Images from 0.1.6 onward carry the published CLI at
# node_modules/@cinatra-ai/cinatra and provision via `instance setup prod`
# (the exact invocation their own scripts/ci/prod-boot-e2e.sh used — the
# in-image packages/cli bin became a deploy-compat forwarder whose top-level
# `setup prod` command no longer exists). Older images (0.1.0–0.1.5) only ship
# the in-image packages/cli bin with the legacy top-level `setup prod`. The
# probe below picks whichever the image provides, so the proof keeps working
# for any published PREV_IMAGE without hand-editing.

PREV_IMAGE="${PREV_IMAGE:-}"
PREV_IMAGE_PLATFORM="${PREV_IMAGE_PLATFORM:-linux/amd64}"
CANDIDATE_IMAGE="${CANDIDATE_IMAGE:-}"
CANDIDATE_IMAGE_PLATFORM="${CANDIDATE_IMAGE_PLATFORM:-linux/amd64}"
SCHEMA="${SUPABASE_SCHEMA:-cinatra}"

if [ -z "$PREV_IMAGE" ]; then
  echo "ERROR: PREV_IMAGE env var is required (the previous-release image ref to upgrade FROM, e.g. ghcr.io/cinatra-ai/cinatra:0.1.0)." >&2
  exit 2
fi

# Resolve the repo root from this script's location and run from there, so the
# candidate-side node/tsx invocations (which use repo-relative paths like
# src/lib/drizzle-store.ts and migrations/manifest.json) work regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/../.."

# Inert throwaway credentials for the network-isolated instance.
# CINATRA_ENCRYPTION_KEY must be 64 hex chars (32 bytes).
AUTH_SECRET="upgrade-proof-throwaway-secret-00000000000000000000000000"
ENCRYPTION_KEY="00000000000000000000000000000000000000000000000000000000000000e2"
APP_ORIGIN="http://localhost:3000"

# Unique per-run names so a local re-run (or a leftover from an aborted one)
# never collides; everything is torn down by the EXIT trap.
RUN_ID="cinatra-upgrade-proof-$$"
NET="${RUN_ID}-net"
PG="${RUN_ID}-pg"
HOST_PORT=""             # filled once we know the published port (host-side candidate access)
DB_URL_IN_NET="postgresql://postgres:postgres@${PG}:5432/postgres"

cleanup() {
  # -v also drops the anonymous postgres:18 data volume so repeated CI/local
  # runs leave no dangling volumes behind.
  docker rm -fv "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}

dump_diag() {
  echo "::group::upgrade-proof failure diagnostics"
  echo "--- docker ps -a (run containers) ---"
  docker ps -a --filter "name=${RUN_ID}" || true
  echo "--- postgres logs ---"
  docker logs "$PG" 2>&1 | tail -60 || true
  echo "--- ledger (pgmigrations) ---"
  psql_q "SELECT id, name, run_on FROM \"${SCHEMA}\".pgmigrations ORDER BY id;" || true
  echo "::endgroup::"
}

on_err() {
  echo "ERROR: upgrade-proof FAILED (line $1)." >&2
  dump_diag
}
trap 'on_err $LINENO' ERR
trap cleanup EXIT

# Loud assertion failure: message + diagnostics + exit 1. A plain `exit 1`
# bypasses the ERR trap (the exit builtin is not a failing command), silently
# dropping the diagnostics — every assertion path must fail through here.
fail() {
  echo "ERROR: $*" >&2
  dump_diag
  exit 1
}

# Run a query inside the run's postgres container, tuple-only, '|' separated.
psql_q() {
  docker exec "$PG" psql -U postgres -d postgres -tA -F '|' -c "$1"
}

# ── CANDIDATE_IMAGE mode helpers ─────────────────────────────────────────────
# Detect the candidate image's CLI command surface and run its CLI the exact
# way cinatra-ai/ops deploy-instance.sh does: through the deploy-compat
# forwarder at packages/cli/bin/cinatra.mjs — NEVER the published CLI path
# directly. The forwarder is the prod entry point, so hardening applied INSIDE
# it (e.g. a pre-chain schema-bootstrap pass) must be exercised, not bypassed.
# The probe is ops's two-way banner detection, fail-closed: `instance --help`
# is handled before any command dispatch (it cannot touch the database); a
# namespaced banner selects `instance <cmd>`, the legacy top-level banner
# selects bare `<cmd>`, anything else refuses to guess.
CAND_CLI_NS=""
detect_candidate_cli_surface() {
  local probe_out
  if ! probe_out="$(docker run --rm --platform "$CANDIDATE_IMAGE_PLATFORM" \
        "$CANDIDATE_IMAGE" node packages/cli/bin/cinatra.mjs instance --help 2>/dev/null)" \
     || [ -z "$probe_out" ]; then
    fail "candidate CLI surface probe failed or printed nothing — refusing to guess a command form (fail-closed; mirrors ops deploy-instance.sh)."
  fi
  if printf '%s' "$probe_out" | grep -q 'Cinatra instance —'; then
    CAND_CLI_NS="instance"
    echo "    candidate CLI probe: namespaced surface (cinatra instance <cmd>)"
  elif printf '%s' "$probe_out" | grep -q 'Cinatra setup CLI'; then
    CAND_CLI_NS=""
    echo "    candidate CLI probe: legacy top-level surface (cinatra <cmd>)"
  else
    fail "candidate CLI surface probe returned an unrecognized banner — refusing to guess a command form (fail-closed)."
  fi
}

# Run a candidate-image CLI command against the run database, in-network (the
# same container shape as the ops schema-sync: env-file equivalents + image +
# forwarder). The detected namespace prefix is prepended; ${VAR:+$VAR} expands
# to NOTHING (not an empty argv word) on the legacy top-level surface.
cand_cli() {
  docker run --rm --network "$NET" --platform "$CANDIDATE_IMAGE_PLATFORM" \
    -e SUPABASE_DB_URL="$DB_URL_IN_NET" \
    -e SUPABASE_SCHEMA="$SCHEMA" \
    -e BETTER_AUTH_SECRET="$AUTH_SECRET" \
    -e BETTER_AUTH_URL="$APP_ORIGIN" \
    -e CINATRA_ENCRYPTION_KEY="$ENCRYPTION_KEY" \
    -e CINATRA_RUNTIME_MODE=production \
    "$CANDIDATE_IMAGE" node packages/cli/bin/cinatra.mjs ${CAND_CLI_NS:+$CAND_CLI_NS} "$@"
}

echo "==> upgrade-proof: prev_image=${PREV_IMAGE} (${PREV_IMAGE_PLATFORM}) schema=${SCHEMA}"
if [ -n "$CANDIDATE_IMAGE" ]; then
  echo "    candidate: IMAGE ${CANDIDATE_IMAGE} (${CANDIDATE_IMAGE_PLATFORM}) — release-proof mode (the image's own setup prod)"
else
  echo "    candidate: this checkout (bootstrap DDL + db migrate)"
fi

# ── 1. Infrastructure: isolated network + fresh Postgres ─────────────────────
# A host port is published so the CANDIDATE side (host-side node/tsx from this
# checkout) can reach the DB; port 0 lets docker pick a free one (no fixed-port
# collisions across parallel runs). The previous-release container reaches the
# DB by in-network DNS, never the host port.
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=postgres \
  postgres:18 >/dev/null

HOST_PORT="$(docker port "$PG" 5432/tcp | head -1 | sed -E 's/.*:([0-9]+)$/\1/')"
if [ -z "$HOST_PORT" ]; then
  fail "could not resolve the published host port for the run postgres."
fi
DB_URL_HOST="postgresql://postgres:postgres@127.0.0.1:${HOST_PORT}/postgres"

echo "==> waiting for postgres readiness (host port ${HOST_PORT})"
for i in $(seq 1 30); do
  if docker exec "$PG" pg_isready -U postgres -q 2>/dev/null; then break; fi
  if [ "$i" -eq 30 ]; then fail "postgres did not become ready within 60s."; fi
  sleep 2
done

# ── 2. PREVIOUS RELEASE: setup prod on the fresh DB ──────────────────────────
# One-shot `cinatra setup prod` from the previous-release image: provisions the
# OLD schema shape (incl. the `metadata` table — the freshness key) exactly as
# that release deployed. Asserting exit 0 proves the previous image still boots
# its setup against a current postgres:18 (the platform candidate major — the
# state the 17->18 cutover produces: the released app on an 18 server).
# Pick the provisioning entrypoint the previous release actually ships (see
# the cinatra#402 header note): 0.1.6+ images carry the published CLI and
# provision via `instance setup prod`; older images only have the legacy
# in-image bin with the top-level `setup prod`.
if docker run --rm --platform "$PREV_IMAGE_PLATFORM" --entrypoint node \
     "$PREV_IMAGE" -e 'require("fs").accessSync("node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs")' \
     >/dev/null 2>&1; then
  PREV_SETUP_CMD=(node node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs instance setup prod)
else
  PREV_SETUP_CMD=(node packages/cli/bin/cinatra.mjs setup prod)
fi
echo "==> [prev ${PREV_IMAGE}] cinatra setup prod (fresh database) via: ${PREV_SETUP_CMD[*]}"
docker run --rm --network "$NET" --platform "$PREV_IMAGE_PLATFORM" \
  -e SUPABASE_DB_URL="$DB_URL_IN_NET" \
  -e SUPABASE_SCHEMA="$SCHEMA" \
  -e BETTER_AUTH_SECRET="$AUTH_SECRET" \
  -e BETTER_AUTH_URL="$APP_ORIGIN" \
  -e CINATRA_ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  -e CINATRA_RUNTIME_MODE=production \
  "$PREV_IMAGE" "${PREV_SETUP_CMD[@]}"

# Sanity: the previous release must have created the `metadata` table. If it is
# absent the candidate chain would LEDGER-FAKE (fresh path) and the proof would
# be meaningless — fail loudly rather than silently prove nothing.
META_PRESENT="$(psql_q "SELECT to_regclass('${SCHEMA}.metadata') IS NOT NULL;")"
if [ "$META_PRESENT" != "t" ]; then
  fail "previous-release setup did not create ${SCHEMA}.metadata — the candidate chain would ledger-fake (fresh path) and prove nothing."
fi
echo "    previous-release schema provisioned (metadata present => upgrade path, not fresh path)"

# ── 3. SEED representative data-bearing rows ─────────────────────────────────
# notifications is (id, payload) on the previous release and the candidate
# upgrade only ALTERs it additively, so these rows MUST survive. (agent_templates
# is intentionally NOT used — see the header note on the placeholder rebuild.)
echo "==> seeding representative data-bearing rows (notifications)"
docker exec "$PG" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "
  INSERT INTO \"${SCHEMA}\".notifications (id, payload) VALUES
    ('upgrade-proof-seed-1', '{\"kind\":\"upgrade-proof-seed\",\"n\":1}'),
    ('upgrade-proof-seed-2', '{\"kind\":\"upgrade-proof-seed\",\"n\":2}'),
    ('upgrade-proof-seed-3', '{\"kind\":\"upgrade-proof-seed\",\"n\":3}');
" >/dev/null
SEED_COUNT="$(psql_q "SELECT count(*) FROM \"${SCHEMA}\".notifications WHERE id LIKE 'upgrade-proof-seed-%';")"
if [ "${SEED_COUNT:-0}" -ne 3 ]; then
  fail "expected 3 seeded notification rows, got '${SEED_COUNT}'."
fi
echo "    seeded ${SEED_COUNT} rows"

# ── 4. UPGRADE to the candidate ──────────────────────────────────────────────
# Snapshot the core__ ledger state BEFORE the candidate chain can run so we can
# prove the chain was APPLIED, not SKIPPED. Without this, a PREV_IMAGE that
# already carried the candidate core__ names in `pgmigrations` would make the
# candidate chain a no-op and the post-run ledger assertions would still pass —
# a false pass. node-pg-migrate creates `pgmigrations` lazily on its first run,
# so on the previous-release base the table may not exist yet — guard the
# snapshot so a missing ledger reads as zero core__ entries (the genuine
# "candidate migrations absent before" state) rather than erroring under
# `set -e`. (The snapshot sits ABOVE the mode branch: in checkout mode nothing
# before the migrate step writes the ledger, and in CANDIDATE_IMAGE mode the
# whole chain runs inside one `setup prod`, so it must precede section 4
# entirely.)
if [ "$(psql_q "SELECT to_regclass('${SCHEMA}.pgmigrations') IS NOT NULL;")" = "t" ]; then
  PRE_LEDGER_CORE="$(psql_q "SELECT name FROM \"${SCHEMA}\".pgmigrations WHERE name LIKE 'core__%' ORDER BY name;")"
else
  PRE_LEDGER_CORE=""
fi
echo "    pre-upgrade core__ ledger: $(printf '%s' "$PRE_LEDGER_CORE" | grep -c . || true) entr(y/ies)"

if [ -n "$CANDIDATE_IMAGE" ]; then
# CANDIDATE_IMAGE (release-proof) mode — run the image's OWN schema-sync, the
# exact prod deploy step (ops deploy-instance.sh, "Schema migrations using the
# NEW image"): probe the CLI surface fail-closed, then one `setup prod`
# through the deploy-compat forwarder against the EXISTING previous-release
# database. Whatever internal ordering the image's setup performs (bundled
# baseline, schema-bootstrap pass, versioned chain, ledger) runs exactly as
# prod would run it — an ordering defect INSIDE the image (the incident class
# this proof bars: the versioned chain executing before the bootstrap DDL on
# an existing database) fails HERE, before any release publish.
detect_candidate_cli_surface
echo "==> [candidate ${CANDIDATE_IMAGE}] image schema-sync: setup prod on the ${PREV_IMAGE} database"
cand_cli setup prod \
  || fail "candidate image schema-sync (setup prod) FAILED against the previous-release database — the exact prod-deploy failure this proof exists to bar."
else
# Checkout-candidate mode (the original harness behavior, unchanged).
# 4a. Candidate bootstrap DDL — the exact `ensureStoreSchema` boot pass
#     (buildCreateStoreSchemaQueries). Additive over the previous tables; adds
#     the new tables (installed_extension, extension_install_ops, …) the later
#     migrations operate on.
# Applied via the SHIPPED artifact: the self-contained schema-bootstrap bundle
# (scripts/build-schema-bootstrap-bundle.mjs → scripts/schema-bootstrap.bundle.mjs)
# that the runtime image bakes and the deploy-compat CLI entry
# (packages/cli/bin/cinatra.mjs) runs before `setup prod` on a prod deploy.
# Building + running the bundle here (instead of a tsx pass over the TS source,
# formerly scripts/ci/lib/apply-candidate-bootstrap-ddl.mjs) makes this proof
# exercise the exact bootstrap-before-chain vehicle production uses on an
# EXISTING database at the previous release's ledger — the cinatra#1136
# prod-deploy failure class (core migration `LOCK TABLE nango_connection` →
# relation does not exist, when the chain ran without the candidate baseline).
echo "==> [candidate] build the image schema-bootstrap bundle"
node scripts/build-schema-bootstrap-bundle.mjs \
  || fail "schema-bootstrap bundle build failed (esbuild from the checkout devDependencies)."
echo "==> [candidate] apply bootstrap DDL via the bundle (buildCreateStoreSchemaQueries)"
SUPABASE_DB_URL="$DB_URL_HOST" SUPABASE_SCHEMA="$SCHEMA" \
  node scripts/schema-bootstrap.bundle.mjs \
  || fail "candidate bootstrap DDL (image bundle) failed against the upgraded database."

# 4b. Candidate core migration chain — the SAME runner production uses
#     (`db migrate` always EXECUTES; it never ledger-fakes — only `setup`
#     fakes, and only on a fresh schema). The pre-chain core__ ledger snapshot
#     (PRE_LEDGER_CORE) now sits ABOVE the mode branch — see the section 4
#     header.
echo "==> [candidate] run core migration chain (cinatra db migrate)"
MIGRATE_OUT="$(SUPABASE_DB_URL="$DB_URL_HOST" SUPABASE_SCHEMA="$SCHEMA" \
  node node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs instance db migrate 2>&1)" \
  || { printf '%s\n' "$MIGRATE_OUT"; fail "candidate core migration chain failed against the upgraded database."; }
printf '%s\n' "$MIGRATE_OUT"

# The first run MUST report applying at least one migration ("applied N — …").
# An "up to date"/"applied 0" first run means the candidate chain was SKIPPED
# (e.g. a pre-marked ledger) — the proof would otherwise vacuously pass.
APPLIED_N="$(printf '%s' "$MIGRATE_OUT" | sed -nE 's/.*: applied ([0-9]+) .*/\1/p' | tail -1)"
if [ -z "$APPLIED_N" ] || [ "$APPLIED_N" -lt 1 ]; then
  fail "candidate first migrate did NOT report applying ≥1 migration (got '${APPLIED_N:-<none>}') — the chain was skipped (pre-marked ledger?), so the proof would falsely pass. Output was: ${MIGRATE_OUT}"
fi
echo "    first migrate reported applied ${APPLIED_N} migration(s) (chain EXECUTED, not skipped)"
fi

# ── 5a. MIGRATION-LEDGER INTEGRITY ───────────────────────────────────────────
# The set of core migrations the candidate SHIPS — and the runner actually
# EXECUTES — is the set of runner modules in migrations/core/ (the runner
# applies every core__NNNN_*.mjs there; the legacy 0001/0002 psql artifacts are
# re-expressed 1:1 as core__0001_/core__0002_ modules, so the ledger always
# carries the core__ runner name for every migration). The ledger name == the
# module filename sans .mjs. Every shipped module must be in the ledger with a
# non-null run_on; the core ledger count must equal it; ledger ids must be
# distinct. We cross-check the module set against migrations/manifest.json so a
# module shipped without a manifest entry (or vice-versa) is caught too.
echo "==> assert: migration-ledger integrity"
EXPECTED_CORE_JS='
  const fs = require("fs");
  // The runner-executed set: every core__NNNN_*.mjs runner module.
  const modules = fs.readdirSync("migrations/core")
    .filter((f) => /^core__\d{4}_[a-z0-9-]+\.mjs$/.test(f))
    .map((f) => f.replace(/\.mjs$/, ""))
    .sort();
  // Cross-check: the manifest must describe the same NNNN sequence set.
  const m = JSON.parse(fs.readFileSync("migrations/manifest.json", "utf8"));
  const manifestSeqs = new Set(m.migrations.map((e) => String(e.seq)));
  const moduleSeqs = modules.map((n) => n.match(/^core__(\d{4})_/)[1]);
  for (const seq of moduleSeqs) {
    if (!manifestSeqs.has(seq)) {
      console.error(`module seq ${seq} has no migrations/manifest.json entry`);
      process.exit(3);
    }
  }
  if (manifestSeqs.size !== moduleSeqs.length) {
    console.error(`manifest entry count ${manifestSeqs.size} != core module count ${moduleSeqs.length}`);
    process.exit(3);
  }
  console.log(modules.join("\n"));
'
if [ -n "$CANDIDATE_IMAGE" ]; then
  # The candidate's shipped migration set is read from INSIDE THE IMAGE
  # (WORKDIR /app carries migrations/ + manifest.json), not from the checkout:
  # the image is the artifact under proof, and any image/checkout drift must
  # be judged on the image side.
  EXPECTED_CORE="$(docker run --rm --platform "$CANDIDATE_IMAGE_PLATFORM" \
    "$CANDIDATE_IMAGE" node -e "$EXPECTED_CORE_JS")"
else
  EXPECTED_CORE="$(node -e "$EXPECTED_CORE_JS")"
fi
EXPECTED_COUNT="$(printf '%s\n' "$EXPECTED_CORE" | grep -c . || true)"
LEDGER_CORE="$(psql_q "SELECT name FROM \"${SCHEMA}\".pgmigrations WHERE name LIKE 'core__%' AND run_on IS NOT NULL ORDER BY name;")"
LEDGER_COUNT="$(psql_q "SELECT count(*) FROM \"${SCHEMA}\".pgmigrations WHERE name LIKE 'core__%';")"
NULL_RUNON="$(psql_q "SELECT count(*) FROM \"${SCHEMA}\".pgmigrations WHERE run_on IS NULL;")"
DISTINCT_IDS="$(psql_q "SELECT (count(DISTINCT id) = count(*)) FROM \"${SCHEMA}\".pgmigrations;")"

if [ "$EXPECTED_CORE" != "$LEDGER_CORE" ]; then
  echo "--- expected (manifest core__):"; printf '%s\n' "$EXPECTED_CORE"
  echo "--- ledger (run_on not null):";   printf '%s\n' "$LEDGER_CORE"
  fail "ledger core__ set != the candidate's declared core migrations (manifest.json)."
fi
if [ "${LEDGER_COUNT:-0}" -ne "${EXPECTED_COUNT:-0}" ]; then
  fail "ledger core__ count ${LEDGER_COUNT} != expected ${EXPECTED_COUNT}."
fi
if [ "${NULL_RUNON:-1}" -ne 0 ]; then
  fail "ledger has ${NULL_RUNON} rows with a null run_on (an unrecorded/partial apply)."
fi
if [ "$DISTINCT_IDS" != "t" ]; then
  fail "ledger ids are not strictly distinct (a double-apply)."
fi

# APPLIED-NOT-SKIPPED: at least one expected candidate core__NNNN migration must
# have been ABSENT from the ledger BEFORE the candidate migrate and PRESENT
# after. This is the structural complement to the "applied ≥1" output check: it
# proves, against the ledger itself, that the candidate chain genuinely advanced
# the PREV_IMAGE base (which lacks the candidate migrations) rather than finding
# them pre-marked and skipping.
# How many candidate migrations are NEW relative to this base (absent from the
# pre-upgrade ledger)? In CANDIDATE_IMAGE mode a release that ships ZERO new
# core migrations over a base is legitimate (the release barrier proves the
# candidate against the most recent published releases, and a release may add
# no core migration): applied-not-skipped is then NOT APPLICABLE, not a
# failure — integrity, data preservation and idempotency still assert. In
# checkout mode the earlier "applied >= 1" stdout assertion already made that
# state unreachable; its semantics are unchanged.
NEW_EXPECTED_COUNT=0
while IFS= read -r expected; do
  [ -n "$expected" ] || continue
  if ! printf '%s\n' "$PRE_LEDGER_CORE" | grep -qxF "$expected"; then
    NEW_EXPECTED_COUNT=$((NEW_EXPECTED_COUNT + 1))
  fi
done <<< "$EXPECTED_CORE"

ABSENT_THEN_APPLIED=""
while IFS= read -r expected; do
  [ -n "$expected" ] || continue
  # absent before?
  if ! printf '%s\n' "$PRE_LEDGER_CORE" | grep -qxF "$expected"; then
    # present after?
    if printf '%s\n' "$LEDGER_CORE" | grep -qxF "$expected"; then
      ABSENT_THEN_APPLIED="$expected"
      break
    fi
  fi
done <<< "$EXPECTED_CORE"
if [ -n "$ABSENT_THEN_APPLIED" ]; then
  echo "    applied-not-skipped OK — '${ABSENT_THEN_APPLIED}' was ABSENT before the candidate upgrade and PRESENT after (chain advanced the ${PREV_IMAGE} base)"
elif [ -n "$CANDIDATE_IMAGE" ] && [ "$NEW_EXPECTED_COUNT" -eq 0 ]; then
  echo "    applied-not-skipped: not applicable — every candidate core__ migration already sat in the ${PREV_IMAGE} ledger (this candidate ships no new core migration over that base)"
else
  echo "--- pre-migrate ledger core__:"; printf '%s\n' "$PRE_LEDGER_CORE"
  echo "--- post-migrate ledger core__:"; printf '%s\n' "$LEDGER_CORE"
  echo "--- expected candidate core__:"; printf '%s\n' "$EXPECTED_CORE"
  fail "no expected candidate core__ migration was ABSENT-before-and-PRESENT-after — the chain was skipped (ledger pre-marked?), so applied-not-skipped is unproven."
fi
echo "    ledger OK — all ${EXPECTED_COUNT} candidate core__ migrations applied, no nulls, distinct ids"

# ── 5b. DATA PRESERVATION ────────────────────────────────────────────────────
# Byte-verify ALL THREE seeded rows, not just seed-1: read back the exact sorted
# (id, payload) set and compare it character-for-character to the expected
# literals. A drop, reorder, payload mutation, or partial-loss of rows 2/3 would
# change this string and fail the assertion. notifications.payload is a `text`
# column (see drizzle-store.ts; the upgrade only ALTERs it additively), so the
# stored value is byte-for-byte what was inserted — the EXPECTED literals are
# the exact inserted JSON strings.
echo "==> assert: data preservation (all 3 seeded rows survive byte-identical)"
SURVIVED="$(psql_q "SELECT count(*) FROM \"${SCHEMA}\".notifications WHERE id LIKE 'upgrade-proof-seed-%';")"
if [ "${SURVIVED:-0}" -ne 3 ]; then
  fail "data NOT preserved — expected 3 seeded notification rows after upgrade, found '${SURVIVED}'."
fi
PRESERVED_SET="$(psql_q "SELECT id || '=' || payload FROM \"${SCHEMA}\".notifications WHERE id LIKE 'upgrade-proof-seed-%' ORDER BY id;")"
EXPECTED_SET="$(printf '%s\n' \
  'upgrade-proof-seed-1={"kind":"upgrade-proof-seed","n":1}' \
  'upgrade-proof-seed-2={"kind":"upgrade-proof-seed","n":2}' \
  'upgrade-proof-seed-3={"kind":"upgrade-proof-seed","n":3}')"
if [ "$PRESERVED_SET" != "$EXPECTED_SET" ]; then
  echo "--- expected (id=payload, sorted):"; printf '%s\n' "$EXPECTED_SET"
  echo "--- preserved (id=payload, sorted):"; printf '%s\n' "$PRESERVED_SET"
  fail "data NOT preserved byte-identical — the upgrade altered/dropped/reordered a seeded row's (id, payload)."
fi
echo "    data preserved — 3/3 seeded rows survive, every (id, payload) byte-identical"

# ── 5c. IDEMPOTENCY ──────────────────────────────────────────────────────────
if [ -n "$CANDIDATE_IMAGE" ]; then
  # Prod re-runs the SAME image schema-sync on EVERY deploy (ops
  # deploy-instance.sh), so the image-mode re-run contract is `setup prod`
  # itself exiting 0 again on the already-upgraded database, plus the runner
  # reporting a no-op chain.
  echo "==> assert: re-running the candidate image schema-sync is clean (the every-deploy re-run) and the chain is a no-op"
  RESETUP_OUT="$(cand_cli setup prod 2>&1)" \
    || { printf '%s\n' "$RESETUP_OUT"; fail "re-running the candidate image's setup prod FAILED on the already-upgraded database — every prod deploy re-runs exactly this."; }
  REMIGRATE_OUT="$(cand_cli db migrate 2>&1)" \
    || { printf '%s\n' "$REMIGRATE_OUT"; fail "candidate image db migrate FAILED on the already-upgraded database."; }
else
echo "==> assert: re-running the candidate chain is a no-op"
REMIGRATE_OUT="$(SUPABASE_DB_URL="$DB_URL_HOST" SUPABASE_SCHEMA="$SCHEMA" \
  node node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs instance db migrate 2>&1)"
fi
printf '%s\n' "$REMIGRATE_OUT" | tail -2
if ! printf '%s' "$REMIGRATE_OUT" | grep -qiE 'No migrations to run|up to date'; then
  fail "re-running the migration chain was NOT a no-op — idempotency broken."
fi
echo "    idempotent — second run applied nothing"

echo "==> upgrade-proof PASSED: a ${PREV_IMAGE} database with real rows upgraded to the candidate — ledger consistent (all core__ applied), seeded data preserved, chain idempotent."
