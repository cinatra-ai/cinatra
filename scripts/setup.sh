#!/usr/bin/env bash
set -euo pipefail

# Cinatra — Local Setup
# Usage: bash scripts/setup.sh
#
# Non-interactive overrides (useful for CI / scripted installs):
#   MODE=dev|prod   bash scripts/setup.sh   # skip the dev/prod prompt
#   MODE=demo       bash scripts/setup.sh   # demo overlay: dev + the four app
#                                           #   profiles + demo profile + seed
#   SEED=1|0        bash scripts/setup.sh   # skip the sample-data prompt
#   YES=1           bash scripts/setup.sh   # accept all defaults (MODE=dev, SEED=0)
#   NO_WAYFLOW=1    bash scripts/setup.sh   # do not start the WayFlow agent runtime

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[x]${NC} $1"; exit 1; }
prompt() { echo -en "${YELLOW}[?]${NC} $1"; }

# ── Prerequisites ─────────────────────────────────────────────────────────────

info "Checking prerequisites..."

command -v node >/dev/null 2>&1 || error "Node.js is not installed. Install Node.js 24.x first."
command -v pnpm >/dev/null 2>&1 || error "pnpm is not installed. Run: npm install -g pnpm"
command -v docker >/dev/null 2>&1 || error "Docker is not installed. Install Docker Desktop first."

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 24 ]; then
  # Hard requirement: the Better Auth bootstrap migration
  # (scripts/better-auth-migrate.mts) runs under plain Node and relies on
  # native TypeScript type-stripping, which is only on by default in Node
  # >= 22.18 / >= 23.6. Cinatra standardizes on Node 24.x.
  error "Node.js $NODE_VERSION detected. Cinatra requires Node.js 24.x or newer."
fi

info "Prerequisites OK."

# ── Mode selection (development or production) ───────────────────────────────

# Resolve mode in priority order:
#  1. MODE env var (CI override)
#  2. CINATRA_RUNTIME_MODE inside an existing .env.local
#  3. Interactive prompt on a TTY
#  4. Default to dev (non-interactive shells without an env override)

normalize_mode() {
  # Lowercase via tr (not bash 4 `${1,,}`) so this runs on stock macOS bash 3.2.
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    d|dev|development) echo "development" ;;
    p|prod|production) echo "production" ;;
    *) echo "" ;;
  esac
}

# ── Demo overlay (cinatra#1238) ──────────────────────────────────────────────
# `MODE=demo` is a strict SUPERSET of a dev install: the DEVELOPMENT runtime
# (`CINATRA_RUNTIME_MODE=development`) PLUS the orthogonal demo install profile
# (`CINATRA_INSTALL_PROFILE=demo`) — which brings up the four bundled app
# profiles (wordpress, drupal, twenty, plane), forces the sample-data seed, and
# activates the demo dev-fixtures + the lazy monolithic ACME seed at app boot.
# It is DELIBERATELY not a third runtime mode (that would flip the dozens of
# `RUNTIME_MODE === "development"` checks); the profile is an independent axis.
#
# Detected here, BEFORE mode normalization (which would reject "demo"): a demo
# request is rewritten to a dev-mode install carrying the demo profile. A re-run
# also stays demo when the existing .env.local already pins it.
DEMO=0
INSTALL_PROFILE="dev"
if [ "$(printf '%s' "${MODE:-}" | tr '[:upper:]' '[:lower:]')" = "demo" ]; then
  DEMO=1
  INSTALL_PROFILE="demo"
  MODE="dev"   # downstream mode resolution treats demo as a development install
  info "Demo overlay requested (MODE=demo): development runtime + demo profile + the four bundled app profiles + forced sample seed."
elif [ -z "${MODE:-}" ] && [ -f .env.local ] && grep -q '^CINATRA_INSTALL_PROFILE=demo$' .env.local; then
  DEMO=1
  INSTALL_PROFILE="demo"
  info "Existing .env.local pins CINATRA_INSTALL_PROFILE=demo — keeping the demo overlay on this run."
fi

# ── WayFlow agent runtime (cinatra#2654) ─────────────────────────────────────
# This script OWNS the local compose stack it starts, so it starts the WayFlow
# agent runtime with it. Before, the runtime was profile-gated and no setup path
# activated the profile: a fresh install had nothing on :3010 and every agent run
# died with ECONNREFUSED. The compose profile stays exactly where it is and
# remains the opt-out mechanism; this script simply activates it by default.
# `NO_WAYFLOW=1` is the opt-out, for a deliberately lean install.
WAYFLOW=1
WAYFLOW_RUNTIME_MODE="local"
if [ "${NO_WAYFLOW:-}" = "1" ]; then
  WAYFLOW=0
  WAYFLOW_RUNTIME_MODE="off"
  warn "NO_WAYFLOW=1 — the WayFlow agent runtime will NOT be started. Agent runs fail until you start it."
