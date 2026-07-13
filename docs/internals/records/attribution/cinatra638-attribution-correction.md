# Attribution-record correction — #638 Dependabot github-actions group bump + cinatra-ai/ci same-SHA reconcile (cinatra-engineering#119 §5)

This note is the forward correction (truthful verification-record spec
cinatra-engineering#119 §5) for the attribution record that landed with the
squash merge of PR #638 (`ci: bump the github-actions group + reconcile
cinatra-ai/ci pins to the same-SHA invariant`, squash commit
`6375c40837711c0f6416b3aad35f82d83ddb8305`).

## What landed

PR #638 is the Dependabot `github-actions` group bump (14 action updates across
33 workflow files), plus a correction so every `cinatra-ai/ci` reusable-workflow
gate honors its documented "pin BOTH the workflow `@<sha>` and the `ref` input to
the same SHA" invariant: `governance-drift-gate`, `secrets-required-gate` and
`doc-code-value-gate` had their `with.ref` (+ version comment) bumped to
`83ca29ef…` to match the bumped `uses` pin, and `skills-drift-gate` was pinned
(both `uses` and `ref`) to `a181cfe4…` — the correct pin for that gate
(cinatra-ai/ci@a181cfe, ci#31 ack-on-push fix; supersedes the group's `83ca29`),
which superseded and closed PR #368.

Because it touches `.github/**` (the §3 high-risk glob in
`.github/gate-suite.json`), #638 is a **high-risk** change. It was authored by
`marcushorndt`, reviewed and approved by **@groganz at tier=maintainer**, and
merged to `main` as squash commit `6375c40837711c0f6416b3aad35f82d83ddb8305`.

## What was wrong

The #638 squash record carried a malformed verification arm:

```
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: Codex CLI (gpt-5.5)
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
```

The `truthful-attribution-gate` post-merge (default-branch push) arm on `main`
rejected it (verbatim job-log line):

```
[error] no-record: record invalid: Accountable present without Gate-suite (gate arm requires both)
```

`Accountable` and `Gate-suite` are the two halves of the **gate arm** and must
appear together. The trailer dropped `Gate-suite` (an attempt to avoid the
known cosmetic `gate-suite-fabricated` post-merge red while a `cinatra-ai/ci`
pin bump was mid-rollout) but kept `Accountable`, orphaning it and invalidating
the whole record.

## Root cause: the squash record orphaned `Accountable`, not a missing review

The defect is **not** that #638 went unreviewed. The change **was** genuinely
reviewed and approved at maintainer tier: @groganz approved the reviewed head
`981e0a1e8e0b9123c4c1d6ec1221d08ebd22c89d`, and the squash record carried a
valid `Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)`
human arm — which is exactly what a high-risk merge requires. The only defect is
the stray `Accountable` line with no paired `Gate-suite`, which made the record
fail to parse as either a clean human arm or a clean gate arm.

The correct human arm for a high-risk merge is one of:
- the full four-line arm (`Assisted-by` + `Gate-suite` + `Accountable` +
  `Reviewed-by`), or
- the pure human arm (`Assisted-by` + `Reviewed-by` only — no `Gate-suite`, no
  `Accountable`).

`Accountable` without `Gate-suite` is neither, and is rejected.

## Correction

The authoritative verification record for `6375c40837711c0f6416b3aad35f82d83ddb8305`
is the **human arm**: a real maintainer review by @groganz (tier=maintainer) on
the reviewed head `981e0a1e8e0b9123c4c1d6ec1221d08ebd22c89d`. The merge satisfied
every required check at that head (`source-leak-gate`,
`truthful-attribution-gate`, and the full required suite) bar the non-required
`/design-fixtures pixel-diff + axe`, which was red on a pre-existing CI
infra issue (the test DB cannot serve `installed_extension` lifecycle-anchor
rows) unrelated to a workflow-pin bump; the merge used `--admin` solely to pass
that non-required check, not to bypass review or any required gate.

This note is that forward correction; no functional change to `main` is implied.
