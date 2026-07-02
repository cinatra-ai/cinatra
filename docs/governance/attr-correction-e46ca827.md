# Attribution-record correction — e46ca827 (28px lg page-header title)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `e46ca827ea9d150ed4addfebc14cfc1121458d6b`
("feat(design): reduce default (lg) page-header title from 38px to 28px (#800)"),
which the post-merge `truthful-attribution-gate` failed on: the squash body
carried the `Assisted-by` records but the **machine verification arm was
omitted**.

## What landed

e46ca827 (PR #862) reduces the default (lg) page-header title from 38px to 28px
per the ratified typography spec, threading the size through the shared
`PageHeader` in `@cinatra-ai/sdk-ui` and the app twin:

- `packages/sdk-ui/src/page-header.tsx` + `src/components/page-header.tsx`: the
  lg title lane drops to 28px.
- `src/components/app-shell.tsx` + `src/components/marketplace-detail-header.tsx`:
  consuming sites aligned.
- `src/app/globals.css`: the page-title token values.
- `tests/e2e/design/__screenshots__/design-fixtures-{dark,light}.png`: refreshed
  visual baselines.

## Non-high-risk classification

None of the changed files matches a high-risk glob in `.github/gate-suite.json`
`highRiskPaths`: they are sdk-ui/app component files, a global stylesheet, and
e2e screenshot baselines — none live under `**/auth/**`, `**/permissions/**`,
`**/session/**`, `**/migrations/**`, `.github/**`, `packages/sdk-extensions/**`,
the extension trust/registry trees, or the release/publish-script set.

## Resolution

The change is non-high-risk, and on the reviewed head
`f224b527d073a6cfc64e9d3c77b8db1c5929c707` every branch-protection-required
context and both gate-suite `requiredContexts` (`source-leak-gate`,
`truthful-attribution-gate`) concluded success. The only non-green check was
the non-required advisory `/design-fixtures pixel-diff + axe` job, which failed
at its "Wait for /design-fixtures readiness" boot step — it never reached image
comparison, and it currently fails at that same step on every recent PR across
unrelated branches (a repo-wide advisory-job breakage, tracked separately); the
pixel-diff + axe verification for this change ran locally against a
CI-equivalent standalone production render, as recorded in the PR. The machine
arm is therefore the correct and sufficient verification for this merge; it was
simply omitted from the squash body. This note records that forward correction;
the corrective squash carries the machine arm below.