fi

RESOLVED_MODE=""

if [ -n "${MODE:-}" ]; then
  RESOLVED_MODE=$(normalize_mode "$MODE")
  [ -n "$RESOLVED_MODE" ] || error "MODE='$MODE' is not valid. Use dev or prod."
  info "Mode: $RESOLVED_MODE (from MODE env)"
elif [ -f .env.local ] && grep -q '^CINATRA_RUNTIME_MODE=' .env.local; then
  EXISTING_MODE=$(grep '^CINATRA_RUNTIME_MODE=' .env.local | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  RESOLVED_MODE=$(normalize_mode "$EXISTING_MODE")
  [ -n "$RESOLVED_MODE" ] || RESOLVED_MODE="development"
  info "Mode: $RESOLVED_MODE (from existing .env.local)"
elif [ "${YES:-}" = "1" ]; then
  RESOLVED_MODE="development"
  info "Mode: development (YES=1 default)"
elif [ -t 0 ]; then
  prompt "Install for development or production? [dev/prod] (default: dev): "
  read -r MODE_ANSWER
  RESOLVED_MODE=$(normalize_mode "${MODE_ANSWER:-dev}")
  [ -n "$RESOLVED_MODE" ] || error "Invalid choice '$MODE_ANSWER'. Use dev or prod."
else
  RESOLVED_MODE="development"
  warn "Non-interactive shell — defaulting mode to development. Set MODE=prod to override."
fi

# ── Environment file ──────────────────────────────────────────────────────────

if [ ! -f .env.local ]; then
  info "Creating .env.local from .env.example..."
  cp .env.example .env.local

  # Generate a random auth secret.
  SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p -c 64 | head -1)
  # Generate the WayFlow bridge shared secret. The wayflow container
  # authenticates EVERY callback to /api/llm-bridge with this value
  # (X-Cinatra-Bridge-Token); when it is empty the bridge returns 403, the
  # agent produces no text, and the interactive widget content-edit surfaces
  # "(no response)". .env.example ships it COMMENTED (`# CINATRA_BRIDGE_TOKEN=`),
  # so a fresh dev env would otherwise have no token and `npm run services`
  # (which now hard-fails on a missing token via gen-wayflow-env.mjs
  # --require-bridge-token) would abort. Mint it here, like BETTER_AUTH_SECRET.
  BRIDGE_TOKEN=$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32 | head -1)
  # #907: the dedicated per-node context-callback signing key. The wayflow
  # runtime signs an HMAC attestation with it on /api/context-resolve +
  # /api/context-finalize calls so the app can bind the callback to the
  # actually-executing composed child (a composed child cannot resolve a
  # sibling's slot). DISTINCT from CINATRA_BRIDGE_TOKEN by design. The app fails
  # CLOSED on the composed-child path when it is missing, so mint it here too.
  ATTEST_KEY=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p -c 64 | head -1)
  # Replace by KEY, not by placeholder text: .env.example ships an empty
  # `BETTER_AUTH_SECRET=` line (no placeholder), so the old
  # `s/replace-with-a-random-32-byte-hex-secret/.../` substitution was a no-op
  # and left the secret blank — `setup:dev` then aborts with "Missing
  # BETTER_AUTH_SECRET". Anchoring on the key works whether the value is empty
  # or a placeholder. The bridge token line ships COMMENTED, so its substitution
  # anchors on the commented form and rewrites it to an active assignment.
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$SECRET|" .env.local
    sed -i '' "s/^CINATRA_RUNTIME_MODE=.*/CINATRA_RUNTIME_MODE=$RESOLVED_MODE/" .env.local
    sed -i '' "s|^# *CINATRA_BRIDGE_TOKEN=.*|CINATRA_BRIDGE_TOKEN=$BRIDGE_TOKEN|" .env.local
    sed -i '' "s|^# *CINATRA_CONTEXT_ATTEST_KEY=.*|CINATRA_CONTEXT_ATTEST_KEY=$ATTEST_KEY|" .env.local
  else
    sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$SECRET|" .env.local
    sed -i "s/^CINATRA_RUNTIME_MODE=.*/CINATRA_RUNTIME_MODE=$RESOLVED_MODE/" .env.local
    sed -i "s|^# *CINATRA_BRIDGE_TOKEN=.*|CINATRA_BRIDGE_TOKEN=$BRIDGE_TOKEN|" .env.local
    sed -i "s|^# *CINATRA_CONTEXT_ATTEST_KEY=.*|CINATRA_CONTEXT_ATTEST_KEY=$ATTEST_KEY|" .env.local
  fi
  # Append-if-missing fallback: .env.example may not ship a commented
  # `# CINATRA_CONTEXT_ATTEST_KEY=` line (the sed above is then a no-op), so
  # guarantee the key exists in a fresh .env.local. Idempotent.
  if ! grep -q '^CINATRA_CONTEXT_ATTEST_KEY=' .env.local; then
    printf '\n# Per-node context-callback signing key (#907). Distinct from CINATRA_BRIDGE_TOKEN.\nCINATRA_CONTEXT_ATTEST_KEY=%s\n' "$ATTEST_KEY" >> .env.local
  fi
  info ".env.local created with a random BETTER_AUTH_SECRET, CINATRA_BRIDGE_TOKEN, CINATRA_CONTEXT_ATTEST_KEY, and CINATRA_RUNTIME_MODE=$RESOLVED_MODE."
