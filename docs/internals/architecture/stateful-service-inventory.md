# Stateful-service inventory & supported upgrade matrix

**Upgrade-paths epic, slice 1** (cinatra#1420, epic cinatra#1419). This document is the
human-readable companion to the machine-readable matrix:

- **Matrix (source of truth for consumers):** [`config/upgrade/upgrade-matrix.json`](../../../config/upgrade/upgrade-matrix.json)
- **Schema:** [`config/upgrade/upgrade-matrix.schema.json`](../../../config/upgrade/upgrade-matrix.schema.json)
- **Gate:** `scripts/check-upgrade-matrix.mjs` + `scripts/ci/__tests__/upgrade-matrix.test.mjs`
  (runs in the root Vitest suite). Fail-closed: a new named volume in
  `docker-compose.yml`, a compose pin bump without a matrix update, or a reintroduced
  floating tag reds the suite.
- **Shared consumption contract:** `scripts/lib/upgrade-matrix.mjs`
  (`loadUpgradeMatrix` / `assertMatrixRevision` / `resolveTransition`,
  `MATRIX_REVISION`). `cinatra-cli` (preflight cinatra-cli#128, `db upgrade-major`
  cinatra-cli#129) and the works-after upgrade-from arm (cinatra#1422) resolve every
  `(service, from, to)` tuple through this logic against the **same matrix revision**;
  skew is fail-closed.

**Supported-source baseline:** the stack pins shipped in the **0.1.9 release** (epic
decision). Anything not explicitly listed as a supported transition or a named case
exception is **UNSUPPORTED** — consumers must refuse, never best-effort.

## State inventory (every named volume, all compose profiles)

State classes: `canonical-data` (must survive, engine-migrated) · `derived-index`
(rebuildable from source) · `cache` (discardable) · `queue` (drainable) ·
`object-store` (files/uploads, preserved in place) · `package-storage` ·
`key-material` (none currently volume-backed; Nango encryption keys live in env/config,
platform secrets in the platform DB).

| Volume | Service (profile) | Image pin (resolved) | Class | Migration mechanism |
| --- | --- | --- | --- | --- |
| `cinatra-postgres` | `postgres` (default) | `postgres:18-alpine@sha256:9a8afca5…` | canonical-data | logical dump→fresh-volume→restore |
| `nango-postgres` | `nango-db` (default) | `postgres:17-alpine@sha256:742f40ea…` | canonical-data | logical dump→fresh-volume→restore |
| `cinatra-redis` | `redis` (default) | `redis:8-alpine@sha256:9d317178…` | cache | discard-recreate |
| `cinatra-verdaccio-storage` | `verdaccio` (default) | `verdaccio/verdaccio:6@sha256:bcd0dc5f…` | package-storage | discard-recreate (re-publish repopulates) |
| `cinatra-neo4j-data` | `neo4j` (default) | `neo4j:2026.05-community@sha256:6c162e24…` | canonical-data | in-place store-format (one-way; dump first) |
| — (no volume) | `graphiti` (default) | BUILT — `docker/graphiti/Dockerfile` (upstream `425bf248` + graphiti-core `0.29.3`) | derived-index | rebuild (state lives in Neo4j) |
| — (no volume) | `kg-embedder` (default) | BUILT — `docker/kg-embedder/Dockerfile` (bge-small-en-v1.5, baked) | stateless | rebuild |
| `cinatra-wordpress-db` | `wordpress-db` (wordpress) | `mariadb:11.4` | canonical-data | in-place store-format (sequential majors) |
| `cinatra-wordpress` | `wordpress` (wordpress) | `cinatra-wordpress-dev:6.9-php8.3` | object-store (uploads/plugins tree) | app-managed boot migration |
| `cinatra-drupal-db` | `drupal-db` (drupal) | `mariadb:11.4` | canonical-data | in-place store-format (sequential majors) |
| `cinatra-drupal` | `drupal` (drupal) | locally built (`docker/drupal`) | object-store (site files tree) | app-managed boot migration |
| `cinatra-twenty-db` | `twenty-db` (twenty) | `postgres:16` | canonical-data | logical dump→fresh-volume→restore |
| `cinatra-twenty-server` | `twenty-server` + `twenty-worker` (twenty) | `twentycrm/twenty:v2.7.3` | object-store (.local-storage uploads) | app-managed boot migration |
| `cinatra-twenty-redis` | `twenty-redis` (twenty) | `redis:7` | cache | discard-recreate |
| `cinatra-plane-pgdata` | `plane-db` (plane) | `postgres:15.7-alpine` | canonical-data | logical dump→fresh-volume→restore |
| `cinatra-plane-redisdata` | `plane-redis` (plane) | `valkey/valkey:7.2.11-alpine` | cache | discard-recreate |
| `cinatra-plane-rabbitmq` | `plane-mq` (plane) | `rabbitmq:3.13.6-management-alpine` | queue (drainable) | discard-recreate |
| `cinatra-plane-uploads` | `plane-minio` (plane) | `minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493…` | object-store | in-place roll-forward |

Bind mounts (source checkouts, generated configs, the cinatra WP plugin dir) carry no
engine state and are out of scope. `nango-server` and the Plane app services own **no
volume** but run implicit DB migrations at boot, so they are tracked as
`coupledAppImages` (of `nango-db` and `plane-db` respectively) and pin-drift-checked.
The gate additionally enforces a **repo-level net**: any compose service whose image
repo is tracked by any matrix pin must carry a matrix pin string exactly — so a single
Plane consumer, `twenty-worker`, or `nango-server` cannot drift off while its siblings
stay pinned.

## Bundled apps run their OWN schema migrations

Plane, Twenty, WordPress and Drupal each run their own schema migrations at boot, **on
top of** their engine data dir. The platform's drizzle migration ledger
(`packages/migrations`) covers **only** the platform DB (`cinatra-postgres`); Nango
likewise migrates its own DB at boot. The matrix records this per service as
`appManagedSchema: true` — an engine upgrade for those families is only half the story,
and app-image majors must arrive as reviewable pin diffs too.

## The two floating tags are frozen (this slice)

| Before (floating) | After (immutable, digest-bound) |
| --- | --- |
| `minio/minio:latest` | `minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493…` (the `latest` digest at pin time) |
| `makeplane/plane-{backend,live,frontend,space,admin,proxy}:stable` | `…:v1.3.1@sha256:…` per image (≡ the CE 1.3.1 the #315/#320 smoke ran), via the `${PLANE_TAG:-…}` default |

Plane app images run implicit DB migrations at boot, so a floating `stable` could
silently cross a schema-migrating major on a plain `docker pull`. Existing
`latest`/`stable` volumes have an **unknown last-writer version** — recorded in the
matrix as an explicitly fail-closed `unknown-latest` source for MinIO until the
deployed-version ledger (cinatra-cli#128) classifies the running release at preflight.
From this slice on, a major arrives only as a reviewable pin diff — never absorbed by a
pull. The `${PLANE_TAG}`/`${TWENTY_TAG}` override knobs remain for explicit,
operator-chosen overrides.

## Per-family skipped-major rules (summary — the matrix is normative)

- **Postgres (×4: platform 18, nango 17, twenty 16, plane 15.7):** logical
  dump→fresh-volume→restore crosses any span in one hop (`skippedMajor: allowed`).
  Mount layout is dictated by the **target** major: `≤17` mounts at
  `/var/lib/postgresql/data`, `≥18` at the parent `/var/lib/postgresql`
  (docker-library/postgres#1259). Baseline transition: platform **17→18** (#1417
  Case A). Pre-baseline case exception: **nango 15→17** (#1417 Case B) — supported for
  that named case only, without widening the nango baseline (held at 17).
- **MariaDB (×2, 11.4):** in-place `mariadb-upgrade`, **sequential majors only**
  (11.4 → 11.8 → 12.x); skipping 11.8 is unsupported.
- **Neo4j (2026.05 CalVer):** one-way in-place store-format upgrade on first start;
  an old binary cannot open a new-format store, so take a `neo4j-admin database dump`
  before rolling the pin (rollback = the dump). Downgrade unsupported.
- **redis 8 / redis 7 / valkey 7.2.11:** forward RDB is readable; **downgrade is
  unsafe** (Redis 8 writes RDB v14 that Redis 7 refuses — crash-loop). State is
  regenerable cache/queue, so discard-recreate is the fail-safe path.
- **rabbitmq 3.13.6:** the 3.x→4.x hop is **feature-flag-gated** — all stable 3.13
  flags must be enabled before 4.0, which refuses to boot otherwise; unsupported until
  that hop is proven. Queue state is drainable (discard-recreate fallback).
- **minio:** in-place roll-forward on the pinned server line; unknown `latest` sources
  are fail-closed until classified.
- **verdaccio 6:** dev package cache; discard-recreate (re-publish repopulates).
- **graphiti:** derived; repin + rebuild, paired with the neo4j pin. Since cinatra#2591 the
  "pin" is a pair of BUILD ARGS, not a registry digest: Zep publishes the same upstream source
  on its own `mcp-v*` cadence and that lagged graphiti-core by four releases with no newer tag,
  so the service is built from a pinned upstream commit against a pinned graphiti-core release.
  The works-after graphiti arm builds the same Dockerfile, so the proof binds the shipped bytes.
- **kg-embedder:** stateless, no volume, NO published port. The vendor-free embedding floor —
  graphiti's embedder providers are all paid hosted APIs, so without it an install with no
  OpenAI key cannot rank at all. Weights are baked at build time, so a container start needs
  no network.

## Change protocol

1. Any compose pin change ships **with** the matching `upgrade-matrix.json` update in
   the same PR (`revision` bumped) — the gate refuses drift in either direction.
2. A stateful-service **major** additionally needs both proofs green (epic standing
   gate): fresh-init **and** upgrade-from-existing-data (cinatra#1422's arm).
3. New stateful service ⇒ new inventory row + matrix entry (the gate fails the suite on
   an unclassified named volume) with explicit transitions, or it cannot land.
4. Every stateful service mounts a **named** data volume — including a `cache`-class one
   whose contents are disposable. The name is not about durability: the fail-closed
   recreate preflight identifies each service's data volume from the resolved compose
   config, so an anonymous mount reads as "data volume could not be identified" and
   BLOCKS the bring-up (cinatra#2329 — `twenty-redis` blocked a fresh isolated install
   from a profile the install never even activates). `graphiti` is the sole volume-less
   entry, and only because it is derived state that lives entirely in Neo4j.
