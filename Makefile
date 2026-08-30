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
# The knowledge-graph provider key reaches the indexer AFTER the stack is up,
# and never through a file (cinatra#2582): `npm run kg:up` resolves the key from
# the app's stored configuration in memory and re-runs `docker compose up` for
# the graphiti service alone with the key set in that command's environment.
# `docker/graphiti/.graphiti.env` is not written and is never present; any
# leftover from the old road is deleted on sight and announced.
# It runs AFTER the whole-stack `up` on purpose: the app database is part of
# this stack, so resolving the key before it starts asked a database that was
# not up yet and a first cold bring-up always came out keyless. Non-fatal (`-`):
# a keyless install, or one whose configuration cannot be read, reports the
# state and the bring-up continues.
# The `wayflow` profile brings up the agent runtime with the stack (cinatra#2654):
# agent runs hit it on :3010 and fail with ECONNREFUSED when it is absent, so it
# belongs to the default bring-up, not to an undocumented extra command.
# scripts/dev-compose-env.mjs is the ONE step that resolves this checkout's
# compose project and host ports (cinatra#2839). It must run here too: this
# target used to bring the stack up on the compose files' fixed defaults and
# `pnpm dev` then reconciled the SAME project onto derived ports afterwards, so
# whichever ran first decided what got published. On the main checkout it
# resolves to the historical values and nothing changes.
#
# ASSIGN, then eval — never `eval "$$(...)"` directly. The step exits non-zero on
# a plan it will not guess at (a named lane with no host port for a scoped
# service, an unusable override, a companion port that overflows), but the exit
# status of a command substitution inside `eval` is thrown away, so the `up`
# would run anyway. A bare assignment carries it, and the `&&` chain stops.
#
# --require-manageable is what makes the stand-down real HERE. This is a
# WHOLE-STACK `up`: it has no way to leave out a service whose URL says it is
# configured elsewhere, so for a named lane the step refuses rather than letting
# compose publish that service on the shared default. `pnpm dev` (the launcher)
# heals nango-server alone with `--no-deps` and honors the stand-down per
# service; a whole-stack up structurally cannot.
#
# SCOPE LIMIT, stated plainly (cinatra#2845/#2849): only nango-server,
# nango-connect, nango-db and redis are parameterized. A second lane running THIS
# target still collides on the stack's other fixed host ports — wayflow 3010,
# verdaccio 4873, postgres 5434, neo4j, graphiti. Two-lane whole-stack bring-up
# is not supported yet; `pnpm dev` per lane is.
# The shared step also UNSETS the provider variables the graphiti service takes
# from the compose process's environment, so this whole-stack `up` starts the
# knowledge-graph indexer KEYLESS whatever the operator's shell holds, and
# `kg:up` below is the one step that hands it the key the app actually stored
# (cinatra#2582).
dev:
	CINATRA_COMPOSE_ENV="$$(node scripts/dev-compose-env.mjs --require-manageable)" && eval "$$CINATRA_COMPOSE_ENV" && docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile wayflow up -d
	-npm run --silent kg:up
	pnpm dev

# Stop infrastructure (keeps data).
#
# Routed through the SAME shared step `dev` uses (cinatra#2849): a bare
# `docker compose down` here acted on the DEFAULT project, because Compose does
# not read COMPOSE_PROJECT_NAME from `.env.local` — so on a scoped lane it left
# the lane's own stack running while claiming to have stopped it. No
# `--require-manageable`: that flag exists only to make a WHOLE-STACK `up`
# honor a per-service stand-down, and `down` starts nothing.
down:
	CINATRA_COMPOSE_ENV="$$(node scripts/dev-compose-env.mjs)" && eval "$$CINATRA_COMPOSE_ENV" && docker compose down

# Soft reset: drop auth/app data, flush Redis, rebuild schemas and connections.
reset:
	pnpm reset:dev

# Full reset: equivalent to a fresh clone — wipes Docker volumes, node_modules,
# build artifacts, regenerates .env.local, reinstalls everything from scratch.
reset-full:
	pnpm exec cinatra reset dev --yes --full --rebuild-env

# Show infrastructure logs.
#
# Same shared step as `dev` (cinatra#2849) — a bare `docker compose logs` on a
# scoped lane tailed the OPERATOR'S containers, not the lane's own.
logs:
	CINATRA_COMPOSE_ENV="$$(node scripts/dev-compose-env.mjs)" && eval "$$CINATRA_COMPOSE_ENV" && docker compose logs -f

# Remove Docker volumes (data wipe without rebuild).
#
# Same shared step as `dev` (cinatra#2849) — DESTRUCTIVE, and a bare
# `docker compose down -v` on a scoped lane wiped the OPERATOR'S volumes
# (or another lane's) instead of this lane's own.
clean:
	CINATRA_COMPOSE_ENV="$$(node scripts/dev-compose-env.mjs)" && eval "$$CINATRA_COMPOSE_ENV" && docker compose down -v
