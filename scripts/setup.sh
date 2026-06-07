#!/usr/bin/env bash
set -euo pipefail

# Cinatra — Local Setup
# Usage: bash scripts/setup.sh
#
# Non-interactive overrides (useful for CI / scripted installs):
#   MODE=dev|prod   bash scripts/setup.sh   # skip the dev/prod prompt
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
  case "${1,,}" in
    d|dev|development) echo "development" ;;
    p|prod|production) echo "production" ;;
    *) echo "" ;;
  esac
}

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
  if [ "$(uname)" = "Darwin" ]; then
    sed -i '' "s/replace-with-a-random-32-byte-hex-secret/$SECRET/" .env.local
    sed -i '' "s/^CINATRA_RUNTIME_MODE=.*/CINATRA_RUNTIME_MODE=$RESOLVED_MODE/" .env.local
  else
    sed -i "s/replace-with-a-random-32-byte-hex-secret/$SECRET/" .env.local
    sed -i "s/^CINATRA_RUNTIME_MODE=.*/CINATRA_RUNTIME_MODE=$RESOLVED_MODE/" .env.local
  fi
  info ".env.local created with a random BETTER_AUTH_SECRET and CINATRA_RUNTIME_MODE=$RESOLVED_MODE."
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

# ── App setup ─────────────────────────────────────────────────────────────────

info "Installing dependencies..."
pnpm install

if [ "$RESOLVED_MODE" = "production" ]; then
  info "Running Cinatra production setup..."
  pnpm setup:prod
else
  info "Running Cinatra dev setup..."
  pnpm setup:dev
fi

# The OpenAI shell sandbox image builds from whichever extension ships a
# runtime/Dockerfile (today the OpenAI connector, cloned back under extensions/).
# Core does not hardcode a specific extension. Build only when one is present --
# never abort `make setup` (set -euo pipefail) when the clone-back has not
# delivered it yet (the OpenAI shell tool just stays unavailable until then).
shell_runtime_context=""
for dockerfile in extensions/*/*/runtime/Dockerfile; do
  if [ -f "$dockerfile" ]; then
    shell_runtime_context="$(dirname "$dockerfile")"
    break
  fi
done
if [ -n "$shell_runtime_context" ]; then
  info "Building OpenAI shell Docker image..."
  docker build -t cinatra/skill-shell:latest "$shell_runtime_context"
else
  warn "Skipping OpenAI shell Docker image: no extension ships a runtime/Dockerfile. The OpenAI shell tool stays unavailable until the runtime Dockerfile is restored to the OpenAI connector."
fi

# ── Sample data (optional) ────────────────────────────────────────────────────

# Sample data is OFF by default. It can be enabled via SEED=1, or accepted at
# the prompt. The seed itself is a no-op until a platform admin user exists,
# so the user can safely opt-in here and run `pnpm seed` again after their
# first registration.

LOAD_SEED=0

if [ -n "${SEED:-}" ]; then
  case "${SEED,,}" in
    1|y|yes|true) LOAD_SEED=1 ;;
    0|n|no|false) LOAD_SEED=0 ;;
    *) error "SEED='$SEED' is not valid. Use 1 or 0." ;;
  esac
elif [ "${YES:-}" = "1" ]; then
  LOAD_SEED=0
elif [ -t 0 ]; then
  prompt "Load sample fixture data (ACME Group) for testing? [y/N]: "
  read -r SEED_ANSWER
  case "${SEED_ANSWER,,}" in
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
