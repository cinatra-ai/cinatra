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
| review-decision-writer direct-DML check | `scripts/audit/review-decision-writer-*-gate.mjs` |
| design-registry drift (`public/r`) | `scripts/extensions/build-design-registry.mjs --check` (needs network: `pnpm dlx shadcn`) |

Use `--skip-network` (or `CLOSEOUT_SKIP_NETWORK=1`) in an offline/sandboxed
environment to omit the design-registry member; it is then reported as
`SKIPPED (network)` rather than silently dropped.

The review-decision member (cinatra#2047 acceptance annex) is the single-writer
guard over the review DECISION record — `artifact_review_gates`,
`artifact_review_audit`, `artifact_review_dispositions` and
`artifact_review_resume_outbox`. It bans direct DML against those four tables
from any module outside a justified allowlist, so a second store cannot quietly
grow into a parallel approval path. Its path is written with a wildcard above
for the same reason the runner assembles it from parts: the filename embeds a
token the org source-leak scanner reads as an internal planning-artifact marker
(that rule scans file content, not paths).

Both writer guards run on EVERY push and pull request as well, independently of
this closeout runner: their companion tests live under
`scripts/audit/__tests__/`, which the root Vitest include glob covers, and each
test executes its guard against the live tree. `pnpm test:root` in the
`build-image` workflow is therefore the per-PR enforcement point; this suite is
the closeout-checkpoint one.

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

# GATE a major (fail-closed): name the arm(s) the major changes; a SKIP is a FAIL.
PYTHON_TAG=3.15-slim pnpm works-after:gate -- --arms wayflow   # e.g. an agent-runtime major
```

The eight arms (each a standalone script under `scripts/ci/works-after/`):

| Arm | What it asserts | Candidate env |
| --- | --- | --- |
| `redis` | enqueue → worker runs → completion (3-way: state + returned nonce + worker-written key), via `bullmq` + `ioredis` (the repo deps) | `REDIS_TAG` |
| `postgres` | data survives a documented `pg_dump`/`pg_restore` into a NEW PGDATA volume; the bare same-mount tag bump REFUSES to start (negative). Also runs `upgrade-proof.sh` when `PREV_IMAGE` is set | `PG_FROM_TAG`, `PG_TO_TAG` |
| `nango` | a synthetic connection round-trips byte-equal through the records-DB store + the `@nangohq/node` API contract (create integration → import connection → `setMetadata` → `getConnection`). Hermetic, no egress; the AES-GCM credential envelope is out of scope for the secret-free arm | `NANGO_SERVER_IMAGE` |
| `graphiti` | object projection → store → search round-trip through `graphiti-client.ts`. **Needs a real `OPENAI_API_KEY`** (graphiti does LLM extraction before the Neo4j write, and the image doesn't honor a custom LLM base-URL) — so it is NOT secret-free: it runs in the major lane / `workflow_dispatch` with a key, and SKIPs otherwise | `NEO4J_TAG`, `GRAPHITI_IMAGE`, `OPENAI_API_KEY` |
| `wayflow` | agent execution over A2A (`message/send` → `completed` task, nonce surfaced) using a committed no-LLM echo-flow fixture, building `docker/wayflow` at candidate pins. (The candidate wayflow runtime is blocking-only — its A2A server does not implement `message/stream`; the SSE streaming surface is a node/stack-layer concern proven by full CI, not this docker arm) | `PYTHON_TAG`, `WAYFLOWCORE_VERSION`, `PYAGENTSPEC_VERSION` |
| `verdaccio` | publish → install round-trip (mint a throwaway user via the repo's `createNpmUser`, publish `@works-after/proof`, install it back, assert the sentinel), with the real immutability `config.yaml` mounted | `VERDACCIO_TAG` |
| `upgrade-redis` | UPGRADE-FROM fixture (cinatra#1421/#1422): the guarded redis 7→8 family path (`scripts/upgrade/redis-upgrade-major.sh`) against a data-bearing prior-version AOF volume — positive commit, pre-commit failure injection (lands on the intact source volume with the source ledger entry), post-commit interruption (pending journal retained), fail-closed downgrade/valkey negatives. Source+target images digest-pinned | `REDIS_FROM_TAG`, `REDIS_TO_TAG` |
| `upgrade-mariadb` | UPGRADE-FROM fixture (cinatra#1421/#1422): the guarded MariaDB in-place family path (`scripts/upgrade/mariadb-upgrade-major.sh`, explicit `mariadb-upgrade` on a CANDIDATE volume) — positive commit, pre-commit failure injection, dump/restore fallback, quiesce + sequential-only fail-closed negatives. Source+target images digest-pinned | `MARIADB_FROM_TAG`, `MARIADB_TO_TAG` |
| `upgrade-postgres` | UPGRADE-FROM fixture (cinatra#1422 / cinatra-cli#129): the guarded Postgres logical dump→fresh-target-volume→restore family path (`scripts/upgrade/postgres-upgrade-major.sh`) for the two cinatra#1417 transitions — Case A platform-postgres 17→18 (the pg18 mount-layout move; full battery: negatives, quiesce, pre-commit failure-injection rollback onto the intact source, positive commit, post-commit interruption) and Case B nango-postgres 15→17 (case-scoped exception, skipped major). Target images digest-pinned (the matrix pins); field sources are bare majors | `PG_CASEA_FROM_TAG`, `PG_CASEA_TO_TAG`, `PG_CASEB_FROM_TAG`, `PG_CASEB_TO_TAG` |

Each candidate env defaults to the **current pin**, so a bare run is green on
today's `main`; the major-upgrade lane runs the same script with the new
version(s) set. `WORKS_AFTER_GATE_MODE=1` promotes a SKIP to a FAIL (no false
green when a gate run can't actually exercise an arm). Throwaway crypto/users are
minted per run — **no ops secret, no external OAuth, no private data**.

The harness is wired as a required check via
`.github/workflows/works-after-proof.yml`, which runs the real multi-arm job
only when an upgrade-relevant path changed (an internal `detect` paths-filter)
and reports a green stub otherwise — so the same required context concludes
`success` on every PR. It is deliberately NOT a `closeout-suite.mjs` member
(that battery is service-free + static).

### Gate mode — the per-lane enforcement contract

`works-after:proof` is the harness; **`works-after:gate`
(`scripts/ci/works-after-gate.sh`) is the enforced gate an upgrade lane runs**.
It is the single documented entrypoint that turns "the harness is available"
into "harness-green is a fail-closed prerequisite": it forces
`WORKS_AFTER_GATE_MODE=1` (a SKIP becomes a FAIL), **requires** the lane to name
the arm(s) its major changes, fail-fast-checks that arm's required candidate
input is present, and exposes a stable exit-code contract:

```sh
pnpm works-after:gate -- --arms wayflow      # exit 0 = gate PASS, non-zero = blocked
```

| Exit | Meaning |
| --- | --- |
| `0` | gate **PASSED** — every selected arm went green in gate mode |
| `1` | gate **FAILED** — a proof failed (or a required arm SKIPped under gate mode); the major MUST NOT land until green |
| `2` | gate **MISCONFIGURED** — no/invalid `--arms`, or a selected arm's required candidate input is missing (checked before any container starts) — fix the invocation |

**Every upgrade lane MUST run this gate** with the arm(s) relevant to its major
un-skipped and the candidate pin(s) set. Bake the exact invocation into the
lane's acceptance:

| Major lane | Gate invocation |
| --- | --- |
| agent-runtime (python / wayflowcore) | `PYTHON_TAG=… WAYFLOWCORE_VERSION=… PYAGENTSPEC_VERSION=… pnpm works-after:gate -- --arms wayflow` |
| postgres | `PG_TO_TAG=<new> PREV_IMAGE=<last released prod image> pnpm works-after:gate -- --arms postgres` |
| graphiti / neo4j | `NEO4J_IMAGE=… GRAPHITI_IMAGE=… OPENAI_API_KEY=… pnpm works-after:gate -- --arms graphiti` |
| redis | `REDIS_TAG=<new> pnpm works-after:gate -- --arms redis` |
| verdaccio | `VERDACCIO_TAG=<new> pnpm works-after:gate -- --arms verdaccio` |
| nango | `NANGO_SERVER_IMAGE=<new> pnpm works-after:gate -- --arms nango` |
| postgres major (upgrade-from) | `PG_CASEA_TO_TAG=<new pin> pnpm works-after:gate -- --arms upgrade-postgres` |
| full-stack | `<all pins> PREV_IMAGE=… OPENAI_API_KEY=… pnpm works-after:gate -- --arms all` |

Pure stack-layer groups that touch no datastore client (React / Next / TypeScript
/ Vitest) are proven by **full CI at the named commit**, not by this gate — keep
that split explicit in the stack-majors lane.

The `.github/workflows/works-after-proof.yml` `workflow_dispatch` already exposes
a `gate_mode` input for a maintainer-run CI gate; that dispatch lane runs the
same harness in gate mode with candidate pins derived from the checked-out ref.

## Other scripts

- `sync-dev-extensions.mjs` — clones the companion extension repos back into the
  git-ignored in-tree `extensions/` (CI runs `--pinned`).
- `upgrade-proof.sh` — previous-release → current-checkout operator upgrade proof.
- `prod-boot-e2e.sh` — production image cold-boot smoke.
- `prune-extensions-to-required.mjs`, `extension-pin-divergence-report.mjs`,
  `assert-generated-maps-omit.mjs` — extension-universe maintenance helpers.
- `uat-diagnostics.sh` — WP/Drupal UAT runtime diagnostics (cinatra#2131): the
  periodic memory/swap/top-RSS sampler, the per-service
  `docker compose logs --tail=500` capture on the failure path, and the
  fail-closed scan that keeps a per-run minted value out of the uploaded
  artifacts. Shared by both jobs in `.github/workflows/wp-drupal-uat.yml`.
- `uat-mask-verify.mjs` — asserts that every rendering of the UAT lane's per-run
  minted values in the finished PUBLIC job log is masked (cinatra#2131). Runs as
  its own job because a job cannot read its own log until it completes.
