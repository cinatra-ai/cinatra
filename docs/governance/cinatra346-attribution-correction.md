# Attribution-record correction — #346 DCR/MCP authorize fix (cinatra-engineering#119 §5)

This note is the forward correction (truthful verification-record spec
cinatra-engineering#119 §5) for the attribution record that landed with the
squash merge of PR #346 (`fix(auth): ensure DCR clients can authorize against
the MCP resource (mcp:connect)`, squash commit
`5b0e644686af66572386c7c0092412f3b45ce80b`).

## What landed

PR #346 fixes the dynamic client registration (DCR) authorize path so DCR
clients can authorize against the MCP resource (`mcp:connect`). It touches
`src/app/api/auth/[...all]/route.ts`, which matches the §3 high-risk glob
`**/auth/**` in `.github/gate-suite.json`. The PR was authored by
`marcushorndt`, reviewed and approved by @groganz, and merged to `main` as
squash commit `5b0e644686af66572386c7c0092412f3b45ce80b`.

## What was wrong

The #346 squash record carried only the transparency arm:

```
Assisted-by: none
```

and **no verification arm trailer**. The `truthful-attribution-gate` post-merge
(default-branch push) arm on `main` rejected it with two error-severity
findings (verbatim job-log lines):

```
[error] no-record: record invalid: no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)
[error] high-risk-without-maintainer: high-risk change but no passing tier=maintainer Reviewed-by in the record (high-risk requires the human arm; the gate arm alone is rejected)
```

Because `src/app/api/auth/[...all]/route.ts` matches the high-risk glob
`**/auth/**`, #346 is a **high-risk** change. A high-risk merge requires the
**human arm** — a real tier=maintainer `Reviewed-by` — and the gate arm alone is
rejected. The squash record omitted the `Reviewed-by` trailer line.

## Root cause: the squash record dropped the Reviewed-by trailer, not a missing review

The defect is **not** that #346 went unreviewed. The change **was** genuinely
reviewed at maintainer tier:

- @groganz submitted a real GitHub **APPROVED** review on PR #346 at the PR's
  exact head `e70501ba85945b0060c58f389419512e306c2cd0`
  (`state=APPROVED`, `commit_id=e70501ba85945b0060c58f389419512e306c2cd0`). The
  PR's `headRefOid` equals that same SHA, so the approval is bound to the head
  that landed.
- PR #346 was authored by `marcushorndt`, not by @groganz, so author ≠ approver
  held and the maintainer approval was admissible.

The synthesized squash body, however, carried only the `Assisted-by: none` line
and **did not include** a
`Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)`
line composed from that real approval. There is no merge tool that injects the
verification arm — the merger transcribes it into the squash body at merge time
from the real PR approval (human arm) or from `.github/gate-suite.json` (machine
arm), and for this high-risk merge that human-arm transcription step was
skipped. Because the post-merge gate reads the *record* (the squash trailer
block) rather than re-deriving the approval, the missing trailer made an
honestly-reviewed high-risk merge present as `no-record` +
`high-risk-without-maintainer`.

This is a record defect (a dropped human-arm trailer), not a verification
defect: a named maintainer really did read and approve the exact landed head.
The code and its review are sound; only the record was malformed. #346
(commit `5b0e644`) remains merged and unchanged.

## The corrected record

Per §5 (detection + forward correction), this change carries a well-formed
truthful verification record bound to the defective merge SHA via a
`Correction-for:` trailer.

This correction is itself a **single docs-only file** under `docs/governance/`,
which matches **no** high-risk glob (verified against the central
`cinatra-ai/ci` `high-risk-defaults.json` and this repo's
`.github/gate-suite.json` `highRiskPaths`). The note is carried by a
bot-authored PR (login `cinatra-agent-bot[bot]`, so author ≠ approver holds)
that @groganz approves, supplying the **human arm** `Reviewed-by` that the
underlying high-risk #346 record was missing and re-binding it to the defective
SHA. The squash record this correction carries is:

```
Correction-for: 5b0e644686af66572386c7c0092412f3b45ce80b
Reviewed-by: Sandro Groganz <sandro@cinatra.ai> (@groganz, tier=maintainer)
Assisted-by: Claude (claude-opus-4-8)
```

The `Reviewed-by` human arm is validated by the `truthful-attribution-gate` on
the default-branch push of this squash: it must match a real, non-self,
non-stale `APPROVED` PR review at the reviewed head by a login (`@groganz`)
whose repo permission meets the claimed `tier=maintainer`. This correction is
branched off current `main`, so its own reviewed-head tree equals the tree it
lands (tree-identity bridge satisfied; the `Correction-for:` PR-merge
correction is validated as a normal merge record). No code behavior changes.

The original #346 verification arm was, and remains, the **human arm**: a real
maintainer approval by @groganz at the landed head `e70501ba8…`. This note
records that truth and re-binds a well-formed verification record to the
defective SHA.

## Summary

| Field | Value |
|---|---|
| Corrected-for squash commit | `5b0e644686af66572386c7c0092412f3b45ce80b` (PR #346) |
| PR title | `fix(auth): ensure DCR clients can authorize against the MCP resource (mcp:connect)` |
| #346 author | `marcushorndt` |
| Reviewed / landed head of #346 | `e70501ba85945b0060c58f389419512e306c2cd0` |
| Real maintainer approval | @groganz APPROVED @ `e70501ba8…` |
| Defect | squash body carried `Assisted-by: none` only; omitted the `Reviewed-by` human-arm trailer → `no-record` + `high-risk-without-maintainer` |
| #346 risk class | high-risk (`src/app/api/auth/[...all]/route.ts` matches `**/auth/**`) |
| Content tampering | none (#346 code unchanged) |
| This correction's risk class | non-high-risk (single `docs/governance/` file) |
| This correction's verification arm | human arm (`Reviewed-by: … (@groganz, tier=maintainer)`) supplied by @groganz approving this bot-authored PR |
| Precedent | cinatra#234 → `cinatra234-attribution-correction.md` (high-risk human-arm §5 correction); cinatra#212 → `cinatra-eng150-attribution-correction.md` |