else
  # If the user picked a mode that differs from what's in .env.local, refuse
  # to silently mutate the file — surface the conflict so they can resolve it.
  CURRENT_MODE=$(grep '^CINATRA_RUNTIME_MODE=' .env.local | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)
  CURRENT_MODE_NORMALIZED=$(normalize_mode "${CURRENT_MODE:-development}")
  if [ -n "$CURRENT_MODE_NORMALIZED" ] && [ "$CURRENT_MODE_NORMALIZED" != "$RESOLVED_MODE" ]; then
    error ".env.local has CINATRA_RUNTIME_MODE=$CURRENT_MODE_NORMALIZED but you selected $RESOLVED_MODE. Update or delete .env.local and re-run."
  fi
  info ".env.local already exists ($RESOLVED_MODE), skipping."
fi

# ── Install profile (cinatra#1238) ───────────────────────────────────────────
# Upsert CINATRA_INSTALL_PROFILE to match this run (demo or dev). ALWAYS written
# — a plain dev/prod re-run NORMALIZES the profile back to `dev` so a prior
# `MODE=demo` .env.local never leaks a demo overlay (extra app profiles, forced
# seed, the lazy ACME seed) into a subsequent plain reconcile. Idempotent:
# rewrite-if-present, append-if-absent (.env.example may not ship the key).
if grep -q '^CINATRA_INSTALL_PROFILE=' .env.local; then
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "s|^CINATRA_INSTALL_PROFILE=.*|CINATRA_INSTALL_PROFILE=$INSTALL_PROFILE|" .env.local
  else
    sed -i "s|^CINATRA_INSTALL_PROFILE=.*|CINATRA_INSTALL_PROFILE=$INSTALL_PROFILE|" .env.local
  fi
else
  printf '\n# Install profile (cinatra#1238): dev | demo. demo = dev + bundled apps + seed.\nCINATRA_INSTALL_PROFILE=%s\n' "$INSTALL_PROFILE" >> .env.local
fi
info "Install profile: $INSTALL_PROFILE (CINATRA_INSTALL_PROFILE=$INSTALL_PROFILE)."

# ── WayFlow runtime decision (cinatra#2654) ──────────────────────────────────
# Record what THIS run decided, the same key `cinatra install` writes, so
# `cinatra doctor` can tell a deliberate opt-out apart from a runtime that
# should be up and is not. Idempotent: rewrite-if-present, append-if-absent.
if grep -q '^CINATRA_WAYFLOW_RUNTIME=' .env.local; then
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "s|^CINATRA_WAYFLOW_RUNTIME=.*|CINATRA_WAYFLOW_RUNTIME=$WAYFLOW_RUNTIME_MODE|" .env.local
  else
    sed -i "s|^CINATRA_WAYFLOW_RUNTIME=.*|CINATRA_WAYFLOW_RUNTIME=$WAYFLOW_RUNTIME_MODE|" .env.local
  fi
else
  printf '\n# WayFlow agent runtime for this install (cinatra#2654): local | off | external.\nCINATRA_WAYFLOW_RUNTIME=%s\n' "$WAYFLOW_RUNTIME_MODE" >> .env.local
fi

# ── WayFlow bridge-token env (cinatra#2075, #2654) ───────────────────────────
# The shared `wayflow` agent-runtime container authenticates every callback to
# /api/llm-bridge with CINATRA_BRIDGE_TOKEN, which it reads from the NARROW
# generated file docker/wayflow/.wayflow.env (its `env_file`, `required:
# false`). Generate it on EVERY install (not only demo), from the per-install
# random token minted into .env.local above — never a shared constant, never
# printed. `--require-bridge-token` turns a missing token into a loud,
# actionable failure instead of a silent 403.
#
# This runs BEFORE the bring-up now: the runtime starts WITH the stack, so the
# file has to be correct by then. Generating it afterwards (the old order) meant
# the very first start read no token and agent_loader.py crash-looped.
info "Provisioning the WayFlow bridge-token env (docker/wayflow/.wayflow.env) from .env.local..."
node scripts/gen-wayflow-env.mjs --require-bridge-token

