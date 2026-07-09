# Attribution-record correction — 6aa0275d (admin-parity P3: catalog/list gate admin standing)

Forward correction (the Truthful Attribution protocol) for the verification
record of squash commit `6aa0275d387e09ddbf588833f252ced19f4fe89e`
("feat(extensions): admin-parity P3 — catalog/list gate admin standing").

## What landed
6aa0275d threads an `orgRole` through the extension discovery scope so the
catalog/list + kind-native discovery gates honor admin standing — keyed on each
row/manifest's own org (cross-org safe) — giving org and platform admins the
same manifest / install-row / workflow-scope visibility as
`hasAdminStandingOverExtension`. It closed cinatra#1128. The PR head had all
required checks green before merge and the change is non-high-risk (no path
matches the high-risk globs).

## What was wrong
The squash body carried a `Gate-suite` machine arm but a MALFORMED `Accountable`
trailer — `Accountable: Sandro Groganz <sandro@cinatra.ai>` — which omits the
required `(@github-handle)` suffix. The truthful-attribution parser rejected it
("malformed Accountable trailer"; "Gate-suite present without Accountable"), so
the landed record resolved to "no verification arm". The work itself was
attributable, non-high-risk, and gate-suite-green; only the Accountable trailer
format was wrong.

## The corrected truthful record for 6aa0275d
The agents + models that materially changed the diff:

- `Assisted-by: Claude Code (claude-opus-4-8)`
- `Assisted-by: Codex CLI (gpt-5.5)`

Verification arm (machine): `Gate-suite: cinatra-core@2026.07.3`,
`Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`.

## The correction
This forward, docs-only note records the complete verification record for
6aa0275d. Its own squash carries `Correction-for: 6aa0275d…` plus the corrected
trailers and a complete machine arm. It is non-high-risk and changes no runtime
code.
