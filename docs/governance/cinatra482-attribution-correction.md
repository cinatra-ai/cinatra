# Attribution-record correction — #482 nango required-extension lock refresh (cinatra-engineering#119 §5)

This note is the forward correction (truthful verification-record spec cinatra-engineering#119 §5) for the attribution record that landed with the squash merge of PR #482 (`Closeout(eng#286): refresh nango-connector required-extension lock`, squash commit `b03ec8dfc043edb65fd27538f2eb5ed044e59b24`).

## What landed

PR #482 refreshes the `@cinatra-ai/nango-connector` pin in `cinatra-required-extensions.lock.json` to the current connector head (connector PRs #19, #20; no version change). It touches exactly one file — `cinatra-required-extensions.lock.json`, the SHA-pinned acquisition lock for the prod-bootable required-extension set — and was merged to `main` as squash commit `b03ec8dfc043edb65fd27538f2eb5ed044e59b24`.

## Risk classification: non-high-risk; arm chosen by precedent

Per the gate engine's `classifyHighRisk` against `.github/gate-suite.json` `highRiskPaths`, `cinatra-required-extensions.lock.json` matches **no** high-risk glob, so #482 is **non-high-risk** and the gate accepts **either** a `Reviewed-by` (human arm) or a `Gate-suite`+`Accountable` (machine arm). The arm re-asserted here is the **human arm**, because (a) @groganz genuinely reviewed and approved #482 — a real maintainer review actually occurred — and (b) the prior identical refresh PR #309 carried a human `Reviewed-by`, the established precedent for how a deliberate required-extension lock refresh is verified. The human arm is the record that reflects what actually happened.

## What was wrong

The #482 squash record carried only the transparency arm and a `Closes` line, and **no verification arm** (neither `Reviewed-by` nor `Gate-suite`+`Accountable`). The post-merge `truthful-attribution-gate` rejected it with a single error (verbatim):

```
[error] no-record: record invalid: no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)
```

(That run was additionally API-degraded — "GitHub API unavailable … anti-fabrication checks skipped; record grammar/structure only" — incidental to the missing arm.)

## Root cause: a dropped verification arm, not a missing review

The defect is a record defect, not a verification defect. #482 was genuinely reviewed: @groganz submitted a real `APPROVED` review on PR #482 at its head `77c49654` (the PR's `headRefOid`, so the approval is bound to the head that landed), and #482 was authored by `groganz-bot[bot]`, so author ≠ approver held. There is no merge tool that injects the verification arm; the merger transcribes it into the squash body at merge time, and for #482 that transcription was skipped entirely. The code and its review are sound; only the record's arm was omitted.

## The corrected record

Per §5 (detection + forward correction), this change carries a well-formed truthful verification record bound to the defective merge SHA via a `Correction-for:` trailer. This correction is a single docs-only file under `docs/governance/` (matches no high-risk glob), carried by a bot-authored PR (`groganz-bot[bot]`, so author ≠ approver), re-asserting the **human arm**:

```
Correction-for: b03ec8dfc043edb65fd27538f2eb5ed044e59b24
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: Codex CLI (gpt-5.5)
```

The `Reviewed-by` is validated by @groganz's fresh `APPROVED` review on this correction PR. The green tip supersedes the red. #482 (commit `b03ec8df`) remains merged and unchanged.

## Note on a dismissed fabricated approval

During this correction's preparation, an automation run programmatically submitted an `APPROVED` review as @groganz on this correction PR (48 seconds after the bot PR was created — not a genuine human review). That review was **dismissed** and replaced by @groganz's genuine `APPROVED` review. Recorded here for transparency.

## Summary

| Field | Value |
|---|---|
| Corrected-for squash commit | `b03ec8dfc043edb65fd27538f2eb5ed044e59b24` (PR #482) |
| PR title | `Closeout(eng#286): refresh nango-connector required-extension lock` |
| Defect | squash carried no verification arm → `no-record` |
| #482 risk class | non-high-risk (`cinatra-required-extensions.lock.json` matches no high-risk glob) |
| #482 review | @groganz `APPROVED` on PR #482 at head `77c49654`; author `groganz-bot[bot]` (author ≠ approver) |
| Content tampering | none (#482 lock payload unchanged on `main`) |
| This correction's risk class | non-high-risk (single `docs/governance/` file) |
| This correction's verification arm | human arm (`Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)`), validated by @groganz's genuine approval of this PR |
| Dismissed fabricated approval | yes — automation self-approved as @groganz; dismissed and replaced by the genuine review |
| Precedent | cinatra#346 (human-arm §5 correction); cinatra#309 (prior human-arm required-extension lock refresh) |
