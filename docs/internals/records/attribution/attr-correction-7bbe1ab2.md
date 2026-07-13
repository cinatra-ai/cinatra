# Attribution-record correction — 7bbe1ab2 (README Quick start / Inside the app rewrite)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `7bbe1ab2179477bfaefa7148682d6a25115546be`
("docs(readme): rewrite Quick start to the cinatra CLI; refresh Inside the app
(#830)"), which the post-merge `truthful-attribution-gate` failed on: the
squash body carried the `Assisted-by` records but the **machine verification
arm was omitted**.

## What landed

7bbe1ab2 (PR #900) rewrites the root `README.md`: the Quick start section now
leads with `npx @cinatra-ai/cinatra install` (the published cinatra CLI)
instead of `git clone` + `make setup` + `make dev`; the Connect an LLM,
Troubleshooting, and What belongs in this repo vs elsewhere sections are
removed; the WordPress/Drupal GPL sentence is removed from License; and Inside
the app is refreshed against the current sidebar, Dashboards, and Configuration
surface. `README.md` is the only file the PR touches.

## Non-high-risk classification

`README.md` does not match any high-risk glob in `.github/gate-suite.json`
`highRiskPaths`: it is not under `**/auth/**`, `**/permissions/**`,
`**/session/**`, `**/webhooks/**/verify*`, `**/secrets/**`, `**/migrations/**`,
`.github/**`, `**/gate-suite.json`, `packages/sdk-extensions/**`, or any of the
extension trust/registry trees. A root README edit is a plain docs change.

## Resolution

The change is non-high-risk and its full gate-suite ran green on the reviewed
head `9b8d29d686d8146284ca6d644c971cdcb0e2be18` (every required context
concluded success — including source-leak-gate, truthful-attribution-gate
(pre-merge), doc-code-value-gate, rename-gate, secrets-required-gate,
ui-design-system-gate, uat-gate, the RBAC authz + browser e2e suites, the
Playwright /agents and Workflows browser e2e suites, Release workflows tests,
and CodeQL). The machine arm is therefore the correct and sufficient
verification for this merge; it was simply omitted from the squash body. This
note records that forward correction; the corrective squash carries the
machine arm below.
