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
| postgres (platform) | docker-compose.yml | `postgres:17-alpine` | postgres 18-alpine | platform DB; consolidation + defer per §3 |
| nango-db | docker-compose.yml | `postgres:15-alpine` | postgres 18-alpine | Nango's own DB; the 17/15 spread to reconcile (§3) |
| twenty-db | docker-compose.yml | `postgres:16` | follows Twenty upstream | profile `twenty`; upstream-dictated major, not ours |
| plane-db | docker-compose.yml | `postgres:15.7-alpine` | follows Plane upstream | profile `plane`; upstream-dictated, track don't lead |
| redis (platform) | docker-compose.yml | `redis:7-alpine` | redis 8-alpine | major deferred to its own lane |
| twenty-redis | docker-compose.yml | `redis:7` | redis 8 | profile `twenty` |
| plane-redis | docker-compose.yml | `valkey/valkey:7.2.11-alpine` | valkey 8 | profile `plane`; Plane-dictated |
| neo4j | docker-compose.yml | `neo4j:5.26-community` | neo4j 6 (no Renovate update offered) | graphiti-coupled; hold |
| graphiti | docker-compose.yml | `zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2` | (no update offered) | neo4j-coupled; hold |
| verdaccio | docker-compose.yml | `verdaccio/verdaccio:6` | verdaccio 6.x (no major offered) | dev registry; ephemeral storage |
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
| php (drupal) | docker/drupal/Dockerfile | `php:8.3-apache` | php 8.5-apache | |
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

## 3. Postgres spread decision

Current Postgres pins across the compose: `17-alpine` (platform),
`15-alpine` (nango-db), `16` (twenty-db, profile), `15.7-alpine` (plane-db,
profile). Upstream major target is postgres 18.

**Decision: record the consolidation target, defer the actual image bump.**

- The two cinatra-owned, always-on services — platform `postgres` and
  `nango-db` — get the **consolidation target recorded as postgres 17-alpine**
  (one major), reconciling the 17/15 split. This pass does **not** also jump to
  18: that is a separate major handled by the staged upgrade lane with a
  data/extension-compatibility check.
- `twenty-db` (postgres 16) and `plane-db` (postgres 15.7) are profile-gated and
  their Postgres major is **chosen by Twenty / Plane upstream**, not by us. We
  record their current pin and a target of "follow upstream"; we do **not**
  renumber them onto our major (that would diverge from what those apps test
  and migrate against).

Why defer the bump (the safer choice): a Postgres **major** bump is not a
drop-in `image:` edit. It needs a `pg_upgrade` / dump+restore of the on-disk
`cinatra-postgres` / `nango-postgres` volumes; a bare tag bump against an
existing PGDATA volume makes Postgres refuse to start
(`database files are incompatible with server`). This inventory pass must stay
non-breaking, so it records the target and reconciles the spread rationale here;
the data-migration-bearing image bump is owned by the staged upgrade lane (which
runs it on a non-production environment first, with a restore check) plus the
per-environment upgrade work. Net change to the compose in this pass: **no
`image:` change for Postgres** — only the recorded-target comments on the two
cinatra-owned services pointing here.

---

## 4. Patches / overrides / build-flags / code workarounds (obsoleted-by-version)

### 4.1 `patches/` and `docker/**/patches/`

| Patch | Patches | Why | Obsoleted by version |
|---|---|---|---|
| `patches/@a2a-js__sdk@0.3.13.patch` | `@a2a-js/sdk@0.3.13` dist `parseSseStream` | upstream SSE parser overwrote multi-line `data:` instead of accumulating with `\n`; the patch accumulates | an `@a2a-js/sdk` release that ships the multi-line `data:` accumulation fix upstream. The `patchedDependencies` key embeds the exact version, so every `@a2a-js/sdk` bump must re-key + re-verify or the patch silently stops applying |
| `docker/drupal/patches/mcp_tools-audit-logger-strtolower.patch` | Drupal `mcp_tools_content` AuditLogger `strtolower($key)` | PHP 8 throws a `TypeError` when an `int` array key reaches `strtolower`; the patch casts `(string)` | an upstream `mcp_tools` (Drupal contrib) release that null/int-safes the key. Tied to the contrib module, **not** to the PHP image bump (the php 8.5 bump does not retire it) |

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
| `packages/workflows/src/bpmn/bpmn-moddle.d.ts` | a minimal ambient `.d.ts` because `bpmn-moddle` (v10, exact-pinned `10.0.0`) ships no types | a `bpmn-moddle` release that ships its own TypeScript types (tied to the bpmn-moddle major) |
| `src/app/artifacts/[id]/handlers/pdf-promise-with-resolvers-polyfill.ts` | a `Promise.withResolvers` polyfill for the react-pdf / pdfjs-dist path on older Safari | a **browser baseline** move (Safari 17.4+, Mar 2024) — runtime/browser-version-tied, **not** a dependency upgrade; remove when the supported-browser floor moves past Safari 17.4. Listed for completeness; out of scope for the dependency-majors track |

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

---

## 5. Stack-major candidate list (from the Renovate Dependency Dashboard)

Image / runtime majors offered: postgres 18, redis 8, valkey 8, mariadb 12,
wordpress 7 (plus 6.9), php 8.5, python 3.14, tailscale 1.98 (held — see §1),
rabbitmq 4. npm / toolchain majors offered: ESLint 10, Next 16.x (the
`eslint-config-next` + `next` pair), the React monorepo, `@opentelemetry/*` 2
(deferred per the overrides note), `cron-parser` 5, `pdfjs-dist` 6,
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
