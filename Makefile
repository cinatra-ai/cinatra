.PHONY: setup setup-demo refresh dev down reset reset-full logs clean check

# First-time setup: install deps, start infra, configure app.
setup:
	bash scripts/setup.sh

# Demo install (cinatra#1238): a strict SUPERSET of `make setup` — development
# runtime + the demo install profile. Brings up the four bundled app profiles
# (wordpress, drupal, twenty, plane), forces the sample seed, and activates the
# demo dev-fixtures + the lazy monolithic ACME seed (fires at boot once the
# first human admin registers). For Plane it ALSO headlessly provisions a
# dev/demo PAT (owner ruling 2026-07-23 (groganz) — AUTOMATIC connect) and
# brings up the Plane MCP bridge (--profile plane-mcp @ loopback :3450), so the
# connector auto-connects with no manual token paste. Equivalent to
# `MODE=demo bash scripts/setup.sh`.
setup-demo:
	MODE=demo bash scripts/setup.sh

# Update an existing checkout: after `git pull`, reconcile dependencies and the
# dev database schema to the code on disk. Dev-only; never touches git.
# The explicit install first bootstraps the freshly pinned CLI so `pnpm exec`
# resolves the version this checkout declares, not whatever an older checkout
# left in node_modules (the refresh's own install runs too late for that).
refresh:
	pnpm install
	pnpm exec cinatra instance refresh

# Validate that every supporting service is reachable.
check:
	node scripts/check-services.mjs

# Start infrastructure and the app.
dev:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
	pnpm dev

# Stop infrastructure (keeps data).
down:
	docker compose down

# Soft reset: drop auth/app data, flush Redis, rebuild schemas and connections.
reset:
	pnpm reset:dev

# Full reset: equivalent to a fresh clone — wipes Docker volumes, node_modules,
# build artifacts, regenerates .env.local, reinstalls everything from scratch.
reset-full:
	pnpm exec cinatra reset dev --yes --full --rebuild-env

# Show infrastructure logs.
logs:
	docker compose logs -f

# Remove Docker volumes (data wipe without rebuild).
clean:
	docker compose down -v
