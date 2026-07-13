# Attribution-record correction — f1750f18 (client-trust hardening in the web UI)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `f1750f18c93ef56788925a4d2dde5b7b0f4f6292`
("fix(web): harden embed message origin, ?section= selector, and prod error
detail (#890)"), which the post-merge `truthful-attribution-gate` failed on: the
squash body carried the `Assisted-by` records but the **machine verification arm
was omitted**.

## What landed

f1750f18 (PR #890) tightens three client-trust boundaries on client-supplied
input in the web shell and root error boundary, via new pure helpers in
`src/lib/client-trust.ts`:

- `src/components/app-shell.tsx`: the embed message listener now ignores
  cross-frame commands unless the sender origin is same-origin or on a
  configured allowlist (`NEXT_PUBLIC_CINATRA_EMBED_ORIGINS`, exact-match) and the
  sender is the immediate parent frame, before force-submitting the active form;
  the `?section=` param is passed through a sanitizer (a plain `[A-Za-z0-9_-]`
  identifier) before it reaches the inline `<style>` selector, and a
  supplied-but-invalid value fails closed.
- `src/app/global-error.tsx`: the root error boundary suppresses internal error
  name/message/stack in production and shows only the opaque digest.
- `src/lib/client-trust.ts` plus unit tests and component source-guards
  (`src/lib/__tests__/client-trust.test.ts`,
  `src/components/__tests__/app-shell-embed-trust.test.ts`,
  `src/app/__tests__/global-error-detail-gate.test.ts`).

## Non-high-risk classification

None of the changed files matches a high-risk glob in `.github/gate-suite.json`
`highRiskPaths`. In particular: none live under `**/auth/**`,
`**/permissions/**`, `**/session/**`, `src/lib/auth*`, `**/secrets/**`,
`**/migrations/**`, `.github/**`, `**/gate-suite.json`,
`packages/sdk-extensions/**`, or the extension trust/registry trees
(`**/trust-gate/**`, `**/capability-registry/**`, etc.). The changed files are a
new pure helper `src/lib/client-trust.ts`, the `src/components/app-shell.tsx`
shell component, the `src/app/global-error.tsx` boundary, and their tests —
all non-high-risk. (`src/lib/client-trust.ts` is not matched by the `src/lib/auth*`
prefix glob, and `**/trust-gate/**` matches a directory, not a `*-trust.ts`
filename.)

## Resolution

The change is non-high-risk and its full gate-suite ran green on the reviewed
head `9b24c525e5ea561a043521410cb6497f6790c088` (every required context concluded
success — including the typecheck/unit suite, the RBAC authz + browser suites,
the Playwright/agents and workflows e2e, the source-leak, secret-scan,
skills-drift, ui-design-system and Release-workflows gates, and CodeQL). The
machine arm is therefore the correct and sufficient verification for this merge;
it was simply omitted from the squash body. This note records that forward
correction; the corrective squash carries the machine arm below.