# ── Docker infrastructure ─────────────────────────────────────────────────────

# scripts/dev-compose-env.mjs is the ONE step that resolves this checkout's
# compose project and host ports (cinatra#2839). It runs HERE, before the first
# compose invocation of this section, because `make setup` is a WHOLE-STACK
# entry point exactly like `make dev` and `pnpm services`: without it, setup
# ignored a lane's COMPOSE_PROJECT_NAME (compose fell back to the
# directory-derived project), published the four historical default ports, and
# bypassed every refusal this branch added — a missing service URL, a companion
# port that overflows, an unusable ambient override, a stand-down.
#
# ASSIGN, then eval — and NOT as one `&&` chain. This script runs under `set -e`,
# and errexit deliberately EXEMPTS a command that is part of an `&&` list, so
# `ASSIGN && eval && docker compose up` would skip the `up` on a refusal and then
# carry on with the REST of setup — the health waits, the app setup, the graphiti
# recreate, "Setup complete!" — as if nothing had happened. A refusal has to stop
# the script, so the assignment stands alone with an explicit `|| error`.
#
# --require-manageable is what makes the stand-down real here: this is a
# whole-stack `up`, which has no way to leave out a service whose URL says it is
# configured elsewhere, so for a named lane the step refuses rather than letting
# compose publish that service on the shared default.
#
# PROPAGATION: `eval` of the step's `export` lines puts COMPOSE_PROJECT_NAME and
# the CINATRA_*_HOST_PORT values into THIS shell, so every later `docker compose`
# in this file inherits them as a child process — the wayflow build and the
# `up -d` below, the `docker compose exec` health waits, the demo `--profile
# plane`/`plane-mcp` bring-ups, and the graphiti recreate near the end. This
# script never `cd`s and runs no compose inside a subshell or a function, so
# there is no invocation the exports miss.
#
# SCOPE LIMIT, stated plainly (cinatra#2845/#2849): only nango-server,
# nango-connect, nango-db and redis are parameterized. A second lane running this
# script still collides on the stack's other fixed host ports — wayflow 3010,
# verdaccio 4873, postgres 5434, neo4j, graphiti. Two-lane whole-stack setup is
# not supported yet.
info "Resolving this checkout's compose project and host ports..."
CINATRA_COMPOSE_ENV="$(node scripts/dev-compose-env.mjs --require-manageable)" \
  || error "Refusing to bring the stack up on ports this checkout does not own (see the [dev-compose-env] lines above). Setup stopped BEFORE starting anything, rather than publishing the shared defaults under a name that is not this lane's. Fix the reported variable in .env.local and re-run \`bash scripts/setup.sh\` (it reconciles in place)."
eval "$CINATRA_COMPOSE_ENV"

# cinatra#2654: the WayFlow agent runtime comes up WITH the stack. Its image
# builds from ./docker/wayflow (there is no registry image), so build it as its
# OWN step first: a broken build then fails setup by name and stays cheap to
# retry, instead of surfacing as a generic `up` error after everything else
# already started.
COMPOSE_PROFILE_ARGS=""
WAYFLOW_LABEL=""
if [ "$WAYFLOW" = "1" ]; then
  COMPOSE_PROFILE_ARGS="--profile wayflow"
  WAYFLOW_LABEL=" + the WayFlow agent runtime"
  info "Building the WayFlow agent-runtime image (first build is slow; later runs hit the layer cache)..."
  docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile wayflow build wayflow \
    || error "The WayFlow agent-runtime image failed to build. Setup stopped here rather than reporting a ready install whose agent runs would all fail. Fix the build error and re-run \`bash scripts/setup.sh\` (it reconciles in place), or re-run with NO_WAYFLOW=1 to set up without the agent runtime."
fi

info "Starting infrastructure (Postgres + Redis$WAYFLOW_LABEL)..."
# COMPOSE_PROFILE_ARGS is empty or the deliberate `--profile wayflow` flag pair,
# so the word split below is intended.
#
# `env -u …` STRIPS every provider variable the graphiti service declares
# value-less (cinatra#2582). A value-less entry means "take it from the
# environment of the compose process", so a stray `OPENAI_API_KEY` in this
# shell would otherwise start the knowledge-graph indexer on a key the app's
# own resolver never approved — the wrong vendor on an Anthropic install, or a
# key the operator disconnected. This whole-stack `up` therefore starts the
# indexer KEYLESS by construction, and `npm run kg:up` below is the one step
# that gives it the key the app actually stored. The list is
# `GRAPHITI_GENERATED_NAMES` in scripts/gen-graphiti-env.mjs, and a suite
# asserts every entry point strips exactly it.
# shellcheck disable=SC2086
env -u LLM__PROVIDER -u LLM__PROVIDERS__OPENAI__API_KEY -u LLM__PROVIDERS__OPENAI__API_URL -u LLM__PROVIDERS__ANTHROPIC__API_KEY -u EMBEDDER__PROVIDER -u EMBEDDER__MODEL -u EMBEDDER__DIMENSIONS -u EMBEDDER__PROVIDERS__OPENAI__API_URL -u EMBEDDER__PROVIDERS__OPENAI__API_KEY -u OPENAI_API_KEY docker compose -f docker-compose.yml -f docker-compose.dev.yml $COMPOSE_PROFILE_ARGS up -d

