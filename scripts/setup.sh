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

# ── Docker infrastructure ─────────────────────────────────────────────────────

info "Starting infrastructure (Postgres + Redis)..."
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

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
until curl -sf http://127.0.0.1:3003/health >/dev/null 2>&1; do
  sleep 2
done
info "Nango is ready."

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
    info "Bringing up the Plane MCP bridge (--profile plane-mcp)..."
    docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile plane-mcp up -d --build \
      || warn "Plane MCP bridge failed to start — the connector still auto-connects its REST config; re-run \`docker compose --profile plane-mcp up -d --build\` to expose Plane tools to agents."
  else
    warn "Plane PAT not provisioned yet (Plane still booting or version mismatch) — skipping the MCP bridge. Re-run \`node scripts/fixtures/provision-plane.mjs\` once Plane is healthy, then \`docker compose --profile plane-mcp up -d --build\`."
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

# The OpenAI shell sandbox image builds from whichever extension ships a
# runtime/Dockerfile (today the OpenAI connector, cloned back under extensions/).
# Core does not hardcode a specific extension, but exactly ONE extension may own
# the `cinatra/skill-shell:latest` tag: collect ALL matches so an AMBIGUOUS tree
# (>1 extension shipping a runtime/Dockerfile) fails loud instead of silently
# re-tagging the shell image from whichever the glob happened to enumerate first.
# Build only when exactly one is present -- never abort `make setup`
# (set -euo pipefail) when the clone-back has not delivered it yet (the OpenAI
# shell tool just stays unavailable until then).
shell_runtime_contexts=()
for dockerfile in extensions/*/*/runtime/Dockerfile; do
  if [ -f "$dockerfile" ]; then
    shell_runtime_contexts+=("$(dirname "$dockerfile")")
  fi
done
if [ "${#shell_runtime_contexts[@]}" -gt 1 ]; then
  error "Ambiguous OpenAI shell runtime: ${#shell_runtime_contexts[@]} extensions ship a runtime/Dockerfile (${shell_runtime_contexts[*]}). Exactly one (the OpenAI connector) may provide cinatra/skill-shell:latest; resolve the ambiguity before setup can build the shell image."
elif [ "${#shell_runtime_contexts[@]}" -eq 1 ]; then
  info "Building OpenAI shell Docker image..."
  docker build -t cinatra/skill-shell:latest "${shell_runtime_contexts[0]}"
else
  warn "Skipping OpenAI shell Docker image: no extension ships a runtime/Dockerfile. The OpenAI shell tool stays unavailable until the runtime Dockerfile is restored to the OpenAI connector."
fi

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
echo "  Stop infra:       docker compose down"
echo ""
echo "  The first user to register becomes the admin."
echo "  After that, you can (re-)load sample data with: pnpm seed"
echo ""
