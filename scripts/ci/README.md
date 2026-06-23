# `scripts/ci/`

Release-engineering / CI helper scripts. These are run by GitHub Actions
workflows and by maintainers at release-candidate / closeout checkpoints — they
are not part of the application runtime.

## Closeout verification suite

`closeout-suite.mjs` is the **single entry point** for the closeout
generated-artifact drift battery + the standalone static gates a release-closeout
milestone must see green (closeout W3, cinatra#75). Run it instead of remembering
the individual `--check` invocations:

```sh
pnpm closeout:suite                                 # full battery (incl. network design-registry build)
node scripts/ci/closeout-suite.mjs --skip-network   # omit the network-dependent design-registry build
```

It is a **thin aggregator**: it shells out to the existing checks unchanged and
only collects exit codes, prints a summary, and exits non-zero if any member
fails. It never reimplements a check.

Battery members (all are self-contained at a clean checkout):

| Member | Underlying check |
| --- | --- |
| authz-inventory drift | `scripts/build-authz-inventory.mjs --check` |
| extension-manifest drift (canonical) | `scripts/extensions/generate-extension-manifest.mjs --check` |
| extension-manifest drift (self) | `scripts/extensions/generate-extension-manifest.mjs --check --self` |
| write-surface inventory drift | `scripts/build-write-surface-inventory.mjs --check` |
| mutation-result rollout gate | `scripts/audit/mutation-result-rollout-gate.mjs` |
| objects-writer DML drift gate | `scripts/audit/objects-writer-drift-gate.mjs` |
| design-registry drift (`public/r`) | `scripts/extensions/build-design-registry.mjs --check` (needs network: `pnpm dlx shadcn`) |

Use `--skip-network` (or `CLOSEOUT_SKIP_NETWORK=1`) in an offline/sandboxed
environment to omit the design-registry member; it is then reported as
`SKIPPED (network)` rather than silently dropped.

**Out of scope** (intentionally not run here — they need Postgres / Redis /
Docker and are owned elsewhere):

- DB-tier + unit + browser e2e + schema-migration + `node --test` gates →
  the push-event `build-image` workflow (`.github/workflows/build-image.yml`).
- Operator previous-release upgrade proof → `scripts/ci/upgrade-proof.sh`
  (closeout W3, cinatra#74).
- Per-service **works-after** functional proof → `scripts/ci/works-after-proof.sh`
  + `.github/workflows/works-after-proof.yml` (cinatra#352).

## Works-after proof harness

`works-after-proof.sh` is the per-service FUNCTIONAL proof the four existing
harnesses don't cover (cinatra#352, part of the major-version upgrade track).
It brings each env-app service up at a **candidate** version and runs a
real round-trip through (where possible) the repo's OWN client code, asserting
the functional result and failing loud with per-service diagnostics — the
"no env-app/stack major lands without this green" gate.

```sh
pnpm works-after:proof                       # all arms, default = current pins (green today)
WORKS_AFTER_ONLY=redis,nango pnpm works-after:proof   # a subset (fast, single-major lane)
REDIS_TAG=8-alpine pnpm works-after:proof    # exercise a candidate redis major
PG_TO_TAG=18-alpine pnpm works-after:proof   # exercise a candidate postgres major
pnpm works-after:test                        # the fast service-free unit tests
```

The six arms (each a standalone script under `scripts/ci/works-after/`):

| Arm | What it asserts | Candidate env |
| --- | --- | --- |
| `redis` | enqueue → worker runs → completion (3-way: state + returned nonce + worker-written key), via `bullmq` + `ioredis` (the repo deps) | `REDIS_TAG` |
| `postgres` | data survives a documented `pg_dump`/`pg_restore` into a NEW PGDATA volume; the bare same-mount tag bump REFUSES to start (negative). Also runs `upgrade-proof.sh` when `PREV_IMAGE` is set | `PG_FROM_TAG`, `PG_TO_TAG` |
| `nango` | a synthetic connection round-trips byte-equal through the records-DB store + the `@nangohq/node` API contract (create integration → import connection → `setMetadata` → `getConnection`). Hermetic, no egress; the AES-GCM credential envelope is out of scope for the secret-free arm | `NANGO_SERVER_IMAGE` |
| `graphiti` | object projection → store → search round-trip through `graphiti-client.ts`. **Needs a real `OPENAI_API_KEY`** (graphiti does LLM extraction before the Neo4j write, and the image doesn't honor a custom LLM base-URL) — so it is NOT secret-free: it runs in the major lane / `workflow_dispatch` with a key, and SKIPs otherwise | `NEO4J_TAG`, `GRAPHITI_IMAGE`, `OPENAI_API_KEY` |
| `wayflow` | agent execution over A2A (`message/send` → `completed` task, nonce surfaced) using a committed no-LLM echo-flow fixture, building `docker/wayflow` at candidate pins | `PYTHON_TAG`, `WAYFLOWCORE_VERSION`, `PYAGENTSPEC_VERSION` |
| `verdaccio` | publish → install round-trip (mint a throwaway user via the repo's `createNpmUser`, publish `@works-after/proof`, install it back, assert the sentinel), with the real immutability `config.yaml` mounted | `VERDACCIO_TAG` |

Each candidate env defaults to the **current pin**, so a bare run is green on
today's `main`; the major-upgrade lane runs the same script with the new
version(s) set. `WORKS_AFTER_GATE_MODE=1` promotes a SKIP to a FAIL (no false
green when a gate run can't actually exercise an arm). Throwaway crypto/users are
minted per run — **no ops secret, no external OAuth, no private data**.

The harness is wired as a required check via
`.github/workflows/works-after-proof.yml`, which runs the real six-service job
only when an upgrade-relevant path changed (an internal `detect` paths-filter)
and reports a green stub otherwise — so the same required context concludes
`success` on every PR. It is deliberately NOT a `closeout-suite.mjs` member
(that battery is service-free + static).

## Other scripts

- `sync-dev-extensions.mjs` — clones the companion extension repos back into the
  git-ignored in-tree `extensions/` (CI runs `--pinned`).
- `upgrade-proof.sh` — previous-release → current-checkout operator upgrade proof.
- `prod-boot-e2e.sh` — production image cold-boot smoke.
- `prune-extensions-to-required.mjs`, `extension-pin-divergence-report.mjs`,
  `assert-generated-maps-omit.mjs` — extension-universe maintenance helpers.
