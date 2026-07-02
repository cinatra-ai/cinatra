# Attribution-record correction — 729d9b11 (SectionHeader/Kicker component)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `729d9b1121bf1547726c5577afe93b264deb4b35`
("feat(sdk-ui): SectionHeader/Kicker — canonical section-header + mono-kicker
component (#802)"), which the post-merge `truthful-attribution-gate` failed on:
the squash body carried the `Assisted-by` records but the **machine
verification arm was omitted**.

## What landed

729d9b11 (PR #876) adds the canonical `SectionHeader`/`Kicker` component pair
to `@cinatra-ai/sdk-ui`:

- `packages/sdk-ui/src/section-header.tsx` (+ `marketplace.ts`, `index.ts`,
  `package.json` subpath export, `AGENTS.md` doc): the token-driven uppercase
  mono kicker (xs/sm sizes, kicker/wide/label tracking lanes) and the composed
  section header (sm/md/lg titles, optional description/actions).
- `packages/agents/src/pages.tsx` + `packages/skills/src/plugin-pages.tsx`
  (+ `packages/skills/package.json`): the two in-repo hand-rolled kicker
  bypass sites adopt the component.
- `src/app/design-fixtures/new-component-placeholders.tsx` +
  `tests/e2e/design/__screenshots__/design-fixtures-{dark,light}.png`: fixture
  row + refreshed baselines.
- `pnpm-lock.yaml`: workspace-internal lockfile follow-through.

## Non-high-risk classification

None of the changed files matches a high-risk glob in `.github/gate-suite.json`
`highRiskPaths`: they are sdk-ui/package UI component files, a design-fixtures
page, screenshot baselines, package manifests, and the pnpm lockfile
(dependency manifests/lockfiles are not a high-risk class) — none live under
`**/auth/**`, `**/permissions/**`, `**/session/**`, `**/migrations/**`,
`.github/**`, `packages/sdk-extensions/**`, the extension trust/registry trees,
or the release/publish-script set.

## Resolution

The change is non-high-risk, and on the reviewed head
`01886bf43f164025c6d8d48e7692b65496fc82a5` every branch-protection-required
context and both gate-suite `requiredContexts` (`source-leak-gate`,
`truthful-attribution-gate`) concluded success. The only non-green check was
the non-required advisory `/design-fixtures pixel-diff + axe` job, which failed
at its "Wait for /design-fixtures readiness" boot step — it never reached image
comparison, and it currently fails at that same step on every recent PR across
unrelated branches (a repo-wide advisory-job breakage, tracked separately); the
squash records a CI-equivalent standalone production render passing pixel-diff
+ axe on both themes locally. The machine arm is therefore the correct and
sufficient verification for this merge; it was simply omitted from the squash
body. This note records that forward correction; the corrective squash carries
the machine arm below.
