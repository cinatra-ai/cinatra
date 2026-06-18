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

## Other scripts

- `sync-dev-extensions.mjs` — clones the companion extension repos back into the
  git-ignored in-tree `extensions/` (CI runs `--pinned`).
- `upgrade-proof.sh` — previous-release → current-checkout operator upgrade proof.
- `prod-boot-e2e.sh` — production image cold-boot smoke.
- `prune-extensions-to-required.mjs`, `extension-pin-divergence-report.mjs`,
  `assert-generated-maps-omit.mjs` — extension-universe maintenance helpers.