info "Waiting for Postgres to be ready..."
until docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do
  sleep 1
done
info "Postgres is ready."

info "Waiting for Redis to be ready..."
until docker compose exec -T redis redis-cli ping >/dev/null 2>&1; do
  sleep 1
done
info "Redis is ready."

info "Waiting for Nango to be ready..."
until curl -sf "http://127.0.0.1:${CINATRA_NANGO_SERVER_HOST_PORT:-3003}/health" >/dev/null 2>&1; do
  sleep 2
done
info "Nango is ready."

# ── WayFlow runtime readiness (cinatra#2654) ─────────────────────────────────
# The loader mounts every installed agent on a cold start, so the compose
# healthcheck allows it ~2 minutes. Wait for it here, BOUNDED and NON-FATAL: a
# still-mounting loader is "check again in a minute", not a failed setup.
if [ "$WAYFLOW" = "1" ]; then
  info "Waiting for the WayFlow agent runtime to report healthy..."
  WAYFLOW_DEADLINE=$(( $(date +%s) + 180 ))
  until curl -sf http://127.0.0.1:3010/.health >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$WAYFLOW_DEADLINE" ]; then
      warn "The WayFlow agent runtime is not answering yet. It mounts every installed agent on a cold start. Check \`docker compose logs wayflow\` if agent runs keep failing."
      break
    fi
    sleep 3
  done
  if curl -sf http://127.0.0.1:3010/.health >/dev/null 2>&1; then
    info "WayFlow agent runtime is ready (http://localhost:3010)."
  fi
fi

