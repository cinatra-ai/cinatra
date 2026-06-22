.PHONY: setup refresh dev down reset reset-full logs clean check

# First-time setup: install deps, start infra, configure app.
setup:
	bash scripts/setup.sh

# Update an existing checkout: after `git pull`, reconcile dependencies and the
# dev database schema to the code on disk. Dev-only; never touches git.
refresh:
	pnpm exec cinatra dev refresh

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
