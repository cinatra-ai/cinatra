# Attribution-record correction — #234 re-land of approved #231 + #232 (the Truthful Attribution protocol §5)

This note is the forward correction (truthful verification-record spec
the Truthful Attribution protocol §5) for the attribution record that landed with the
squash merge of PR #234 (`Re-land approved #231 + #232 onto current main
(combined, supersedes both)`, squash commit
`fba137120d15f18511fa928959a6bf6cbb7c1d45`).

## What was wrong

The #234 squash record carried only the transparency arm:

```
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: Codex (gpt-5-codex)
```

and **no verification arm trailer**. The `truthful-attribution-gate` post-merge
(default-branch push) arm on `main` rejected it with two error-severity
findings (verbatim job-log lines):

```
[error] no-record: record invalid: no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)
[error] high-risk-without-maintainer: high-risk change but no passing tier=maintainer Reviewed-by in the record (high-risk requires the human arm; the gate arm alone is rejected)
```

#234 re-landed the extensions SDK + install pipeline, so it is a **high-risk**
change (the §3 globs `packages/sdk-extensions/**` and the install-ops paths
match). A high-risk merge requires the **human arm** — a real tier=maintainer
`Reviewed-by` — and the squash record omitted that trailer line.

## Root cause: the squash record dropped the Reviewed-by trailer, not a missing review

The defect is **not** that #234 went unreviewed. The change **was** genuinely
reviewed at maintainer tier:

- @groganz submitted a real GitHub **APPROVED** review on PR #234 at the PR's
  exact head `b72576a344c19ff5f9c26146e41e29423f0aeec9`, at
  `2026-06-14T10:17:33Z` (review id `4492765742`,
  `state=APPROVED`, `commit_id=b72576a344c19ff5f9c26146e41e29423f0aeec9`,
  `author_association=MEMBER`). The PR's `headRefOid` equals that same SHA, so
  the approval is bound to the head that landed.
- PR #234 was authored by the dedicated machine identity
  `cinatra-agent-bot[bot]`, so author ≠ approver held and the maintainer
  approval was admissible.

The merge was squashed at `2026-06-14T10:22:30Z` (≈5 minutes after the
approval). The synthesized squash body, however, carried only the two
`Assisted-by` lines from the branch commits and **did not include** a
`Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)`
line composed from that real approval. Because the post-merge gate reads the
*record* (the squash trailer block) rather than re-deriving the approval, the
missing trailer made an honestly-reviewed high-risk merge present as
`no-record` + `high-risk-without-maintainer`.

This is a record defect (a dropped human-arm trailer), not a verification
defect: a named maintainer really did read and approve the exact landed head.

## Evidence the #234 diff is the approved code

The #234 record states that the combined branch was **byte-identical** to the
two owner-approved change-sets it re-landed (independent blob/tree evidence,
not a claim verified by this correction's gate arm):

- #234 combines the owner-approved cinatra#231 (the `createHostDepsSlot`
  extraction / host-deps-slot SDK helper) and cinatra#232
  (the collapse of the duplicate agent-tree-installer
  dependency resolver), rebuilt on current `main` after #233 (docs-only) had
  advanced the base and re-staled both approved PRs.
- For every touched path, the combined branch's blob SHA equals the approved
  PR-head blob SHA (#231 @ `60d5499`, #232 @ `39a3c29`); the two diffs touch
  disjoint paths (`packages/sdk-extensions/**` vs.
  `packages/agents/**` + `src/lib/extension-install-*`) and combine without
  conflict.

No content was rewritten by this correction; #234 (commit `fba1371`) remains
merged and unchanged.

## The corrected record

Per §5 (detection + forward correction), this change carries a well-formed
truthful verification record bound to the defective merge SHA via a
`Correction-for:` trailer.

This correction is itself a **single docs-only file** under `docs/governance/`,
which matches **no** high-risk glob (verified against the central
`cinatra-ai/ci` `high-risk-defaults.json` and this repo's
`.github/gate-suite.json` `highRiskPaths`). A non-high-risk change's correct
verification arm is the **machine gate arm** (`Gate-suite` + `Accountable`),
mirroring the §5 precedent cinatra#212 → `cinatra150-attribution-correction.md`,
whose own post-merge gate concluded success. The squash record this correction
carries is:

```
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: Codex (gpt-5-codex)
Gate-suite: cinatra-core@2026.06.1
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Correction-for: fba137120d15f18511fa928959a6bf6cbb7c1d45
```

The `Gate-suite` + `Accountable` arm is validated by the
`truthful-attribution-gate` on the default-branch push of this squash: the
cited suite (`cinatra-core@2026.06.1`) must equal `.github/gate-suite.json` at
the merged SHA, the `Accountable` trailer must match its `accountable` block,
and every `requiredContexts` entry must have concluded success on the reviewed
head. This correction is branched off current `main`, so its own reviewed-head
tree equals the tree it lands (tree-identity bridge satisfied; the
`Correction-for:` PR-merge correction is validated as a normal merge record).

The original #234 verification arm was, and remains, the **human arm**: a real
maintainer approval by @groganz at the landed head. This note records that
truth and re-binds a well-formed verification record to the defective SHA; the
machine arm here verifies *this docs correction*, while the underlying #234
high-risk change's honest human review is documented above.

## Summary

| Field | Value |
|---|---|
| Corrected-for squash commit | `fba137120d15f18511fa928959a6bf6cbb7c1d45` (PR #234) |
| Re-landed change-sets | #231 (host-deps-slot extraction) + #232 (duplicate-installer collapse) |
| Reviewed / landed head of #234 | `b72576a344c19ff5f9c26146e41e29423f0aeec9` |
| Real maintainer approval | @groganz APPROVED @ `b72576a` at `2026-06-14T10:17:33Z` (review `4492765742`) |
| Defect | squash body omitted the `Reviewed-by` human-arm trailer → `no-record` + `high-risk-without-maintainer` |
| #234 risk class | high-risk (`packages/sdk-extensions/**` + install-ops) |
| Content tampering | none (#234 diff byte-identical to approved #231/#232) |
| This correction's risk class | non-high-risk (single `docs/governance/` file) |
| This correction's verification arm | machine gate arm (`Gate-suite: cinatra-core@2026.06.1` + `Accountable`) |
| Precedent | cinatra#212 → `cinatra150-attribution-correction.md` (machine-arm §5 correction); cinatra#211, cinatra#228 |