# ── Demo app profiles (cinatra#1238) ─────────────────────────────────────────
# On a demo install, bring up the four bundled app profiles and wait for each to
# answer. Their connectors' dev-auto-setup hooks converge a live connection to
# each at app boot (dev-auto-setup.ts), so the apps must be reachable BEFORE the
# first `pnpm dev`. Health-wait is BOUNDED and NON-FATAL: a slow/failed app
# warns but never aborts setup — the boot-time hooks are idempotent and re-wire
# on the next boot once the container is healthy. WordPress + Drupal seed their
# own demo content from their entrypoints; Twenty + Plane content is seeded from
# the app-side demo path once their connections converge.
if [ "$DEMO" = "1" ]; then
  # The `wordpress` + `drupal` profiles below ALSO bring up the shared `wayflow`
  # runtime container (docker-compose.yml: the wayflow service declares
  # `profiles: [wayflow, drupal, wordpress]`); its bridge-token env file was
  # generated above. That membership is why NO_WAYFLOW=1 cannot hold on a demo
  # install: say so rather than let the operator believe an opt-out that the CMS
  # profiles override.
  if [ "$WAYFLOW" = "0" ]; then
    warn "NO_WAYFLOW=1 does not apply to a demo install: the wordpress and drupal profiles include the shared WayFlow runtime, so it starts anyway."
  fi
  info "Bringing up the four demo app profiles (wordpress, drupal, twenty, plane)..."
  docker compose -f docker-compose.yml -f docker-compose.dev.yml \
    --profile wordpress --profile drupal --profile twenty --profile plane up -d

  # Bounded HTTP health-wait. $1=label $2=url $3=timeout-seconds.
  wait_for_app() {
    _label="$1"; _url="$2"; _deadline=$(( $(date +%s) + ${3:-300} ))
    info "Waiting for $_label ($_url)..."
    until curl -sf -o /dev/null --max-time 5 "$_url"; do
      if [ "$(date +%s)" -ge "$_deadline" ]; then
        warn "$_label did not answer within ${3:-300}s — continuing. Its connection re-wires on the next \`pnpm dev\` boot once it is healthy."
        return 0
      fi
      sleep 3
    done
    info "$_label is ready."
  }
  wait_for_app "WordPress" "http://localhost:8080/wp-json/" 300
  wait_for_app "Drupal"    "http://localhost:8082/"         300
  wait_for_app "Twenty"    "http://localhost:3300/healthz"  300
  wait_for_app "Plane"     "http://localhost:3400/api/instances/" 420

  # ── Plane automatic connect (cinatra#1238; owner ruling 2026-07-23 (groganz)) ──
  # Plane has no headless CLI mint, so — unlike Twenty — its dev auto-connect
  # can't just `docker exec` a keygen. Provision a dev/demo PAT over Plane's CSRF
  # sign-in sequence (version-pinned to Plane CE 1.3.1, reuse-first, loopback +
  # reserved-TLD creds — NOT secrets), then bring up the official Plane MCP bridge
  # (makeplane/plane-mcp-server via mcp-proxy) holding that PAT. The provision
  # script writes the bridge env + PLANE_MCP_URL (+ the connector's demo admin
  # creds) into .env.local, so the connector's dev-setup hook auto-connects the
  # connector config AND wires the MCP row at the first `pnpm dev`. NON-FATAL:
  # a not-ready/unsupported Plane warns and continues (re-attempted next boot).
  info "Provisioning Plane (headless dev/demo PAT mint; version-pinned to Plane CE 1.3.1)..."
  node scripts/fixtures/provision-plane.mjs \
    || warn "Plane provisioning reported an error (see above) — the connector re-attempts its REST auto-connect at boot; re-run \`node scripts/fixtures/provision-plane.mjs\` once Plane is healthy."
  # Bring up the MCP bridge ONLY when a PAT was actually provisioned (the bridge
  # crashes on boot without PLANE_API_KEY). A "skipped" provision (Plane not
  # ready / unsupported version) writes no env file — the bridge waits for a
  # later re-run and the connector still auto-connects its REST config.
  if [ -f docker/plane-mcp/.plane-mcp.env ] && grep -q '^PLANE_API_KEY=.' docker/plane-mcp/.plane-mcp.env; then
    info "Bringing up the Plane MCP bridge (--profile plane --profile plane-mcp)..."
    # The bridge (profile `plane-mcp`) declares `depends_on: plane-api`, which
    # lives in the `plane` profile. Activating `plane-mcp` alone leaves plane-api
    # an undefined service, so the bridge's dependency can't resolve and it fails
    # on the first pass (cinatra#1238 finding). Activate BOTH profiles in one set
    # so the dependency is defined; the already-running `plane` containers from the
    # bring-up above are left in place (up -d is a no-op for healthy services).
    docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile plane --profile plane-mcp up -d --build \
      || warn "Plane MCP bridge failed to start — the connector still auto-connects its REST config; re-run \`docker compose --profile plane --profile plane-mcp up -d --build\` to expose Plane tools to agents."
  else
    warn "Plane PAT not provisioned yet (Plane still booting or version mismatch) — skipping the MCP bridge. Re-run \`node scripts/fixtures/provision-plane.mjs\` once Plane is healthy, then \`docker compose --profile plane --profile plane-mcp up -d --build\`."
  fi

  info "Demo app profiles up. Connections converge at the first \`pnpm dev\` boot."
fi

# ── App setup ─────────────────────────────────────────────────────────────────

if [ "$RESOLVED_MODE" != "production" ]; then
  # Dev clone-back MUST run before the first `pnpm install`: the root
  # package.json declares `workspace:*` dependencies on the companion extension
  # packages (extensions/<scope>/<name>), so on a fresh clone — where the
  # gitignored extensions/ tree does not exist yet — `pnpm install` fails with
  # ERR_PNPM_WORKSPACE_PKG_NOT_FOUND before `pnpm setup:dev` (which used to own
  # the clone-back) ever runs (cinatra#109/#110). The sync script is
  # deliberately pre-install-safe (node builtins + git only); CI runs the same
  # script before its own install for the same reason.
  #
  # `--pinned` (cinatra#489): check each companion repo out DETACHED at the sha
  # committed in cinatra-required-extensions.lock.json / cinatra-dev-extensions.lock.json,
  # the same refs the committed pnpm-lock.yaml + src/lib/generated/* maps were
  # built against, so a fresh `make setup` ends with a CLEAN git tree. Without it
  # the clone-back tracked floating `main` HEADs that can drift ahead of the
  # committed lockfile, leaving a fresh install with a dirty tree (lockfile + maps
  # silently mutated by the unfrozen `pnpm install` below). The floating-HEAD
  # canary stays an explicit opt-in (the CI clone-extensions action's `head` mode).
  info "Cloning companion extension repos (pre-install, pinned to the committed lock shas)..."
  node scripts/ci/sync-dev-extensions.mjs --pinned
fi

info "Installing dependencies..."
pnpm install

