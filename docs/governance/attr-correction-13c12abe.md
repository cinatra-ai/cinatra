# Attribution-record correction — 13c12abe (reconcile "wired but inert" surfaces)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `13c12abeac2dd8213f2db7511c26d70f38e5eeb1`
("fix(inert-surfaces): reconcile wired-but-inert agent-creation pin, retired MCP
tools, drift gate, and default-off flags (#852)"), which the post-merge
`truthful-attribution-gate` failed on: the squash body carried the `Assisted-by`
records but the **machine verification arm was omitted**.

## What landed

13c12abe (PR #891) reconciles four "wired but inert" surfaces — code that was
registered/exposed but dormant, throw-only, or a non-enforcing stub:

- **Surface 1 (dead agent-creation pin):** `isAgentCreationPinActive()` stays
  hardcoded `false` and the dormant subsystem is left untouched, but the inert
  admin surface is hidden — the "Agent creation" row in
  `src/app/configuration/llm/_default-llm-select.tsx` renders only when the pin
  is active, its two `formData.set` calls are gated on it,
  `src/app/configuration/llm/apis-page.tsx` threads the flag, and
  `src/app/campaigns/actions.ts` adds a defense-in-depth server guard so a
  crafted POST cannot persist `agent_creation_*` settings while the pin is inert.
- **Surface 2 (retired MCP tools that threw):** the blog MCP handlers
  (`blog_project_create`, `blog_post_ideas_generate_start`,
  `blog_media_image_save`) and the two `email_outreach_system_*` job use-cases
  now return a typed `not_supported` result instead of throwing. Tools stay
  registered (no authz-inventory or manifest churn; the registry line numbers the
  authz inventory tracks are unchanged), and the `TriggerEmailSendUseCases`
  contract in `packages/trigger-email-send` widens the two return types to a
  `not_supported` union.
- **Surface 3 (non-enforcing drift gate):** `scripts/extensions/inventory.mjs
  --check` lands the real enforcing exit code (real drift, or a
  baseline-present-but-source-absent broken precondition, exits 1; the normal
  no-baseline fresh checkout stays exit 0), with CI-grade enforcement deferred to
  the canonical, fully-populated `extensions/` environment.
- **Surface 4 (dormant flags):** `docs/default-off-flags.md` documents the three
  default-off `CINATRA_*_ENABLED` opt-in gates.

## Non-high-risk classification

None of the twelve changed files matches a high-risk glob in
`.github/gate-suite.json` `highRiskPaths`. The changed files are:
`docs/default-off-flags.md`, `packages/trigger-email-send/README.md`,
`packages/trigger-email-send/src/index.ts`,
`packages/trigger-email-send/src/mcp/handlers.ts`,
`scripts/extensions/inventory.mjs`, `src/app/campaigns/actions.ts`,
`src/app/configuration/llm/_default-llm-select.tsx`,
`src/app/configuration/llm/apis-page.tsx`,
`src/lib/__tests__/trigger-email-send-use-cases.test.ts`,
`src/lib/blog/mcp/handlers.ts`, `src/lib/blog/mcp/registry.ts`, and
`src/lib/trigger-email-send-use-cases.ts`.

In particular: none live under `**/auth/**`, `**/permissions/**`, `**/session/**`,
`src/lib/auth*`, `**/secrets/**`, `**/migrations/**`, `.github/**`,
`**/gate-suite.json`, `packages/sdk-extensions/**`, `scripts/release/**`,
`scripts/publish/**`, or the extension trust/registry trees
(`**/extension-loader/**`, `**/trust-gate/**`, `**/capability-registry/**`,
`**/transport-registry/**`). Note `scripts/extensions/inventory.mjs` lives under
`scripts/extensions/`, which is not matched by `**/extension-loader/**` or
`packages/sdk-extensions/**`; and `src/lib/blog/mcp/*` is not matched by any
registry/trust glob.

## Resolution

The change is non-high-risk and its full gate-suite ran green on the reviewed
head `3bc5e3099614e092418421876fba3139860ff0e2` — every required context
concluded success (the typecheck/unit suite, the RBAC authz + browser suites,
the Playwright/agents and workflows e2e, the Next.js build, the source-leak,
secret-scan, skills-drift, actions-pinned, ui-design-system, and
Release-workflows gates, and CodeQL). The machine arm is therefore the correct
and sufficient verification for this merge; it was simply omitted from the squash
body. This note records that forward correction; the corrective squash carries
the machine arm below.
