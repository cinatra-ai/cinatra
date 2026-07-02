# Attribution-record correction — 3a1e506f (type/tracking/badge token scale)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `3a1e506f995b877ac9fc8e557f159546f266e03b`
("feat(design): tokenize the type/tracking/badge scale into named @theme tokens
(#801)"), which the post-merge `truthful-attribution-gate` failed on: the
squash body carried the `Assisted-by` records but the **machine verification
arm was omitted**.

## What landed

3a1e506f (PR #870) tokenizes the typography scale into named `@theme` tokens in
`@cinatra-ai/design` and migrates the repo-owned consumers onto them:

- `packages/design/src/{theme,tokens,utilities}.css`: named type-scale
  (`text-page-title-*`, `text-listing-title`, `text-badge-*`), tracking
  (`tracking-title-tight`, `tracking-kicker*`, `tracking-page-label`) and badge
  tokens; `.section-kicker` made token-driven.
- `packages/sdk-ui/src/{page-header,extension-card}.tsx` +
  `packages/sdk-ui/src/lib/utils.ts`: shared components consume the tokens
  (sdk-ui `cn` extended with the token class-groups).
- App/package consumer sites (`src/components/**`, `src/app/**`,
  `packages/{agents,mcp-server,notifications}/src/**`) normalized onto the
  named tokens; component tests updated.
- `src/components/ui/{command,sidebar}.tsx`: vendored-primitive class updates.
- `tests/e2e/design/__screenshots__/design-fixtures-{dark,light}.png`:
  refreshed visual baselines.

## Non-high-risk classification

None of the changed files matches a high-risk glob in `.github/gate-suite.json`
`highRiskPaths`: they are design-package stylesheets, sdk-ui/app component
files (the vendored `src/components/ui/**` primitives are not a high-risk
tree), package UI files, tests, and screenshot baselines — none live under
`**/auth/**`, `**/permissions/**`, `**/session/**`, `**/migrations/**`,
`.github/**`, `packages/sdk-extensions/**`, the extension trust/registry trees,
or the release/publish-script set.

## Resolution

The change is non-high-risk, and on the reviewed head
`f1954ceb291ab9857fdd8e2dab915866cf9a8b24` every branch-protection-required
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