if [ "$RESOLVED_MODE" = "production" ]; then
  # Production extension acquisition: the first `pnpm install` above provided
  # the root `tar` dependency + the published `cinatra` CLI (@cinatra-ai/cinatra,
  # a pinned devDependency) at node_modules/.bin/cinatra; this step downloads the
  # required-extension set pinned + integrity-verified from the committed
  # cinatra-required-extensions.lock.json (no git/gh binary needed), and the
  # second `pnpm install` links the acquired packages into the workspace.
  # Fails loud (set -e) on any network / 404 / integrity error. The acquisition
  # inside `pnpm setup:prod` then re-verifies as an idempotent no-op.
  info "Acquiring required extensions (pinned + integrity-verified)..."
  pnpm exec cinatra extensions acquire-prod
  info "Linking acquired extensions into the workspace..."
  pnpm install
  info "Running Cinatra production setup..."
  pnpm setup:prod
else
  info "Running Cinatra dev setup..."
  # cinatra#674 — NON-FATAL pre-wizard advisory guard.
  #
  # `cinatra dev setup dev` does its real, must-succeed work (DB provisioning,
  # core + extension migrations, Better Auth bootstrap, dev-app clone-back)
  # BEFORE it prints "Cinatra dev setup complete." — every one of those steps
  # THROWS on failure, which rejects the CLI promise and exits non-zero WITHOUT
  # ever printing the completion marker. AFTER the marker the CLI runs only
  # advisory, post-boot self-checks (the content-editor `doctor` chain — e.g.
  # "LLM MCP access — no public MCP URL", which is UNSATISFIABLE on a clean
  # local install until the app is up and a public MCP URL is configured — plus
  # dev-app presence and the local-registry seed). Those NEVER throw; they only
  # set the CLI's `process.exitCode = 1`. The net effect is a process that
  # finished setup successfully yet exits non-zero — which, under this script's
  # `set -euo pipefail`, would abort `make setup` before "Setup complete!" even
  # though the app boots fine and the wizard works.
  #
  # So: capture setup's exit code WITHOUT letting `set -e` abort, and treat a
  # non-zero exit as a REAL failure ONLY when the completion marker is absent
  # (DB / migration / acquisition / Better-Auth error → fail loud). When the
  # marker IS present the must-succeed work completed; the remaining non-zero is
  # one of the CLI's OWN deliberately "loud-but-non-fatal" post-marker steps
  # (the advisory `doctor` chain, or a dev-app / extension-sync / local-registry
  # warning) — every one of those streams its own loud `⚠` line to the terminal
  # via `tee`, so nothing is HIDDEN; we mirror the CLI's own fatal/non-fatal
  # boundary and continue rather than abort `make setup`. `tee` keeps the live
  # output streaming; `${PIPESTATUS[0]}` reads pnpm's exit code, not tee's.
  # Anchor the marker grep to the EXACT completion line so unrelated output can
  # never spoof it. A signal exit (>=128, e.g. Ctrl-C) is always a real abort.
  SETUP_DEV_LOG=$(mktemp -t cinatra-setup-dev.XXXXXX)
  # shellcheck disable=SC2064
  trap "rm -f '$SETUP_DEV_LOG'" EXIT
  set +e
  pnpm setup:dev 2>&1 | tee "$SETUP_DEV_LOG"
  SETUP_DEV_STATUS=${PIPESTATUS[0]}
  set -e
  if [ "$SETUP_DEV_STATUS" -ne 0 ]; then
    if [ "$SETUP_DEV_STATUS" -lt 128 ] && grep -qx 'Cinatra dev setup complete.' "$SETUP_DEV_LOG"; then
      warn "Dev setup COMPLETED but reported a non-zero status (exit $SETUP_DEV_STATUS) from a post-completion advisory check — e.g. the pre-wizard 'LLM MCP access' doctor assertion (unsatisfiable until the app is up and a public MCP URL is configured), or a loud-but-non-fatal dev-app / extension-sync / local-registry warning printed above. The app still boots and the setup wizard works; continuing. Re-run \`cinatra doctor\` once the app is up for the authoritative post-boot gate, and address any \`⚠\` lines above."
    else
      rm -f "$SETUP_DEV_LOG"; trap - EXIT
      error "Cinatra dev setup FAILED (exit $SETUP_DEV_STATUS) before completing — a real provisioning error (database, migrations, Better Auth, or extension acquisition) or an interrupt. See the output above. Setup did NOT complete."
    fi
  fi
  rm -f "$SETUP_DEV_LOG"; trap - EXIT
fi

# NOTE: setup no longer builds a per-extension shell sandbox image. The
# `cinatra/skill-shell:latest` runtime an extension used to contribute as
# `runtime/Dockerfile` was retired together with the shell-tools capability.
# Its successor is the platform-owned execution-plane L0 image
# (docker/sandbox/Dockerfile): CI builds and publishes it, and a developer
# builds it locally on demand with
# `docker build -t cinatra-sandbox-l0:dev docker/sandbox` — the sandbox worker
# names that exact command in its own "image not available" error, so setup
# does not pre-build it. With the pinned extension set nothing in the tree
# matches `extensions/*/*/runtime/Dockerfile`, so the removed build step only
# ever printed its own "skipped" warning here.

