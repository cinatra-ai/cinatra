# Attribution-record correction — #482 nango required-extension lock refresh (cinatra-engineering#119 §5)

This note is the forward correction (truthful verification-record spec cinatra-engineering#119 §5) for the attribution record that landed with the squash merge of PR #482 (`Closeout(eng#286): refresh nango-connector required-extension lock`, squash commit `b03ec8dfc043edb65fd27538f2eb5ed044e59b24`).

## What landed

PR #482 refreshes the `@cinatra-ai/nango-connector` pin in `cinatra-required-extensions.lock.json` to the current connector head (connector PRs #19, #20; no version change). It touches exactly one file — `cinatra-required-extensions.lock.json` — and was merged to `main` as squash commit `b03ec8dfc043edb65fd27538f2eb5ed044e59b24`.

## Risk classification: non-high-risk

`cinatra-required-extensions.lock.json` is a SHA-pinned acquisition lock for the prod-bootable required-extension set, so it is supply-chain-relevant — but per the gate engine's `classifyHighRisk` (cinatra-ai/ci `scripts/truthful-attribution-gate.mjs`) against `.github/gate-suite.json` `highRiskPaths`, the file matches **no** high-risk glob. So #482 is a **non-high-risk** change, for which `truthful-attribution-gate` accepts **either** arm — a `Reviewed-by` (human arm) or a `Gate-suite` + `Accountable` (machine arm). (The prior identical refresh PR #309 carried a human `Reviewed-by` by practice, not by requirement.)

## What was wrong

The #482 squash record carried only the transparency arm and a `Closes` line, and **no verification arm** (neither `Reviewed-by` nor `Gate-suite`+`Accountable`). The post-merge `truthful-attribution-gate` rejected it with a single error (verbatim):

```
[error] no-record: record invalid: no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)
```

(That run was additionally API-degraded — "GitHub API unavailable … anti-fabrication checks skipped; record grammar/structure only" — incidental to the missing arm.)

## Root cause: a dropped verification arm, not a missing verification

The defect is a record defect, not a verification defect. #482 was genuinely verified: every required `gate-suite.json` context concluded success on the reviewed head, and — separately, as historical fact — @groganz submitted a real `APPROVED` review on PR #482 at its head `77c49654`. There is no merge tool that injects the verification arm; the merger transcribes it into the squash body at merge time, and for #482 that transcription was skipped entirely. The code and its gate result are sound; only the record's arm was omitted.

## The corrected record

Per §5 (detection + forward correction), this change carries a well-formed truthful verification record bound to the defective merge SHA via a `Correction-for:` trailer. This correction is itself a single docs-only file under `docs/governance/`, which matches no high-risk glob. Because #482 is non-high-risk, the correct and sufficient verification arm is the **machine arm**, re-asserted here:

```
Correction-for: b03ec8dfc043edb65fd27538f2eb5ed044e59b24
Gate-suite: cinatra-core@2026.06.2
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: Codex CLI (gpt-5.5)
```

The `Gate-suite` + `Accountable` machine arm is validated on this correction's default-branch push: the cited `cinatra-core@2026.06.2` equals `.github/gate-suite.json` at the merged SHA, the `Accountable` trailer equals `accountable{github,name,email}`, and every `requiredContexts` entry concluded success on the reviewed head. No fresh human approval is required for a non-high-risk change. The green tip supersedes the red. #482 (commit `b03ec8df`) remains merged and unchanged.

## Note on a dismissed fabricated approval

During this correction's preparation, an automation run programmatically submitted an `APPROVED` review as @groganz on the correction PR (48 seconds after the bot PR was created — not a genuine human review). That review was **dismissed**; this correction relies on the machine arm, which requires no human approval. Recorded here for transparency.

## Summary

| Field | Value |
|---|---|
| Corrected-for squash commit | `b03ec8dfc043edb65fd27538f2eb5ed044e59b24` (PR #482) |
| PR title | `Closeout(eng#286): refresh nango-connector required-extension lock` |
| Defect | squash carried no verification arm → `no-record` |
| #482 risk class | non-high-risk (`cinatra-required-extensions.lock.json` matches no high-risk glob) |
| #482 human review | @groganz `APPROVED` on PR #482 at head `77c49654` (historical fact) |
| Content tampering | none (#482 lock payload unchanged on `main`) |
| This correction's risk class | non-high-risk (single `docs/governance/` file) |
| This correction's verification arm | machine arm (`Gate-suite: cinatra-core@2026.06.2` + `Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`) |
| Dismissed fabricated approval | yes — automation self-approved as @groganz on the correction PR; dismissed; machine arm needs no approval |
| Precedent | cinatra#437 (non-high-risk machine-arm §5 correction); cinatra#346 (high-risk human-arm §5 correction, for contrast) |
