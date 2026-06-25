# Attribution-record correction — #482 nango required-extension lock refresh (cinatra-engineering#119 §5)

This note is the forward correction (truthful verification-record spec
cinatra-engineering#119 §5) for the attribution record that landed with the
squash merge of PR #482 (`Closeout(eng#286): refresh nango-connector
required-extension lock`, squash commit
`b03ec8dfc043edb65fd27538f2eb5ed044e59b24`).

## What landed

PR #482 refreshes the `@cinatra-ai/nango-connector` pin in
`cinatra-required-extensions.lock.json` to the current connector head
(connector PRs #19, #20; no version change). That file is the **SHA-pinned
acquisition lock** for the prod-bootable required-extension set — the prod base
image acquires the bootable extensions from it (one pinned entry per
`cinatra.extensions` package), so it is a supply-chain-sensitive artifact (see
`docs/governance/eng161-required-system-lock-invariant.md` and
`docs/extension-clone-pinning.md`). The PR touches exactly one file —
`cinatra-required-extensions.lock.json` — and was merged to `main` as squash
commit `b03ec8dfc043edb65fd27538f2eb5ed044e59b24`.

The prior identical lock refresh, PR #309
(`chore(extensions): refresh required-extension lock + skills_ref pin to
current (closeout W1, #72)`, squash `0ee3586466d8631ec6704a404128201676aaf51f`),
carried a `Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz,
tier=maintainer)` human-arm trailer in its squash body — the precedent for how
a deliberate required-extension lock refresh is verified.

## What was wrong

The #482 squash record carried only the transparency arm and a `Closes` line:

```
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: Codex CLI (gpt-5.5)

Closes cinatra-ai/engineering#286
```

and **no verification arm trailer** — neither a `Reviewed-by` (human arm) nor a
`Gate-suite` + `Accountable` (gate arm). The `truthful-attribution-gate`
post-merge (default-branch push) arm on `main` rejected it with a single
error-severity finding (verbatim job-log line):

```
[error] no-record: record invalid: no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)
```

That same run was additionally in degraded mode — the gate could not reach the
GitHub API and skipped anti-fabrication, checking only record grammar/structure
(verbatim job-log line):

```
truthful-attribution-gate [post-merge/enforce]: GitHub API unavailable (Unexpected non-whitespace character after JSON at position 305589 (line 1 column 305590)) — anti-fabrication checks skipped; record grammar/structure only
```

The degradation is incidental: the `no-record` finding is a grammar/structure
finding and fires regardless of API availability, because the record genuinely
carries no verification arm at all. (Because `cinatra-required-extensions.lock.json`
matches no high-risk glob, the gate's `classifyHighRisk` computed
`highRisk = false`, so no `high-risk-without-maintainer` finding fired — the
sole defect is the missing verification arm.)

## Root cause: the squash record dropped the verification arm, not a missing review

The defect is **not** that #482 went unreviewed. The change **was** genuinely
reviewed at maintainer tier:

- @groganz submitted a real GitHub **APPROVED** review on PR #482 at the PR's
  exact head `77c496548892306801eb9576b807ebb819ee4f7b`
  (`state=APPROVED`, `commit_id=77c496548892306801eb9576b807ebb819ee4f7b`). The
  PR's `headRefOid` equals that same SHA, and the merge commit's source head is
  that SHA, so the approval is bound to the head that landed.
- PR #482 was authored by `groganz-bot[bot]` (a bot), not by @groganz, so
  author ≠ approver held and the maintainer approval was admissible.

The synthesized squash body, however, carried only the two `Assisted-by:` lines
plus `Closes` and **did not include** a
`Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)`
line composed from that real approval — exactly the human-arm trailer that the
precedented prior lock refresh #309 carried. There is no merge tool that injects
the verification arm — the merger transcribes it into the squash body at merge
time from the real PR approval (human arm) or from `.github/gate-suite.json`
(machine arm), and for this merge that transcription step was skipped. Because
the post-merge gate reads the *record* (the squash trailer block) rather than
re-deriving the approval, the missing trailer made an honestly-reviewed merge
present as `no-record`.

This is a record defect (a dropped verification-arm trailer), not a verification
defect: a named maintainer really did read and approve the exact landed head.
The lock change is correct on `main` (the `@cinatra-ai/nango-connector`
acquisition pin is refreshed to the current connector head with no version
change), and its review is sound; only the record was malformed. #482
(commit `b03ec8df`) remains merged and unchanged.

## The corrected record

Per §5 (detection + forward correction), this change carries a well-formed
truthful verification record bound to the defective merge SHA via a
`Correction-for:` trailer.

This correction is itself a **single docs-only file** under `docs/governance/`,
which matches **no** high-risk glob (verified against the central
`cinatra-ai/ci` `high-risk-defaults.json` `highRiskGlobs` and this repo's
`.github/gate-suite.json` `highRiskPaths`). The note is carried by a
bot-authored PR (login `groganz-bot[bot]`, so author ≠ approver holds) that
@groganz approves, supplying the **human arm** `Reviewed-by` that the underlying
#482 record was missing and re-binding it to the defective SHA. Because the real,
available, precedented verification for #482 is @groganz's actual maintainer
`APPROVED` review (not a `Gate-suite` + `Accountable` machine-arm record that
was never produced), the human arm is the correct and truthful arm to assert.
The squash record this correction carries is:

```
Correction-for: b03ec8dfc043edb65fd27538f2eb5ed044e59b24
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: Codex CLI (gpt-5.5)
```

The `Reviewed-by` human arm is validated by the `truthful-attribution-gate` on
the default-branch push of this squash: it must match a real, non-self,
non-stale `APPROVED` PR review at the reviewed head by a login (`@groganz`)
whose repo permission meets the claimed `tier=maintainer`. This correction is
branched off current `main`, so its own reviewed-head tree equals the tree it
lands (tree-identity bridge satisfied; the `Correction-for:` PR-merge correction
is validated as a normal merge record). No code behavior changes; the
landed lock on `main` is untouched. A green tip carrying this corrected record
supersedes the red `b03ec8df` tip on the default-branch push arm.

The original #482 verification was, and remains, the **human arm**: a real
maintainer approval by @groganz at the landed head `77c49654…`. This note
records that truth and re-binds a well-formed verification record to the
defective SHA.

## Summary

| Field | Value |
|---|---|
| Corrected-for squash commit | `b03ec8dfc043edb65fd27538f2eb5ed044e59b24` (PR #482) |
| PR title | `Closeout(eng#286): refresh nango-connector required-extension lock pin to current main HEAD` |
| #482 author | `groganz-bot[bot]` |
| Reviewed / landed head of #482 | `77c496548892306801eb9576b807ebb819ee4f7b` |
| Real maintainer approval | @groganz APPROVED @ `77c49654…` (bound to the landed head) |
| Defect | squash body carried two `Assisted-by:` + `Closes` only; omitted the verification-arm `Reviewed-by` trailer → `no-record: no verification arm` |
| Gate run state | degraded (GitHub API unavailable → anti-fabrication skipped; the grammar/structure `no-record` finding fires regardless) |
| #482 risk class | non-high-risk per the gate engine (`cinatra-required-extensions.lock.json` matches no high-risk glob; `classifyHighRisk` → `highRisk=false`); supply-chain-sensitive lock, verified by a maintainer per precedent #309 |
| Content tampering | none (#482 lock unchanged on `main`) |
| This correction's risk class | non-high-risk (single `docs/governance/` file) |
| This correction's verification arm | human arm (`Reviewed-by: … (@groganz, tier=maintainer)`) supplied by @groganz approving this bot-authored PR |
| Precedent | cinatra#346 → `cinatra346-attribution-correction.md` (forward §5 human-arm correction); cinatra#437 → `cinatra437-attribution-correction.md` (green-tip-supersedes-the-red recovery); cinatra#309 → prior required-extension lock refresh carrying a maintainer `Reviewed-by` |
