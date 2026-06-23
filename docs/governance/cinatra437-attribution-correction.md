# Attribution-record correction — #437 v0.1.2 release-prep (cinatra-engineering#119 §5)

This note is the forward correction (truthful verification-record spec
cinatra-engineering#119 §5) for the attribution record that landed with the
squash merge of PR #437 (`chore(release): bump version to 0.1.2 + bake CLI
@0.1.2`, squash commit
`4940ee35f966cb473ac23f08545c6592478fe417`).

## What landed

PR #437 is the v0.1.2 app release-prep: it bumps the root `package.json`
version `0.1.1` → `0.1.2`, adds the `[0.1.2]` `CHANGELOG.md` section, and bumps
the root devDependency `@cinatra-ai/cinatra` (the published CLI the `Dockerfile`
bakes into the prod runtime image at `/app/.cinatra-cli`) `0.1.1` → `0.1.2` with
a refreshed `pnpm-lock.yaml`. It touches exactly three files — `CHANGELOG.md`,
`package.json`, `pnpm-lock.yaml` — none of which matches any high-risk glob in
`.github/gate-suite.json` `highRiskPaths`. It was merged to `main` as squash
commit `4940ee35f966cb473ac23f08545c6592478fe417`.

## What was wrong

The #437 squash record carried a complete machine arm **except** the
`Accountable` trailer was malformed: it omitted the `<email>` component.

```
Gate-suite: cinatra-core@2026.06.2
Accountable: Sandro Groganz (@groganz)
```

The `truthful-attribution-gate` post-merge (default-branch push) arm on `main`
rejected it with three error-severity findings (verbatim job-log lines):

```
[error] no-record: record invalid: malformed Accountable trailer: "Accountable: Sandro Groganz (@groganz)"
[error] no-record: record invalid: Gate-suite present without Accountable (gate arm requires both)
[error] no-record: record invalid: no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)
```

The gate matches the `Accountable` trailer against
`.github/gate-suite.json` `accountable{github,name,email}`, so the canonical
accepted form carries all three components:
`Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`. The #437 record
dropped `<sandro@cinatra.ai>`, so the parser read the trailer as malformed,
treated the gate arm as absent, and reported `no-record`.

## Root cause: a malformed merge-record trailer, not a missing verification

The defect is **not** that #437 lacked verification. #437 is a non-high-risk
change (none of its three files matches a high-risk glob), so the **machine
arm** (`Gate-suite` + `Accountable`) is the correct and sufficient verification
arm, and all required contexts in `.github/gate-suite.json` concluded success on
the reviewed head before merge. Only the `Accountable` trailer's surface form
was wrong (missing `<email>`). There is no merge tool that injects or normalizes
the verification arm — the merger transcribes it into the squash body at merge
time — and that transcription used the email-less short form. Because the
post-merge gate reads the *record* (the squash trailer block) rather than
re-deriving it, the malformed trailer made a correctly-machine-verified
non-high-risk merge present as `no-record`.

This is a record defect (a malformed gate-arm trailer), not a verification
defect: all required gate-suite contexts genuinely passed at the reviewed head.
The code and its gate result are sound; only the record's surface form was
malformed. #437 (commit `4940ee35`) remains merged and unchanged; the v0.1.2
release payload on `main` (`package.json` version `0.1.2`, CLI devDep `0.1.2`,
`pnpm-lock.yaml` pin `@cinatra-ai/cinatra@0.1.2`) is correct and untouched.

## The corrected record

Per §5 (detection + forward correction), this change carries a well-formed
truthful verification record bound to the defective merge SHA via a
`Correction-for:` trailer.

This correction is itself a **single docs-only file** under `docs/governance/`,
which matches **no** high-risk glob (verified against the central
`cinatra-ai/ci` `high-risk-defaults.json` and this repo's
`.github/gate-suite.json` `highRiskPaths`). Because both the underlying #437 and
this correction are non-high-risk, the correct verification arm is the
**machine arm**, re-asserted with a well-formed `Accountable` trailer. The
squash record this correction carries is:

```
Correction-for: 4940ee35f966cb473ac23f08545c6592478fe417
Gate-suite: cinatra-core@2026.06.2
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: Codex CLI (gpt-5.5)
```

The `Gate-suite` + `Accountable` machine arm is validated by the
`truthful-attribution-gate` on the default-branch push of this squash: the cited
`cinatra-core@2026.06.2` must equal `.github/gate-suite.json` at the merged SHA,
the `Accountable` trailer must equal `accountable{github,name,email}`, and every
`requiredContexts` entry must have concluded success on the reviewed head. This
correction is branched off current `main`, so its own reviewed-head tree equals
the tree it lands (tree-identity bridge satisfied; the `Correction-for:` PR-merge
correction is validated as a normal machine-arm merge record). No code behavior
changes.

## Summary

| Field | Value |
|---|---|
| Corrected-for squash commit | `4940ee35f966cb473ac23f08545c6592478fe417` (PR #437) |
| PR title | `chore(release): bump version to 0.1.2 + bake CLI @0.1.2` |
| Defect | squash body carried `Accountable: Sandro Groganz (@groganz)` (missing `<email>`) → `malformed Accountable trailer` → `no-record` |
| #437 risk class | non-high-risk (`CHANGELOG.md`, `package.json`, `pnpm-lock.yaml`) |
| Content tampering | none (#437 release payload unchanged; v0.1.2 on `main`) |
| This correction's risk class | non-high-risk (single `docs/governance/` file) |
| This correction's verification arm | machine arm (`Gate-suite: cinatra-core@2026.06.2` + well-formed `Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`) |
| Canonical Accountable form | `Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)` (name + `<email>` + `(@github)`) |
| Precedent | cinatra#346 → `cinatra346-attribution-correction.md` (high-risk human-arm §5 correction); cinatra#433 → green-tip-supersedes recovery for a malformed post-merge trailer |
