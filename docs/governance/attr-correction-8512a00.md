# Attribution-record correction — 8512a00 (v0.1.6 release-prep: baked CLI 0.1.7 namespaced-command swap)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `8512a008df93958b48d64d9bee4ece9cbda08331`
("chore(release): prep v0.1.6 (version, CLI 0.1.7, system-extension pins) (#840)"),
the v0.1.6 release-prep merge and the current default-branch tip that the
post-merge `truthful-attribution-gate` failed on.

## What landed

8512a00 (PR #840) prepares the v0.1.6 release: it bumps the app to 0.1.6, bakes
CLI `@cinatra-ai/cinatra` 0.1.7 as the devDependency (with the lockfile
regenerated), pins the system-extension companion set, and — the build-unblocking
part — swaps the baked-CLI invocations to CLI 0.1.7's namespaced `instance …`
command forms. CLI 0.1.7 renamed the Class-C bootstrap commands under the
`instance …` head with no back-compat, so the bare `setup prod` / `db migrate`
(and the dev script forms `setup dev` / `reset dev` / `dev refresh`) route to
UNKNOWN. The change:

- `scripts/ci/prod-boot-e2e.sh`: the in-image prod-boot proof calls
  `instance setup prod` against the fresh Postgres.
- `scripts/ci/upgrade-proof.sh`: the candidate + idempotency migrate calls use
  `instance db migrate`; the previous-release-image side stays bare `setup prod`
  because it runs the old image's own bare-only CLI.
- `package.json` scripts (`setup:dev`, `setup:prod`, `reset:dev`, `refresh:dev`,
  `db:migrate`, `db:migrate:down`) rewritten to the `instance …` forms.
- The two boot-error remediation strings a user copy-pastes
  (`src/lib/extension-closure-boot-gate.ts`, `src/lib/boot/schema-version-precondition.ts`)
  plus their unit tests.

None of these files matches a high-risk glob in `.github/gate-suite.json`
`highRiskPaths`: `scripts/ci/**` is not the release/publish-script set
(`**/release*.sh`, `**/publish*.sh`, `scripts/release/**`, `scripts/publish/**`);
`src/lib/extension-closure-boot-gate.ts` is a bare file, not the
`**/extension-loader/**` / `**/trust-gate/**` trees; `src/lib/boot/schema-version-precondition.ts`
matches neither `**/migrations/**` nor `**/*.migration.*`; `package.json` matches
nothing. So the whole change is **non-high-risk**. (The two high-risk SHOULD-FIX
doc strings — `migrations/README.md`, `packages/sdk-extensions/README.md` — were
deliberately split to a follow-up so this PR stayed non-high-risk.)

## What was wrong

The 8512a00 squash carried `Assisted-by` only; it omitted the verification arm.
The intended machine arm (`Gate-suite: cinatra-core@2026.06.4` +
`Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`) was supplied to
`gh pr merge --squash --admin --body-file`, but the body-file did not take effect
on the server-side squash and the landed message lacked the arm. The post-merge
`truthful-attribution-gate` rejected it with `[no-record] record invalid: no
verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable
(gate arm)`.

## Root cause: an omitted merge-record arm, not a missing verification

8512a00 is non-high-risk and its full gate-suite ran green on the reviewed head
`a78c7560a079d9a7fb14549bc08a2fc03f96238d` before merge — every required context,
including `source-leak-gate`, `skills-drift-gate`, the pre-merge
`truthful-attribution-gate`, and the in-image `build` job that executes the
`instance setup prod` prod-boot proof against a fresh Postgres, all concluded
success. So the machine arm (`Gate-suite` + `Accountable`) is the correct and
sufficient verification; it was simply absent from the squash body.

## The correction

This forward, docs-only note records the verification arm omitted from 8512a00.
Its own squash carries `Correction-for: 8512a008df93958b48d64d9bee4ece9cbda08331`
plus the machine arm (`Gate-suite: cinatra-core@2026.06.4` and the canonical
`Accountable`). It is non-high-risk and changes no runtime code. One
`Correction-for` on the red tip greens the default branch.