# ── Sample data (optional) ────────────────────────────────────────────────────

# Sample data is OFF by default. It can be enabled via SEED=1, or accepted at
# the prompt. The seed itself is a no-op until a platform admin user exists,
# so the user can safely opt-in here and run `pnpm seed` again after their
# first registration.

LOAD_SEED=0

if [ "$DEMO" = "1" ]; then
  # Demo forces the sample seed (cinatra#1238). It no-ops here until a human
  # admin exists (the seed's own precondition), then fires lazily at app boot
  # via the demo-seed boot runner — so opting in here is safe and idempotent.
  LOAD_SEED=1
  info "Demo overlay: sample fixture data (ACME Group) is forced on (CINATRA_INSTALL_PROFILE=demo)."
elif [ -n "${SEED:-}" ]; then
  case "$(printf '%s' "$SEED" | tr '[:upper:]' '[:lower:]')" in
    1|y|yes|true) LOAD_SEED=1 ;;
    0|n|no|false) LOAD_SEED=0 ;;
    *) error "SEED='$SEED' is not valid. Use 1 or 0." ;;
  esac
elif [ "${YES:-}" = "1" ]; then
  LOAD_SEED=0
elif [ -t 0 ]; then
  prompt "Load sample fixture data (ACME Group) for testing? [y/N]: "
  read -r SEED_ANSWER
  case "$(printf '%s' "$SEED_ANSWER" | tr '[:upper:]' '[:lower:]')" in
    y|yes) LOAD_SEED=1 ;;
    *)     LOAD_SEED=0 ;;
  esac
fi

if [ "$LOAD_SEED" = "1" ]; then
  info "Loading sample fixture data (ACME Group)..."
  pnpm seed || warn "Sample data load reported an issue. Re-run with: pnpm seed"
fi

# ── Knowledge-graph provider key (cinatra#2582) ───────────────────────────────

# The Graphiti container needs the provider key as an env var at container
# startup, and the app keeps that key in the DATABASE, not the shell env. Compose
# used to interpolate `${OPENAI_API_KEY:-}`, which resolved EMPTY on a normal
# install: Graphiti then dropped every episode (extraction runs before the graph
# write) and the graph stayed silently empty.
#
# `npm run kg:up` is ONE step that resolves the key in memory and recreates the
# graphiti service with it set in the environment of that `docker compose up`.
# NO FILE IS WRITTEN — docker/graphiti/.graphiti.env is never present, and a
# leftover from the old road is deleted here and announced.
#
# Run it HERE, after the database exists, so an install that already has a
# stored key (a re-run, a restored backup) gets it into the container on this
# pass. On a FRESH install there is no key yet and this reports "indexing OFF" —
# the honest state, not an error; the hint printed at the end says how to turn
# it on.
# stdout is quiet (a bring-up's compose chatter is not setup's story), but
# STDERR IS NOT REDIRECTED: that is where the generator says it deleted a
# `.graphiti.env` that carried a real credential in clear, and that sentence is
# the operator's cue to rotate the key. Swallowing it would hide the one thing
# this step exists to tell them.
info "Giving the knowledge-graph indexer its provider key..."
npm run --silent kg:up >/dev/null \
  || warn "Could not give the knowledge-graph indexer its provider key; run \`npm run kg:refresh\` once the stack is up."

# ── Service check ─────────────────────────────────────────────────────────────

# Post-setup validation: confirm every supporting service is reachable. This is
# a report, not a gate — a non-zero exit (a required service down) must not
# abort an otherwise-successful setup, hence `|| true`. Re-run any time with
# `make check`.
info "Validating services..."
node scripts/check-services.mjs || true

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
info "Setup complete!"
echo ""
echo "  Start the app:    pnpm dev"
echo "  Open the app:     http://localhost:3000"
echo "  Stop infra:       make down"
echo ""
echo "  The first user to register becomes the admin."
echo "  After that, you can (re-)load sample data with: pnpm seed"
echo ""
if [ "$WAYFLOW" = "1" ]; then
  echo "  Agent runtime: the WayFlow container (:3010) started with the stack."
  echo "  Agents work out of the box. Stop it with: cinatra instance wayflow stop"
else
  echo "  Agent runtime: NOT started (NO_WAYFLOW=1). Agent runs fail with"
  echo "  ECONNREFUSED until you start it:"
  echo "      cinatra instance wayflow start"
fi
echo ""
echo "  Knowledge graph: after you connect OpenAI in the app (/configuration/llm),"
echo "  run 'npm run kg:refresh' to hand that key to the indexer container."
echo "  Until then it runs without a key and indexes nothing (objects still work)."
echo ""
