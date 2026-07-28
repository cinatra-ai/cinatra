# Upgrade track — inventory + pin-drift

Ledger for the major-version upgrade work (part of the 0.1.3 major-upgrade
track). This is the inventory + pin-drift **first pass**: it records the
current pin and the upstream major target for every pinned runtime image and
toolchain version, and it inventories every patch / `pnpm` override /
`patchedDependencies` / `allowBuilds` entry / code version-workaround with an
**obsoleted-by-version** column so each major upgrade can drop the workarounds
it makes unnecessary (and re-confirm the rest).

Scope of this pass: **non-breaking**. It pins the one floating image that is
safe to pin in place (Nango) and **records** every other target; data-migration
-bearing image bumps (Postgres majors, etc.) and toolchain majors (ESLint 10,
Next 16, OTel 2, …) are each owned by their own staged upgrade lane and are out
of scope here.

Ground date: 2026-06-23 (against the repo's then-current `main`). Image targets
are taken from the Renovate "Dependency Dashboard" issue (Detected Dependencies
+ the major updates it lists as awaiting schedule).

---

## 1. Runtime images — current → target

Source files: `docker-compose.yml`, `Dockerfile`, `docker/wayflow/Dockerfile`,
`docker/drupal/Dockerfile`, `docker/wayflow/compose.clone.template.yml`.

`floating` = an unpinned tag that moves on every pull (the pin-drift this pass
targets). `profile` = the service only starts under an opt-in compose profile.

| Service / artifact | File | Current pin | Upstream major target | Notes |
|---|---|---|---|---|
| postgres (platform) | docker-compose.yml | `postgres:18-alpine@sha256:9a8a…de15` (was `17-alpine` floating; **major applied + digest-pinned 2026-07-11** — §3) | at target (latest stable 18.4; 19 is prerelease-only) | platform DB; 18 needs the PARENT volume mount (§3); live cutovers ride the owner-gated deploy wave |
| nango-db | docker-compose.yml | `postgres:17-alpine@sha256:979c…59ca` (was `15-alpine`; consolidated + digest-pinned) | **HELD at 17 — current validated hold**; follows Nango upstream support | app-coupled to Nango (upstream reference compose pins postgres 16; 17 is already a validated divergence); revisit when upstream moves (§3) |
| twenty-db | docker-compose.yml | `postgres:16` | follows Twenty upstream | profile `twenty`; upstream-dictated major, not ours |
| plane-db | docker-compose.yml | `postgres:15.7-alpine` | follows Plane upstream | profile `plane`; upstream-dictated, track don't lead |
| redis (platform) | docker-compose.yml | `redis:8-alpine@sha256:9d31…7005` (was `redis:7-alpine`, **major applied + digest-pinned** — §9) | at target (latest stable 8.8.0) | BullMQ works-after arm gates it (§9) |
| twenty-redis | docker-compose.yml | `redis:7` | redis 8 | profile `twenty` |
| plane-redis | docker-compose.yml | `valkey/valkey:7.2.11-alpine` | valkey 8 | profile `plane`; Plane-dictated |
| neo4j | docker-compose.yml | `neo4j:2026.05-community@sha256:b91a…9604` (was `5.26-community`, **major applied** — §7) | at target (CalVer latest) | graphiti-coupled; CalVer line is the 5.x semver successor |
| graphiti | docker-compose.yml | `zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2@sha256:c9e0…c4d6` (digest-pinned this pass — §7) | **no next major published** (repo tops out at this tag) | neo4j-coupled; held at current release (only change is the immutable pin) |
| verdaccio | docker-compose.yml | `verdaccio/verdaccio:6@sha256:e3ac…3575` (was floating `:6`, **pinned this pass** — §8) | verdaccio 6.7.4 (latest stable; no newer major offered) | dev registry; ephemeral storage |
| nango-server | docker-compose.yml | digest-pinned `nangohq/nango-server:hosted@sha256:…` (was floating, pinned this pass — §2) | Renovate-tracked | the headline drift this pass closes |
| wordpress-db (mariadb) | docker-compose.yml | `mariadb:11.4` | mariadb 11.8 then mariadb 12.3 | profile `wordpress` |
| drupal-db (mariadb) | docker-compose.yml | `mariadb:11.4` | mariadb 11.8 then mariadb 12.3 | profile `drupal` |
| wordpress | docker-compose.yml | built image tag `cinatra-wordpress-dev:6.8-php8.3` | wp 6.9 then wp 7.0 / php 8.5 | local dev build tag |
| rabbitmq | docker-compose.yml | `rabbitmq:3.13.6-management-alpine` | rabbitmq 4 | profile `plane` |
| minio | docker-compose.yml | `minio/minio:latest` (floating) | pin to a dated release tag | profile `plane`; secondary floating tag worth pinning (noted, deferred) |
| plane-* (backend/live/frontend/space/admin/proxy) | docker-compose.yml | `makeplane/plane-*:${PLANE_TAG:-stable}` (floating default) | pin `:stable` → a fixed release tag | profile `plane`; Plane-dictated |
| twenty-server / twenty-worker | docker-compose.yml | image tag `twentycrm/twenty:${TWENTY_TAG:-v2.7.3}` | Twenty v2 currency | profile `twenty`; already release-pinned by default |
| node (app image) | Dockerfile | `node:24-alpine` | stay node 24 (LTS) | engines require node 24; no major offered |
| python (wayflow) | docker/wayflow/Dockerfile | `python:3.14-slim` (was `3.11-slim`, bumped — cinatra#354) | (at target) | wayflowcore runtime; the Wayflow agent-runtime major-upgrade lane (§6) |
| php (drupal) | docker/drupal/Dockerfile | `php:8.5-apache@sha256:eacc…66dd` (was the floating tag `php:8.3-apache`; **major applied + digest-pinned 2026-07-28** — §14) | at target (8.5.8-apache-trixie is the latest stable line) | Drupal companion image; the bump also removed `opcache` from `docker-php-ext-install` (§14) |
| composer (drupal) | docker/drupal/Dockerfile | `composer:2` | composer 2.x | |
| tailscale (wayflow clone) | docker/wayflow/compose.clone.template.yml | `tailscale/tailscale:v1.78.3` | tailscale v1.98.4 | **held on purpose** — in-file TODO cites the upstream containerboot SIGSEGV (tailscale/tailscale#14354); obsoleted-by = that upstream fix lands |

wayflow Python deps (exact `==` pins in `docker/wayflow/Dockerfile`, not docker
tags): `wayflowcore[a2a]==26.1.2`, `pyagentspec==26.1.2`, `asgi-lifespan==2.1.0`,
`pytest-asyncio==0.23.5`. Tracked as a unit (wayflowcore 26.1.2 floors
pyagentspec at `>=26.1.2`, so they move together). Bumped from
`wayflowcore==26.1.1` / `pyagentspec==26.1.0` in the Wayflow major-upgrade lane
(cinatra#354, §6).

---

## 2. Pin-drift fix applied this pass — Nango `:hosted`

The `nango-server` image was the floating tag `nangohq/nango-server:hosted`
(it moved on every `docker pull`). This pass pins it to an **immutable digest**
in `docker-compose.yml`:

```
image: nangohq/nango-server:hosted@sha256:6f12853c192eab083175865a0427c1ea57a757a2d4d932ed8af46d6e3c002869
```

- The `:hosted` tag component is kept for human readability; the `@sha256:` is
  the binding pin.
- **Amd64-only image.** Verified empirically with
  `docker buildx imagetools inspect nangohq/nango-server:hosted` (2026-06-23):
  the result is a single-arch `application/vnd.docker.distribution.manifest.v2+json`
  (NOT a multi-arch index), config architecture amd64. So pinning to a digest
  adds **no** cross-architecture portability cost (an arm64 dev already runs it
  under emulation whether referenced by tag or by digest).
- **Bumps:** Renovate owns them (it already tracks `nangohq/nango-server`).
  Re-resolve the digest at bump time with the `imagetools inspect` command
  above. The hosted deployment validates and pins its own digest on its own
  schedule, independently of this dev pin — these are two independent sources
  and must not be hand-synced.

Why a real digest (not a tag-plus-comment): a tag with a "pinned-by-policy"
comment is not a pin — `:hosted` still floats on every pull. Since the image is
amd64-only there is no portability reason to avoid the digest, so the honest
immutable pin is used.

---

## 3. Postgres majors — 18 applied (platform), holds recorded

*(Supersedes the earlier "record the target, defer the bump" state of this
section; the deferred bump has now been executed by the staged Postgres lane.)*

**Applied 2026-07-11 — platform `postgres` → `postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`**
(18.4-alpine3.24, the CONFIRMED multi-arch OCI index digest; postgres 19 is
prerelease-only, so 18.4 is the latest-stable bar). Two coupled facts:

- **Layout change:** the 18 image moved PGDATA to
  `/var/lib/postgresql/18/docker` and requires the volume mounted at the
  **parent** `/var/lib/postgresql` (docker-library/postgres#1259). The compose
  mount moved accordingly. An 18 container REFUSES both a volume mounted at
  the legacy `.../data` target and a parent-mounted volume holding a 17
  cluster at its root — fail-closed in both directions (verified empirically;
  the works-after postgres arm asserts the refusal as its negative test).
- **Existing dev volumes:** a 17-era `cinatra-postgres` volume makes 18 refuse
  to start (data untouched). Migrate via the documented dump/restore into a
  fresh volume (the mechanism `scripts/ci/works-after/postgres.sh` proves), or
  discard disposable dev data and let 18 initdb fresh. Deployed environments
  migrate ONLY via the ops runbook's owner-gated dump/restore cutover — the
  live stacks are pinned back to 17 by their ops overrides until then.

**Holds (deliberate, recorded):**

- `nango-db` — **current validated hold at `17-alpine@sha256:979c…59ca`**:
  app-coupled to Nango, whose upstream reference compose still pins
  postgres 16, so 17 is already a deliberate validated divergence and 18 is
  unvalidated by upstream (the works-after nango arm proves fresh-init, not a
  restored 17 cluster under 18). It keeps the legacy `.../data` mount while it
  is a <=17 image. Revisit when Nango upstream moves.
- `twenty-db` (postgres 16) and `plane-db` (postgres 15.7) are profile-gated
  and their Postgres major is **chosen by Twenty / Plane upstream**, not by
  us; we track upstream and do not renumber them onto our major (unchanged
  policy).
- `scripts/ci/prod-boot-e2e.sh` keeps a `postgres:17` stand-in until the live
  cutover wave: it boots the RELEASED image, which deploys against the live
  platform postgres (17 until the owner-gated cutover). The forward proofs
  (works-after 17→18 arm, upgrade-proof on 18, the CI e2e suites) run on 18.

---

## 4. Patches / overrides / build-flags / code workarounds (obsoleted-by-version)

### 4.1 `patches/` and `docker/**/patches/`

| Patch | Patches | Why | Obsoleted by version |
|---|---|---|---|
| `patches/@a2a-js__sdk@0.3.13.patch` | `@a2a-js/sdk@0.3.13` dist `parseSseStream` | upstream SSE parser overwrote multi-line `data:` instead of accumulating with `\n`; the patch accumulates | an `@a2a-js/sdk` release that ships the multi-line `data:` accumulation fix upstream. The `patchedDependencies` key embeds the exact version, so every `@a2a-js/sdk` bump must re-key + re-verify or the patch silently stops applying |
| `docker/drupal/patches/mcp_tools-audit-logger-strtolower.patch` | Drupal `mcp_tools` AuditLogger `strtolower($key)` | PHP 8 throws a `TypeError` when an `int` array key reaches `strtolower`; the patch casts `(string)` | an upstream `mcp_tools` (Drupal contrib) release that null/int-safes the key — **that release has landed**: `drupal/mcp_tools` `1.0.0-beta18` already carries `strtolower((string) $key)` (see §14.2). The php 8.5 bump did **not** retire it, exactly as predicted; the contrib release did. Kept in tree (the entrypoint applier is grep-guarded and no-ops), because the contrib requirement is the unpinned `^1.0` with `minimum-stability: dev` — retiring the applier is a separate contrib-pinning decision, not an image decision |

### 4.2 `pnpm-workspace.yaml` — `overrides`

> Note on the upstream source-name: pnpm 11 renamed `ignoredBuiltDependencies`
> to `allowBuilds` and stopped reading `package.json#pnpm`, so this repo has no
> `ignoredBuiltDependencies` key — the equivalent lives in `allowBuilds` (§4.4).

| Override | Pin | Class | Obsoleted by version |
|---|---|---|---|
| `react` / `react-dom` | `19.2.6` (exact lockstep) | lockstep pin (not a vuln) | structural — relax when all caret consumers are updated; keep through the React 19→20 major decision |
| `dompurify@<3.4.11` | `>=3.4.11 <4` | security (GHSA-gvmj / -vxr8 / -76mc + GHSA-cmwh-pvxp-8882) | when `monaco-editor` (via `@queuedash/ui`) and `mermaid` (via `chevrotain`) bump their bundled `dompurify` to `>=3.4.11` (drop when no sub-`3.4.11` copy resolves) |
| `lodash@<4.17.24` / `lodash-es@<4.17.24` | `>=4.17.24 <5` | security (GHSA-r5fr / -f23m) | when `chevrotain` (via `mermaid`) stops pinning `4.17.21` |
| `postcss@<8.5.10` | `>=8.5.10 <9` | security (GHSA-qx2v) | when `next` stops bundling `8.4.31` |
| `better-auth@<1.6.2` | `1.6.19` | dedupe a vulnerable dev-dep copy (GHSA-wxw3) | when the vestigial `@better-auth/cli` dev-dep is removed, or it drags a patched `better-auth` |
| `drizzle-orm@<0.45.2` | `0.45.2` | dedupe a vulnerable copy (GHSA-gpj5) | when `@better-auth/cli` stops dragging `0.41.0` |
| `ioredis` | `5.11.1` | dedupe (`bullmq` pinned `5.10.1` → `Redis` type clash) | when `bullmq` raises its `ioredis` floor to `>=5.11.1` |

Documented **non-override** (a deliberate deferral, kept here so a reader knows
it was considered): `vite` (GHSA-fx2h-pf6j-xcff + GHSA-v2wj-q39q-566r /
-p9ff-h696-f583) is **intentionally not overridden** — `vite` is dev/test-only
here (sole consumer is `vitest`), so the dev-server advisories have no
production exposure, and the patched line breaks `vitest` module mocking
(`vi.resetModules`). Obsoleted by: a `vitest` release whose `vite` floor is the
patched line **and** keeps `vi.resetModules` mocking working.

### 4.3 `pnpm-workspace.yaml` — `patchedDependencies`

`"@a2a-js/sdk@0.3.13": patches/@a2a-js__sdk@0.3.13.patch` — same entry as §4.1.
The key embeds the exact version, so a dependency bump = re-key + re-verify.

### 4.4 `pnpm-workspace.yaml` — `allowBuilds` (pnpm-11 successor to `ignoredBuiltDependencies`)

`allowBuilds:` set to `false` (build script not run; prebuilt binaries used) for:
`@google/genai`, `@prisma/client`, `@sentry/cli`, `better-sqlite3`, `core-js`,
`esbuild`, `msgpackr-extract`, `protobufjs`, `sharp`, `unrs-resolver`.

Class: build-hygiene. **No** obsoleted-by-version is expected from a dependency
major — these are intentional standing entries (a major upgrade re-confirms
them, it does not drop them). Flag: re-confirm each on the relevant package's
major bump (`esbuild`, `sharp`, `better-sqlite3` are the ones whose prebuild
story could change).

### 4.5 Code workarounds tied to a version

| Location | Workaround | Obsoleted by version |
|---|---|---|
| `eslint.config.mjs` (react `settings.version`) | hard-sets `settings.react.version` to a fixed string because `eslint-plugin-react@7.37.5` (via `eslint-config-next`) calls the removed ESLint-9 `context.getFilename()` under ESLint 10 when version is `"detect"` | an `eslint-plugin-react` release that is ESLint-10-compatible (this is the gating workaround for the ESLint 10 major). Minor drift to align: that fixed string is `19.2.5` while the overrides pin react `19.2.6` — harmless (it only skips detection) but worth aligning on the next touch |
| `packages/dashboards/src/mcp-cubes/registry.ts` | an `any`-cast to attach drizzle-cube `_meta` past the MCP SDK's narrow `Tool` type | an MCP SDK release that exposes a typed annotations/meta slot (and/or drizzle-cube typing) |
| `extensions/cinatra-ai/pdf-artifact/src/renderers/pdf-promise-with-resolvers-polyfill.ts` | a `Promise.withResolvers` polyfill for the react-pdf / pdfjs-dist path on older Safari (migrated into the pdf-artifact base by the Slice B G2 cutover — cinatra#1630) | a **browser baseline** move (Safari 17.4+, Mar 2024) — runtime/browser-version-tied, **not** a dependency upgrade; remove when the supported-browser floor moves past Safari 17.4. Listed for completeness; out of scope for the dependency-majors track |

(The `bpmn-moddle` ambient-`.d.ts` workaround that was formerly listed here was
retired by the workflow-kind engine removal — see §4.6.)

**Not version-tied** (recorded so a reader knows they were considered and why
they are excluded from the obsoleted-by-version table):
`packages/extensions/src/permissions-store.ts` `syncLegacyCoOwnersFromCanonical`
("remove when readers migrate off the legacy tables" — a data-migration
milestone; no upgrade obsoletes it) and the marketplace MCP client's vendored
type definitions ("delete when the contract package is publishable to the
registry" — a publish milestone, not an upgrade). Both are real cleanups but
belong to their own trackers, not the version-major track.

### 4.6 Already retired

The built-in Workflows GANTT and its SVAR (`@svar-ui/react-gantt`) Turbopack /
CSS-import-order workaround were **retired by the GANTT removal** (cinatra#321,
closed). Verified on the scanned `main` (2026-06-23): `@svar-ui/react-gantt`
(and `wx-react-gantt` / `@svar`) appears in **zero** `package.json` files, zero
TS/TSX/CSS imports, and zero lines of `pnpm-lock.yaml`. The only residual SVAR
mentions are server-side schedule / critical-path comments describing the
now-removed client's edit-intent contract and some seed-fixture text — those are
not workarounds and carry no SVAR dependency. **Nothing remains to drop.**

Note: the Renovate Dependency Dashboard read on 2026-06-23 still listed a
`@svar-ui/react-gantt` → `v2.7.0` update target row, which **appears stale**
relative to the scanned `main` (Renovate had not re-scanned since the GANTT
removal merged). It resolves itself on Renovate's next scan — no manual edit is
needed; it is flagged here only so a reader does not re-add the dependency
chasing a phantom update.

The `bpmn-moddle` ambient-`.d.ts` workaround (formerly §4.5:
`packages/workflows/src/bpmn/bpmn-moddle.d.ts`, a hand-written type shim because
`bpmn-moddle@10.0.0` ships no types) was **retired by the workflow-kind engine
removal** (cinatra#1035): the whole `packages/workflows/` tree — the only code
that imported `bpmn-moddle` — is gone from `main`, so the shim it needed no
longer exists and there is no remaining path to type. The `bpmn-moddle`
dependency itself is now **orphaned** — still pinned at `10.0.0` in the root
`package.json` but imported by nothing (verified on the scanned `main`: zero
`import`/`require` of `bpmn-moddle` across `src/`, `packages/`, and `scripts/`).
Dropping that leftover pin is a dead-dependency cleanup for the dependency
track, **not** an upgrade workaround; it is noted here only so a reader treats
the pin as removable dead weight rather than a live obsoleted-by-version entry.

---

## 5. Stack-major candidate list (from the Renovate Dependency Dashboard)

Image / runtime majors offered: postgres 18, redis 8, valkey 8, mariadb 12,
wordpress 7 (plus 6.9), php 8.5, python 3.14, tailscale 1.98 (held — see §1),
rabbitmq 4. npm / toolchain majors offered: ESLint 10, Next 16.x (the
`eslint-config-next` + `next` pair), the React monorepo, `@opentelemetry/*` 2
(deferred per the overrides note), **`typescript` 7 (the native/Go compiler GA'd
2026-07-09 as `typescript@7`; see §8 — the `@typescript/native-preview` package
that previewed it stays a dev/nightly channel, excluded from the bar, and is
obsoleted by adopting the stable GA)**, `cron-parser` 5, `pdfjs-dist` 6,
`react-day-picker` 10, `github/codeql-action` 4, pnpm 11.6.

This pass only **inventories** these; each is taken on in its own staged
upgrade lane with a works-after proof.

**The bar is the LATEST STABLE version of each candidate — not merely the latest
stable major.** The staged upgrade lane lands each at its **latest stable
release**: the latest stable major AND the latest stable minor/patch within it
(prerelease channels — beta/rc/canary/alpha/dev/`-next` — excluded). The
major-hop is still run through its own lane (the "major" in a lane's name is the
risky hop it owns), but in-range minor/patch currency counts toward "done" too:
a candidate already on the latest stable major still needs its newest in-major
minor/patch to be considered current, and a candidate whose stable line tops out
below the offered "major" (e.g. Verdaccio 6.x, wayflowcore 26.1.x) lands at the
latest stable patch rather than chasing a prerelease major.

---

## 6. Wayflow (agent runtime) major upgrade — applied (cinatra#354)

The Wayflow agent-runtime major-upgrade lane on the v0.1.3 major-upgrade track.
The runtime is the app-coupled image built from `docker/wayflow/` (Python pins,
not a docker tag). It runs **after** the works-after gate (cinatra#352) exists.

**What changed** (`docker/wayflow/Dockerfile` build-arg defaults):

| Pin | Before | After |
|---|---|---|
| `PYTHON_TAG` | `3.11-slim` | `3.14-slim` |
| `WAYFLOWCORE_VERSION` | `26.1.1` | `26.1.2` |
| `PYAGENTSPEC_VERSION` | `26.1.0` | `26.1.2` |

**What the "major" is here.** The headline major in this lane is the **Python
runtime major** (3.11 → 3.14). wayflowcore exposes **no major above 26.1.x**
upstream (the released line tops out at `26.1.2`), so the wayflow deps move to
the current upstream patch in lockstep rather than crossing a major: wayflowcore
`26.1.1 → 26.1.2` floors `pyagentspec>=26.1.2`, so pyagentspec moves `26.1.0 →
26.1.2` with it. wayflowcore `26.1.2` declares `Requires-Python: >=3.10,<3.15`,
so the 3.14 base is in-band. No public wayflowcore/pyagentspec API the loader
imports changed across 26.1.1→26.1.2 (verified by `test_live_class_names.py` +
the works-after A2A round-trip on the candidate image; see below). The
diagnostic-only `_patch_pyagentspec_deserialization_error_mask` is retained as a
fail-open safety net (it is a no-op on the deserialize success path and falls
back to upstream if the surface drifts) — it is not load-bearing for this bump.

**Works-after proof (the gate, cinatra#352 — the per-service works-after
harness on the major-upgrade track).** The
wayflow arm of the per-service works-after harness builds the candidate image at
the new pins and drives a real agent execution over A2A (no-LLM echo flow:
`message/send → completed`, the round-tripped nonce surfaced via the EndNode
output). The CI `works-after proof` workflow **derives the candidate pins from
the checked-out Dockerfile**, so this PR's bump is exactly what the gate
exercises — no major lands without it green. Run locally:

```
PYTHON_TAG=3.14-slim WAYFLOWCORE_VERSION=26.1.2 PYAGENTSPEC_VERSION=26.1.2 \
  WORKS_AFTER_ONLY=wayflow bash scripts/ci/works-after-proof.sh
```

(the env is redundant once the Dockerfile defaults are bumped — a bare
`WORKS_AFTER_ONLY=wayflow bash scripts/ci/works-after-proof.sh` builds the same
candidate from the Dockerfile defaults).

**Rollback path.** The runtime is a per-build image, not a registry digest, so
rollback is a revert of the three `docker/wayflow/Dockerfile` build-arg
defaults (and the mirrored defaults in `scripts/ci/works-after/wayflow.sh`):

| Pin | Roll back to |
|---|---|
| `PYTHON_TAG` | `3.11-slim` |
| `WAYFLOWCORE_VERSION` | `26.1.1` |
| `PYAGENTSPEC_VERSION` | `26.1.0` |

i.e. `git revert` this PR's commit (or reset those three ARG defaults) and
rebuild `docker/wayflow` — the previous image is reproduced byte-for-byte from
the prior pins (no migration state to unwind; the runtime is stateless, session
values flow through the A2A task input, not env/volumes). To pre-bake and pin a
known-good rollback image by digest, build the prior pins and capture the digest:
`docker build --build-arg PYTHON_TAG=3.11-slim --build-arg
WAYFLOWCORE_VERSION=26.1.1 --build-arg PYAGENTSPEC_VERSION=26.1.0 -t
wayflow-rollback docker/wayflow && docker image inspect --format '{{index
.RepoDigests 0}}{{.Id}}' wayflow-rollback`.

---

## 7. Neo4j + Graphiti image majors — applied (Refs ops#359)

The Neo4j + Graphiti image-major lane (paired cinatra-repo change to ops#359 —
the pins live in **this** repo's `docker-compose.yml`, not ops). The two are a
**coupled pair** (graphiti / knowledge-graph-mcp fronts Neo4j over MCP), so they
are decided together. Targets were determined **empirically** against the actual
registry (`docker buildx imagetools inspect` + the Docker Hub tag list), not
from real-world version assumptions.

### 7.1 Neo4j — major applied (`5.26-community` → `2026.05-community`)

Neo4j retired the `5.x` **semver** line at `5.26` (its last semver release) and
moved to a **CalVer** scheme; the CalVer line is the major successor. The
registry's newest community release is `2026.05-community` (kernel `2026.05.0`)
— verified by the tag list (`…2026.03 → 2026.04 → 2026.05-community`; no
`2026.06+`) and by the rolling `neo4j:community` / `neo4j:2026-community` tags
both resolving to the **same digest** as `2026.05-community`. There is **no**
`6.x-community` / `7.x-community` tag (those do not exist in this registry).

**Pin (immutable digest):**

```
image: neo4j:2026.05-community@sha256:b91a6fa7b1d88eb0702847f53eaa4d07781a6d480b0c5a5bba413af5856e9604
```

The `2026.05-community` tag component is kept for human readability; the
`@sha256:` is the binding pin (same convention as the Nango row, §2). It is a
multi-arch OCI index (amd64 + arm64), so the digest pin carries no portability
cost. Re-resolve at bump time with
`docker buildx imagetools inspect neo4j:2026.05-community`.

**Two behavior changes the major introduces** (both handled mechanically in this
PR — no application code change needed):

1. **Default Cypher language is now `CYPHER_25`** (was Cypher 5). `dbms.components()`
   on the candidate reports `Cypher ["5", "25"]` and `db.query.default_language`
   defaults to `CYPHER_25`. The graphiti image (knowledge-graph-mcp) emits
   **Cypher-5-shaped** queries, so the compose `neo4j` service now pins the
   server default back with `NEO4J_db_query_default__language: CYPHER_5`
   (env→config mapping of `db.query.default_language`). The same env is added to
   the works-after graphiti arm's neo4j bring-up so the gate exercises the
   identical config. Cypher 5 is still fully supported in the CalVer line, so
   this is a forward-compatible compatibility pin, not a freeze.
2. **`NEO4J_AUTH` password now has an 8-char minimum.** A shorter password makes
   the container exit at boot with *"The minimum password length is 8
   characters."* The dev default `cinatra-local` (13 chars) and the works-after
   arm's generated password (`wa-` + 24 hex = 27 chars) both clear it; a
   **production `NEO4J_PASSWORD` override must be ≥8 chars** (it already should
   be a strong secret — see the §1/compose prod notes). Override the floor only
   if unavoidable via `NEO4J_dbms_security_auth__minimum__password__length`.

APOC is unaffected: `NEO4J_PLUGINS: '["apoc"]'` + the `NEO4J_apoc_*` settings
still load (`apoc.version()` → `2026.05.0` on the candidate).

**Data / RPO note (this is the stateful arm).** Neo4j holds the knowledge graph
on the `cinatra-neo4j-data` volume. Unlike a Postgres major, a CalVer Neo4j
bump against an existing `5.26` store is an **in-place store-format upgrade**
handled by the server on first start (not a `pg_upgrade`-style dump/restore) —
but it is still a one-way on-disk migration, so the **monthly dump backup is the
RPO floor**: take a fresh `neo4j-admin database dump` (or the operator's
scheduled monthly dump) **before** rolling the pin in an environment with a
populated store, so a rollback can restore the pre-upgrade graph. Dev/CI starts
from an empty volume, so the works-after arm has no migration to perform.

**Works-after proof.** The neo4j+graphiti arm
(`scripts/ci/works-after/graphiti.sh`, derived candidate `NEO4J_TAG` now
`2026.05-community`) brings up the candidate Neo4j with the real compose wiring
(APOC + the CYPHER_5 pin) and runs graphiti's object projection→store→search
round-trip through the repo's own `graphiti-client.ts`. That full round-trip
**requires a real `OPENAI_API_KEY`** (graphiti does LLM entity extraction before
the Neo4j write; a fake cannot stand in — see the arm header), so it runs in the
major **lane / `workflow_dispatch`** with a supplied key; in `WORKS_AFTER_GATE_MODE=1`
a missing key is a hard FAIL (a skipped proof is a false green). Run it:

```
OPENAI_API_KEY=<real> WORKS_AFTER_GATE_MODE=1 \
  WORKS_AFTER_ONLY=graphiti bash scripts/ci/works-after-proof.sh
```

(the candidate `NEO4J_TAG`/`GRAPHITI_IMAGE` come from the arm defaults, now the
bumped pins — no env needed). The candidate Neo4j boot, readiness/healthcheck,
APOC load, and the CYPHER_5 compat pin were additionally **proven directly** by
bringing up `neo4j:2026.05-community` with the exact compose env during this lane.

**Rollback.** Revert this PR's `docker-compose.yml` neo4j stanza (pin back to
`neo4j:5.26-community@sha256:937fbd163e302a5751dd329b719c1b05e2a4293af223d61b1aa17e3dea087709`,
drop the `NEO4J_db_query_default__language` line) and, in any environment whose
store was already format-upgraded, restore from the pre-upgrade monthly dump
(the format upgrade is one-way; an old binary will not open a new-format store).

### 7.2 Graphiti — already at the newest stable (digest-pin only)

**Already at the newest stable — there is no newer tag to bump to** (ops#359
reframe: latest stable, not only a major hop — a newer minor/patch would count,
but none is published). The `zepai/knowledge-graph-mcp` repository's newest
published tag is `1.0.2-graphiti-0.28.2` — which is the **current pin**. Verified
against the full Docker Hub tag list (the ladder is
`0.2.0 → 0.2.1 → 0.3.0 → 0.4.0`, then `1.0.0-graphiti-0.22.0 →
1.0.1-graphiti-0.23.1 → 1.0.2-graphiti-0.28.2`); `:latest` and `:1.0.2` resolve
to the **same digest** as the current pin, and no `1.0.3` / `1.1.x` / `2.x` /
newer `graphiti-0.29+` tag exists. Probing newer candidate tags (`2.0.0`,
`1.1.0-graphiti-0.29.0`, `1.0.3-graphiti-0.28.2`, `1.0.2-graphiti-0.28.3`, …) all
return *not found*.

So graphiti **stays on its current release**. The only change applied is an
**immutable digest pin** (the same hardening the Nango row got, §2) so the pin
no longer rides `:latest`-style movement:

```
image: zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2@sha256:c9e0efd3f0bcdb4125eceed08958aea94fe2d85a90c20dfdaadaaf8304e1c4d6
```

Graphiti is **derived state** (rebuildable): it owns no durable store of its own
— the graph lives in Neo4j and graphiti re-projects/extracts into it. So there
is no graphiti backup/RPO concern; a graphiti rollback is just reverting the
digest pin. When a knowledge-graph-mcp major **is** published, it re-enters this
lane (re-pair with the Neo4j pin, re-run the works-after round-trip).

---

## 8. Refresh 2026-07-10 — TypeScript 7 GA + verdaccio pin + nango-db consolidation

A re-grounding of §1/§5 against the live `main` compose and the npm registry.
Two things moved since the ground date (§2 nango-db bump had also landed since
first pass); this section is the delta, the earlier sections stay as the
first-pass record.

### 8.1 TypeScript 7 went GA (the second true in-scope stack major)

**TypeScript 7.0 — the native (Go/"tsgo") compiler rewrite — reached GA
(announced 2026-07-08/09), shipping as the mainstream `typescript` package.**
Grounded on the npm registry observed 2026-07-10: the `latest` dist-tag is now
`typescript@7.0.2` (with `beta = 6.0.0-beta`, `rc = 7.0.1-rc`, `next = 7.1.x-dev`
— i.e. `7.0.2` is the stable line, not a prerelease). The
repo pins `typescript: "^6.0.3"`, which resolves to the top of the `6.x` line
(`6.0.3`), so **`typescript` is now one stable major behind (6 → 7.0.2)** — a
real, offered stack major where it previously was not (the first-pass inventory
correctly excluded it because no stable 7.x existed yet; the native compiler was
still preview-only).

- **Bar** (latest stable): `typescript@7.0.2` — latest stable major AND latest
  in-major patch.
- **This is the second true in-scope stack major**, alongside `@opentelemetry/*`
  `1.x → 2.x` (cinatra#673). Every other coupled stack group remains at its
  latest stable major (in-range minor/patch currency only).
- **Coupled group + upstream gate.** The stack-major lane couples `typescript`
  with `@typescript-eslint` and the `eslint-config-next` / `next` toolchain that
  type-checks against it. **This lane is currently upstream-blocked: no
  `@typescript-eslint` release supports TS 7 yet.** The latest
  `@typescript-eslint/parser` (`8.63.0`, also the version locked here) peers
  `typescript: ">=4.8.4 <6.1.0"` — it caps at TS 6.0 and refuses TS 7. So TS 7
  is recorded as an **offered-but-gated** major (same shape as the ESLint-10
  gate in §4.5): the lane records the target and waits for a TS-7-aware
  typescript-eslint line, then runs the hop with its coupled group at each
  member's latest stable through the works-after / named-SHA CI gate. (TS 7 also
  drops the in-process compiler API surface, so any tooling that imports
  `typescript` programmatically is re-checked in the lane.)
- **`@typescript/native-preview` was the PRE-GA preview of this same native
  compiler — not a separate product.** Now that the native compiler has GA'd as
  `typescript@7`, that preview package continues only as a **dev/nightly
  channel** (npm `latest` `7.0.0-dev.20260707.2`, `beta 7.0.0-dev.20260421.2` —
  no stable dist-tag). Under the latest-stable bar the currency target is
  therefore **stable `typescript@7.0.2`**, and the `-dev` native-preview channel
  stays **excluded as a prerelease** (you track the GA'd stable line, not the
  nightly). **Obsolete-on-upgrade:** adopting stable `typescript@7` makes the
  separate `@typescript/native-preview` devDependency redundant (the GA
  supersedes the preview of the same compiler), so the TS 7 lane should DROP it
  — a workaround retired by this major, tracked here per the cross-cutting
  obsolete-on-upgrade check.

Obsolete-on-upgrade note for the TS 7 lane: also re-check the ESLint-10
react-version workaround in `eslint.config.mjs` (§4.5) — the `eslint-plugin-react`
/ `@typescript-eslint` versions the TS 7 bump drags may change whether that
hard-set `settings.react.version` string is still required.

### 8.2 verdaccio `:6` — floating tag pinned to a digest (applied this refresh)

The first pass recorded verdaccio as the one remaining safe-to-pin-in-place
float (dev registry, ephemeral storage) but left the target recorded. This
refresh **applies the pin**: `verdaccio/verdaccio:6` was a floating major tag
that moved on every pull; it is now pinned to the confirmed multi-arch
(amd64/arm64) OCI **index** digest in `docker-compose.yml`:

```
image: verdaccio/verdaccio:6@sha256:e3ac7e335e69504cd0b09616aa52066399868282313c34762d2a77b8169a3575
```

Resolved empirically (`docker buildx imagetools inspect verdaccio/verdaccio:6`,
2026-07-10): an `application/vnd.oci.image.index.v1+json` index carrying
`linux/amd64` + `linux/arm64` manifests, so the digest pin carries **no**
cross-architecture portability cost (same reasoning as the Nango §2 and Neo4j
§7.1 rows). `:6` is kept for human readability; the `@sha256` is the binding
pin. `verdaccio 6.7.4` is the latest stable line and no newer major is offered,
so this is a currency-complete pin, not a held target. Re-resolve the digest at
bump time with the `imagetools inspect` command above.

The broader compose still carries floats in the **bundled demo apps** — the
Plane profile's `minio:…latest` and `makeplane/plane-*:${PLANE_TAG:-stable}`,
and the Twenty tag via `${TWENTY_TAG}`. Those are upstream-dictated,
profile-gated demo images (§1) and are out of the platform env-app pin-drift
scope; they are flagged here (and in §1) for a demo-app pin pass, not pinned as
part of the platform inventory.

### 8.3 nango-db consolidation reflected in §1

The first-pass §1/§3 recorded `nango-db` at `postgres:15-alpine` with the 17/15
spread to reconcile. That reconciliation has since landed: live `main` pins
`nango-db` at `postgres:17-alpine@sha256:979c…59ca` (consolidated onto the
platform Postgres major AND digest-pinned to a confirmed multi-arch manifest).
The §1 row is updated to match; §3's rationale stays as the first-pass record.
The platform Postgres **18** major itself remains deferred to its own staged
upgrade lane (data-migration-bearing; `pg_upgrade`/dump-restore), unchanged.

## 9. Refresh 2026-07-11 — Redis 8 applied + platform digest currency pass

The non-Postgres platform-image currency pass against the live registries
(index digests re-resolved via the Docker Hub API, observed 2026-07-11).
Postgres (platform + nango-db) is explicitly untouched here — it has its own
staged upgrade lane (§3).

### 9.1 Redis — MAJOR applied (`7-alpine` → `8-alpine`, digest-pinned)

Applied in this PR: the platform `redis` pin moves to
`redis:8-alpine@sha256:9d317178eceac8454a2284a9e6df2466b93c745529947f0cd42a0fa9609d7005`
— the multi-arch OCI index digest of the latest stable line (8.8.0; the
`8-alpine` index digest has been stable since 2026-06-23). Redis is the
BullMQ cache/queue backend; the works-after redis arm proves a real bullmq
enqueue → worker-run → complete round-trip on the candidate (the CI arm runs
the derived candidate TAG; the digest identity is grounded against the
registry index digest at resolve time). Harness/local defaults
(`scripts/ci/works-after/redis.sh`, `scripts/ci/works-after/nango.sh`'s redis
sidecar, `scripts/ci/works-after-proof.sh` diagnostics) and the prod-boot e2e
stand-in (`scripts/ci/prod-boot-e2e.sh`) move with the pin.

**Rollback:** repoint to
`redis:7-alpine@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99`
and CLEAR any persisted dump first — Redis 8.8 writes RDB format v14, Redis
7.4 reads only ≤v12 and refuses a newer dump (crash-loop). The volume holds
regenerable cache/queue state; discarding it is the documented downgrade path.

**Still on Redis 7 after this section (deliberate):** the CI service
containers in `.github/workflows/*` (build-image, e2e-app-suites,
dashboard-live-verify, design-visual-verify, wp-drupal-uat, dev-hmr-smoke) —
a workflow-path change rides a separate review-gated PR; and the
profile-gated demo fixtures (`twenty-redis`, plane's valkey), which are
upstream-dictated (§1).

### 9.2 The rest of the platform set — currency state (re-grounded 2026-07-11)

- **neo4j:** the calendar line still tops out at `2026.05-community`
  (no newer stable calendar release offered), but the tag was REPUBLISHED
  upstream on 2026-07-02 — the index digest moved off the pinned
  `sha256:b91a…9604`. A digest re-resolve rides its own PR (same version, new
  bytes → digest-bound graphiti works-after dispatch gates it).
- **graphiti:** `zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2@sha256:c9e0…c4d6`
  still equals upstream `latest` — CURRENT, no change.
- **verdaccio:** `6.7.4` (= the pinned `sha256:e3ac…3575`) is still the latest
  stable; the 7 line remains prerelease-only (`-next`) — CURRENT, no change
  (§8.2 pin unchanged).
- **nango-server:** the `hosted` moving tag drifted again upstream. The pin
  converge (this compose onto the smoke-validated digest) rides its own PR,
  merge-gated on the hosted deployment's OAuth round-trip smoke — see the
  nango-server compose comment for the validation contract.


---

## 10. OpenTelemetry SDK 1.x → 2.x — applied (the stack-majors OTel group)

The `@opentelemetry/*` SDK-suite lift the §4.2 / §5 notes deferred is applied
(the stack-layer-majors lane, cinatra#1149; in-repo tracker cinatra#673). The
suite moves together as one coupled group:

| Pin | Before | After |
|---|---|---|
| `@opentelemetry/resources` (root) | `^1.30.1` | `^2.9.0` |
| `@opentelemetry/sdk-trace-base` (root + metric-cost-api) | `^1.30.1` | `^2.9.0` |
| `@opentelemetry/sdk-trace-node` (root) | `^1.30.1` | `^2.9.0` |
| `@opentelemetry/core` (metric-cost-api) | `^1.30.1` | `^2.9.0` |
| `@opentelemetry/semantic-conventions` (root) | `^1.41.1` | `^1.43.0` (in-range) |
| `@opentelemetry/api` | `^1.9.1` | unchanged (2.x SDK peers api 1.x) |

**Code adaptation** (the breakage the §4.2 note predicted, plus one more):

1. `src/lib/otel-bootstrap.ts`: `new Resource({...})` →
   `defaultResource().merge(resourceFromAttributes({...}))` (the 2.x provider
   uses the supplied resource AS-IS — the explicit merge preserves the
   `telemetry.sdk.*` default attributes 1.x merged implicitly);
   `provider.addSpanProcessor(...)` → the `spanProcessors` constructor array;
   `SemanticResourceAttributes.SERVICE_NAME` → `ATTR_SERVICE_NAME`.
2. `packages/metric-cost-api/src/span-exporter.ts`: 2.x replaced
   `ReadableSpan.parentSpanId` with `parentSpanContext` → the exporter reads
   `span.parentSpanContext?.spanId ?? null` (DB column unchanged).
3. **Propagator suppression retired (obsolete-on-upgrade):** the 1.x
   bootstrap passed `propagator: null` to keep the then-vulnerable
   W3CBaggagePropagator (GHSA-8988-4f7v-96qf, patched >=2.8.0) off the wire.
   On 2.x the default parsers are patched, so the bootstrap now omits the
   propagator when Sentry is off — restoring the default W3C tracecontext
   propagation exactly as the 1.x hardening note planned. The pnpm-workspace
   GHSA-8988 triage comment is retired with it; the contract test
   (`otel-bootstrap-propagator.test.ts`) now pins the 2.x wiring (Sentry
   propagator when on; property ABSENT when off; ctor `spanProcessors`;
   default-resource merge).

`@sentry/opentelemetry@10.x` peers `^1.30.1 || ^2.1.0` for core /
sdk-trace-base, so the Sentry co-ownership wiring is unchanged. No other
in-repo OTel call sites exist (verified: the four files above are the whole
surface; `packages/metric-cost-api`'s `ExportResult` / `ExportResultCode`
imports are still exported by core 2.x).

**Proof.** This group touches no datastore-client boundary the works-after
harness covers; the proof is full CI at the named commit (the works-after
`proof` context still runs the real harness via the manifest/lockfile path
filter). Local at the new pins: otel-bootstrap contract 5/5,
metric-cost-api 30/30, root `tsgo --noEmit` clean, eslint clean.

**Rollback.** Revert the lane commit (manifests + lockfile + the four code
files move together). No persisted-state migration: span export is
append-only rows in `cinatra.traces`; the `parentSpanId` column shape is
unchanged.

---

## 11. Refresh 2026-07-18 — Renovate revival: org-wide bot-managed major backlog (upgrade-track input)

Renovate resumed org-wide. The routine patch/minor bot PRs are triaged on their
own weekly window and are out of scope here. The MAJOR / breaking bumps below
are recorded as **upgrade-track input** — the *org-wide bot-managed major
backlog* capture the inventory pass calls for. These ride their own managed
Renovate / Dependabot backlogs and are **not** merged as part of this ledger;
they are captured here for cross-reference plus the works-after /
obsolete-workaround signal. Grounded against live `main`, 2026-07-18.

### 11.1 TypeScript → `7` — org-wide, GATED (state unchanged from §8.1)

This repo already carries TypeScript 7 as an **offered-but-gated** stack major
(§8.1): it pins `typescript: "^6.0.3"` and the latest-stable bar is
`typescript@7.0.2`. The revival surfaces the **same gate** as bot PRs on the
connectors that pin their own `typescript` — all RED with one shared root cause:
`@typescript-eslint/parser@8.63.0` peers `typescript ">=4.8.4 <6.1.0"`, so
`typescript@7` cannot resolve until typescript-eslint ships a TS-7-compatible
peer range (the identical gate §8.1 records for this repo):

- `drupal-mcp-connector#68`, `github-connector#51`, `nango-connector#49`,
  `wordpress-mcp-connector#75`.

**PARKED** (unchanged): record the target, wait for a TS-7-aware
typescript-eslint line, then re-drive the coupled group (`typescript` +
`@typescript-eslint` + the `eslint-config-next` / `next` toolchain) together at
each member's latest stable through the works-after / named-commit CI gate.
**Obsolete-on-upgrade:** adopting stable `typescript@7` drops the
`@typescript/native-preview` devDependency (§8.1) and re-checks the ESLint-10
`settings.react.version` workaround (§4.5).

### 11.2 `@types/node` `^22` → `^24` — platform ALREADY CURRENT; connector backlog only

**No platform-repo delta.** This repo already pins `@types/node: "^24.13.2"` and
builds/runs on `node:24-alpine` (§1), so it is already at the `^24` bar. The
`^22 → ^24` bump is a **connector-repo** currency item (e.g.
`youtube-connector#49`, reported CI-green) that pairs with each connector's own
Node-24 runtime move; it rides the managed backlog. Recorded here only so a
reader does not re-chase it for this repo.

### 11.3 `actions/checkout` `4` → `7` — org-wide GitHub Actions major (batch-decidable)

The revival surfaced `actions/checkout` v7 across the connector / agent /
artifact repos: one Action major to decide once, then batch (~64 mergeable PRs;
the 2 archived repos cannot merge and are skipped). Note: `actions/checkout` v5+
**drops the Node 20 action runtime → Node 24**, so the batch decision is coupled
to the Node-24 runner baseline. This repo's OWN GitHub-Actions majors are
Dependabot-grouped (the actions-group PR) and are tracked separately from this
Renovate batch. CI-workflow currency only — no datastore / stack pin delta.

### Net for this repo

The 2026-07-18 revival adds **no new platform-repo pin delta**: TypeScript 7
stays parked on the typescript-eslint gate (§8.1), `@types/node` is already at
`^24`, and `actions/checkout` v7 is CI-workflow currency on its managed backlog.
The disruptive datastore / stack majors remain owned by their own staged lanes,
each gated by the per-service works-after proof (§6, §7, §9).

---

## 12. Renovate ↔ upgrade-matrix digest pairing (cinatra#1863)

The pin-drift check (§ "pin-drift", `scripts/check-upgrade-matrix.mjs` check #4,
run live via `scripts/ci/__tests__/upgrade-matrix.test.mjs`) asserts every
`services[].baselinePin.image` and every `coupledAppImages[].image` in
`config/upgrade/upgrade-matrix.json` equals the resolved image string in
`docker-compose.yml`. Renovate's docker manager bumps the compose
`@sha256:` digests every weekly wave but does **not** know about the matrix, so
before this pairing each matrix-tracked digest bump was **born red** and the
weekly digest batch stalled until a human hand-authored the matching matrix
digests in a paired sync PR (the toil §2/§8/§9 kept re-doing by hand).

**Mechanism (repo-root `renovate.json`, `customManagers[0]`).** A regex custom
manager registers each matrix pin under the **same** docker datasource +
`depName` + `currentValue` + `currentDigest` that the compose docker manager
derives from the same image. Renovate treats it as the same dependency in a
second file, so the digest update rides the **same branch/PR** as the
`docker-compose.yml` bump — the matrix pin is refreshed in lockstep, atomically,
with no manual sync and no bot commit onto the Renovate branch. The pairing
lives in the **repo-root** config (not the shared org preset
`local>cinatra-ai/.github:renovate-config`) because the upgrade-matrix file is
repo-local — only this repo carries it.

Details that make it robust:

- **The sibling `digest` field stays in sync.** Each pin records the digest
  twice — inside `image` (`…@sha256:X`) and in the redundant `"digest": "sha256:X"`
  field. The `matchStrings` regex spans the image string **through** that sibling
  `digest`, so Renovate's default global auto-replace (`autoReplaceGlobalMatch`)
  rewrites **both** occurrences of the old digest in one update. This relies on
  the object field order `image`, `major`, `digest` (the current, consistent
  shape); a reordered object simply fails to match and the gate trips loud on the
  next bump rather than silently half-updating.
- **Digest-only coupling.** A `packageRules` entry scoped to the matrix file
  disables non-`digest` update types there, so a stateful **tag/major** change is
  deliberately **not** auto-paired: the gate still trips and forces a human to
  curate the matrix `major` + `transitions[]` + the works-after proof in one
  reviewable diff (majors ride staged lanes — §6/§7/§9). Only the routine digest
  wave is automated. The rule is scoped to the matrix file, so `docker-compose.yml`
  version currency is untouched.
- **Plane is excluded.** The Plane app images are release-pinned as
  `makeplane/plane-*:${PLANE_TAG:-…@sha256:…}`. Renovate's compose manager
  treats a value with a mid-string `${VAR:-…}` as `contains-variable` and does
  **not** manage it, so the compose plane digests never move via Renovate (they
  are human-curated). A `packageRules` entry excludes `makeplane/**` from the
  matrix manager so a matrix plane pin can never move alone (which would create
  matrix-only reverse drift).

**End-to-end proof arrives on the next digest wave.** The config validates
(`renovate-config-validator`) and a faithful local extract + global-replace
simulation over the real matrix shows every matrix pin pairing to its compose
image with the sibling digest kept in sync and the gate green on a paired bump
(and red on an unpaired one, the old status quo). The definitive proof is the
first Renovate digest PR that lands green without a manual matrix sync.

---

## 13. Refresh 2026-07-28 — npm-major re-grounding: `cron-parser` 5 applied, `node-pg-migrate` 9 BLOCKED

A re-grounding of the §5 / §11 stack-major candidate list against the live npm
registry and the repo's own manifests. Two items moved; both are recorded here
with the works-after evidence the track requires.

### 13.1 `cron-parser` `^4.9.0` → `^5.6.2` — MAJOR APPLIED (`packages/agents`)

`packages/agents` pinned `cron-parser: "^4.9.0"`; the latest stable is `5.6.2`
(the 5 line has been the stable line for some time — this repo was a full major
behind on a PRODUCTION dependency). The sole consumer is the recurring-trigger
arm-time validator in `trigger-service.ts`. `luxon` is already in the tree (the
4 line depends on it too), so the bump adds no new transitive dependency.

**Two breaking changes, both real for this repo:**

1. **The top-level `parseExpression` helper is gone.** The 5 line exposes the
   parser as the `CronExpressionParser` class (also the module default);
   `parse` is a static method. The pre-change validator probed
   `mod.default?.parseExpression ?? mod.parseExpression` and had a fail-closed
   branch returning `{ ok: false, error: "cron-parser unavailable" }` when
   neither resolved. On the 5 line that probe yields `undefined`, so a bare
   dependency bump would have silently refused **every** recurring trigger
   while staying green. Verified directly against the installed package:

   ```
   pre-change resolution on cron-parser 5 -> typeof parseExpression = undefined
   pre-change validator verdict for "0 9 * * MON":
     { ok: false, error: "cron-parser unavailable" }  <-- EVERY recurring trigger refused
   post-change resolution -> typeof CronExpressionParser.parse = function
   ```

2. **Timezone validation moved from `parse()` to the first iteration step.**
   On the 4 line, `parseExpression("0 9 * * MON", { tz: "Not/AZone" })` THREW
   at parse time, so an unknown IANA zone was refused at arm time. On the 5
   line the same call returns a parsed expression and only the first `next()`
   throws (`CronDate: unhandled timestamp: Invalid Date`) — i.e. the bad zone
   would be accepted at arm time and blow up when the schedule first came due.
   The validator therefore takes **one iteration step** as part of validation,
   which restores the arm-time contract.

   The step is deliberately NOT described as a satisfiability check. Iteration
   behaviour was compared expression-by-expression across the two lines, and
   they agree everywhere except that the 5 line's own loop-limit check is
   unreliable: `0 0 31 2,4,6,9,11 *` (day 31 in months that have none — never
   matches) THROWS `Invalid expression, loop limit exceeded` on the 4 line but
   returns a NON-MATCHING date (`2053-12-12`) on the 5 line. So an
   unsatisfiable expression can still pass validation; that is an upstream
   defect on the 5 line, recorded here rather than papered over. Everything a
   caller could legitimately want is unaffected — sparse-but-real expressions
   iterate identically on both lines (`0 0 * 2 1#5` → `2044-02-29`,
   `0 0 29 2 *` → `2028-02-29`), and `0 0 * * L` fails iteration on BOTH lines
   (so nothing schedulable is newly refused; it is merely refused earlier).

**What changed.** The validation stays INSIDE `trigger-service.ts` (the parser
resolution and the iteration step are local to it) — deliberately not extracted
into a helper module, because the route-graph ratchet
(`scripts/audit/route-graph-ratchet.mjs`) is a no-new-rot ceiling and a new
first-party module adds +1 reachable module to five locked routes. Extracting
it was tried first and the ratchet correctly refused it; the sanctioned
`absorbs` raise was NOT used, because growing five route ceilings for a
convenience helper is exactly the pressure that gate exists to resist. Error
strings and their ordering are unchanged.

**Works-after proof.** The branch that covers this path in the existing suites
lives in `trigger-handlers.integration.test.ts`, a DB-backed
`*.integration.test.ts` file: the default unit run excludes it and CI skips the
integration step when no test database is provisioned — so the unit tier could
not have caught either breaking change. This lane closes that hole with
`packages/agents/src/__tests__/trigger-service-cron-validation.test.ts`, which
drives the REAL `setRunTriggerForActor` against the REAL `cron-parser`
(deliberately unmocked — only the run read, the store/schedule writes and the
PM bridge are stubbed, so it needs no database) and pins: a 5-field expression,
a macro expression, an explicit IANA zone, an **unknown zone**, an unparseable
expression, an out-of-range field, the missing/over-long guards, an explicit
assertion that the fail-closed `cron-parser unavailable` verdict does not
occur, and that a failed validation writes neither a trigger row nor a
schedule. It runs in the DEFAULT unit run — i.e. inside the existing required
`Unit tests (packages/agents)` CI step — so the next `cron-parser` major cannot
repeat either failure silently. Locally: 9/9 on the new file, `packages/agents`
unit tier green, route-graph ratchet OK, root `tsgo --noEmit` clean, eslint
clean on the touched files.

**Rollback.** Revert the lane commit (manifest + lockfile + the two source
files move together). No persisted state: the validator is a pure arm-time
check; already-armed schedules are untouched.

**Obsolete-on-upgrade check (§4).** Nothing is retired by this bump — no patch,
override, `allowBuilds` entry or code workaround was tied to the 4 line. The
`cronstrue` humanizer (a separate package) is unaffected.

### 13.2 `node-pg-migrate` `8.0.4` → `9.0.0` — offered, GROUNDED, and BLOCKED

`node-pg-migrate` 9 is published and is a genuine offered major (the Renovate
dashboard lists it). It was taken through a real candidate build in this lane
and **it cannot land**: the 9 line's migration-file loader is incompatible with
this repo's namespaced migration filenames, and there is no configuration
escape hatch.

**The incompatibility.** Migration modules here are namespaced by design (the
shared-ledger scheme): `migrations/core/core__NNNN_short-description.mjs`, and
extension migrations record as `ext_<scope>_<pkg>__NNNN`. The 8 line derived a
file's sort key with `filename.split("_")[0]`, and when that was not numeric it
logged a benign error and **returned 0** — every file compared equal, so the
loader fell through to its locale-numeric comparator and sorted correctly.
(That fall-through is load-bearing today: `buildRunnerLogger` in
`packages/migrations/src/core-migrations.mjs` explicitly suppresses the 8
line's `Can't determine timestamp for ` message.) The 9 line replaced that with
a fail-closed `/^(\d+)/` match on the filename that **throws** when the name
does not START with digits — and both loader branches (directory scan AND the
glob branch) route through the same comparator, so `useGlob` does not avoid it.
A candidate run reproduced it exactly:

```
Error loading migration files: Cannot determine numeric prefix for "core__0002_drop-agent-templates-durable.mjs"
ERROR: candidate core migration chain failed against the upgraded database.
```

(from `scripts/ci/upgrade-proof.sh` against the last published release image on
`postgres:18-alpine`: the previous-release schema provisioned, the candidate
bootstrap DDL applied 825/825, then the candidate chain failed at LOAD before
executing a single migration.)

**Why renaming is not the answer.** The `core__` / `ext_<scope>_<pkg>__`
prefixes are the ledger namespace: the name is what `pgmigrations.name` stores
for every already-applied migration on every existing deployment, and it is
enforced by `CORE_MIGRATION_FILE_RE` plus the schema-migration audit gate.
Renaming would orphan every ledger row and break the per-namespace down-fence.

**PARKED** on the same shape as the TypeScript 7 entry (§8.1/§11.1): record the
target, and lift when upstream restores a non-throwing sort key for files
without a numeric prefix (or exposes a pluggable comparator / sort-key option
alongside the loader strategies the 9 line introduced). The pinned 8.0.4 stays;
re-drive the hop through `scripts/ci/upgrade-proof.sh` at that point — it is
the works-after gate for this dependency, and it caught this cleanly.

### 13.3 Net for this repo

Re-grounded against the live registry, the platform manifests are otherwise at
their latest stable major: `next` / `eslint-config-next` 16, `react` /
`react-dom` 19, `eslint` 10, `vitest` 4, `vite` 8 (held — §4.2), `drizzle-orm`
0.45.2 and `pg` 8.22.0 at the top of their lines, `bullmq` 5, `ioredis` 5,
`zod` 4, `tailwindcss` 4, `@modelcontextprotocol/sdk` 1, `@opentelemetry/*` 2
(§10), `undici` 8, `tar` 7, `knip` 6, `node` 24 (image + `@types/node` 24,
runtime-coupled — do not lead the image), `pnpm` 11. `typescript` stays at the
standing peer ceiling (§8.1/§11.1). Remaining offered npm majors NOT taken in
this lane, each recorded for its own staged lane: `jsdom` 29 → 30 (test
environment; published 2026-07-27), `pdfjs-dist` 5 → 6 (coupled with
`react-pdf` — re-check its peer range first), `react-dropzone` 15 → 19 (four
majors published inside one week upstream; let the line settle),
`libnpmpublish` 11 → 12 and `pacote` 21 → 22 (the registry/publish path —
proof is the publish round-trip), and `node-pg-migrate` 9 (blocked, §13.2).
Image-side majors remain as recorded in §1: the profile-gated demo images
(mariadb 12, wordpress 7, rabbitmq 4, valkey 9, and the Twenty/Plane postgres
and redis pins) are upstream-dictated and tracked, not led; `tailscale` stays
held on the upstream fix (§1); `php` 8.5 for the Drupal image was the one
non-demo image major still open — **it is now applied (§14)**, so no non-demo
image major remains open.

---

## 14. `php` `8.3-apache` → `8.5-apache` (Drupal companion image) — MAJOR APPLIED

cinatra#2165. `docker/drupal/Dockerfile` moves from the floating tag
`php:8.3-apache` to `php:8.5-apache@sha256:eacc0d98992683cb46e4f8f44b2418a0323855dc8b59d32dc54f7a9b90a966dd`
(8.5.8-apache-trixie). This closes the last non-demo image major on the track
and simultaneously closes a pin-drift hole: the previous reference was a bare
tag that moved on every pull. The pin is the top-level multi-arch OCI **index**
digest (the image is a genuine multi-arch index, unlike the amd64-only
nango-server of §2), so it stays portable across arm64 dev and amd64 CI. Both
the 8.3 and 8.5 lines are already `debian:trixie-slim`-based, so this is a PHP
major only — no distribution hop rides along.

### 14.1 The one real breaking change: OPcache can no longer be built shared

The bump's first failure was not Drupal and not the contrib set — it was the
image's own extension step:

```
Installing shared extensions:     /usr/local/lib/php/extensions/no-debug-non-zts-20250925/
cp: cannot stat 'modules/*': No such file or directory
make: *** [Makefile:89: install-modules] Error 1
ERROR: process "/bin/sh -c docker-php-ext-configure gd … && docker-php-ext-install gd pdo pdo_mysql zip opcache" did not complete successfully
```

Upstream php-src made OPcache **static-only**. `ext/opcache/config.m4` now
declares `PHP_NEW_EXTENSION([opcache], …, [no], …)` where the 8.3 line passed
`$ext_shared`, so a `phpize` build emits no `modules/*.so` and
`docker-php-ext-install opcache` has nothing to copy. Confirmed by reading both
lines' `config.m4` inside the two base images.

Nothing is lost by dropping the argument. The official image **already compiles
OPcache in and enables it** — on 8.3 as well as 8.5:

```
php:8.5-apache → php -v … "with Zend OPcache 8.5.8"
                 opcache.enable => On ; extension_loaded("Zend OPcache") => true
php:8.3-apache → php -v … "with Zend OPcache 8.3.32" ; opcache.enable => On
```

So the old `opcache` argument was building a redundant second copy on 8.3 too.
The Dockerfile now ends that RUN with an explicit assertion
(`extension_loaded("Zend OPcache") && ini_get("opcache.enable")`) so a future
base-image change that silently drops OPcache fails the BUILD instead of
quietly degrading the entrypoint's `opcache.revalidate_freq=0` /
`validate_timestamps=1` dev ini. Because OPcache is built in on 8.3 as well,
**rollback is still just the `FROM` line** — reverting it alone yields a
working image.

`composer:2` and the contrib set re-confirmed on the new base, as the issue
required: composer 2.10.0 resolved `drupal/recommended-project:^11` →
`drupal/core 11.4.4`, `drush/drush 13.7.6`, `drupal/paragraphs 1.21.0`,
`drupal/tool 1.0.0-beta2`, `drupal/mcp_tools 1.0.0-beta18`, and the image's own
`test -d …/mcp_tools`/`paragraphs` + `drush --version` assertion passed.

### 14.2 Obsolete-on-upgrade check (§4) — the mcp_tools patch, honestly

The issue's expected verdict was that
`docker/drupal/patches/mcp_tools-audit-logger-strtolower.patch` **survives** the
image move because it is tied to the contrib module, not to PHP. That prediction
is correct about the mechanism, and the recorded obsoleted-by condition has
**separately come true**: `drupal/mcp_tools` `1.0.0-beta18` already ships

```php
// AuditLogger.php:136 (upstream, unpatched checkout)
$lowerKey = strtolower((string) $key);
```

so the entrypoint's grep-guarded applier finds no `strtolower($key)` and logs
nothing — on the 8.5 candidate **and on an 8.3 control build of the pre-change
Dockerfile** (`Applying mcp_tools …` appears 0 times in both boots). The same is
true of the sibling `ContentAnalysisService` `date()` applier: beta18 already
casts `(int)` at every call site. Two consequences, both recorded rather than
acted on here:

- the patch was **not** retired by the image move, so this lane does not drop it
  (per the issue's instruction);
- it is inert against the currently-resolved contrib version. The contrib
  requirement is an unpinned `"drupal/mcp_tools:^1.0"` under
  `minimum-stability: dev`, so an older beta can still resolve in principle and
  the applier is a cheap, idempotent guard. Retiring it belongs to a contrib
  **pinning** decision, not to this image bump. The `.patch` file's header path
  (`modules/mcp_tools_content/src/Service/AuditLogger.php`) is additionally
  stale — beta18 keeps the class at `src/Service/AuditLogger.php`, which is the
  path the entrypoint (correctly) targets.

### 14.3 Works-after proof

**The gate now actually fires.** `.github/workflows/wp-drupal-uat.yml`'s
`relevant` paths filter did **not** list the Drupal companion image or its
entrypoint, so a PR rebuilding the container the suite boots against fast-passed
the hard gate — the same misleading-green shape as cinatra#1919 / cinatra#2036.
`docker/drupal/**` and `scripts/drupal-entrypoint.sh` are now in the filter and
pinned by the coverage regression test
(`src/lib/__tests__/wp-drupal-uat-paths-filter-coverage.test.ts`), so this bump
gates itself and so does every future one. (The symmetric WordPress-side gap —
`docker/wordpress/**` — is recorded here for its own lane rather than widened
silently in an image-bump PR.)

**Local proof, run against the rebuilt image with an 8.3 control alongside.**
Both stacks were brought up from the repo's own entrypoint, config-sync, seed
fixtures and bind-mounted `cinatra` module, against `mariadb:11.4`:

| Check | 8.5 candidate | 8.3 control (pre-change Dockerfile) |
|---|---|---|
| Image build | green | green |
| Entrypoint bootstrap to `Bootstrap complete` | yes (17 log stages) | yes (17 log stages) |
| Drupal install / content types / paragraphs / mcp_tools / German / config import / `cinatra` module enable / config export / seed | all executed; 3 fixture nodes | identical |
| `drush pm:list` shows `cinatra`, `mcp_tools`, `mcp_tools_remote`, `mcp_tools_content`, `paragraphs` enabled | yes | yes |
| MCP `initialize` + `tools/list` on `/_mcp_tools` | 200, **29 tools** | 200, **29 tools**, byte-identical tool set |
| MCP content op — `mcp_create_content` | `success: true`, node created | — |
| MCP content op — `mcp_update_content` (the AuditLogger path the patch targets) | `success: true`, `fields_updated: [title, body]`, `revision_id 5` | — |
| DB read-back of the updated node via `drush php:eval` | title + body + published state all persisted | — |
| `mcp_tools_get_recent_content` (the `date()` applier's path) | correct `created`/`changed` timestamps | — |
| HTTP surface `/`, `/node/1`, `/node/4`, `/user/login`, widget JS asset | all 200 | 200 |
| Distinct Drupal `php`-channel watchdog message classes | 1 (`mkdir(): Permission Denied` from the dev container's non-writable `sites/default`) | **the same 1** — pre-existing, not introduced |
| PHP deprecations with `error_reporting=E_ALL` | 1 class: `assert.active INI setting is deprecated`, emitted by `symfony/error-handler`'s `ini_set('assert.active', 1)` | **the same 1** — already present on 8.3, so the bump adds **zero** new deprecations |

The `config:import had errors` warning (`Site UUID in source storage does not
match the target storage` + `mcp_tools_servers.settings` depending on an
uninstalled extension) appears identically in both boots: it is a from-scratch
install property of the checked-in `config/sync`, which the entrypoint already
treats as non-fatal, not a bump regression.

**The Drupal module is 8.5-clean, and now says so in its own CI.**
`cinatra-ai/drupal-module` is the code that runs *inside* this image, and its
gates only ever exercised 8.3. Under 8.5 it is clean today — `php -l` over every
`.php`/`.module`/`.install`, the standalone preview-auth harness (53 checks, 0
failures), `phpcs` (Drupal + DrupalPractice) and `phpstan` with
`phpstan-deprecation-rules` all pass, and no implicit-nullable parameter
declaration (the PHP 8.4 deprecation that bites Drupal contrib hardest) exists in
the tree. A companion PR on that repo adds an additive PHP 8.5 job so the claim
is CI-enforced rather than asserted once. **Canonical order: the module PR lands
first, this image PR second.**

**Rollback.** Revert the `FROM` line (see §14.1 — OPcache is built into the 8.3
base too, so the extension-list change needs no accompanying revert) and rebuild
the `drupal` service.
