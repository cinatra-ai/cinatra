# Attribution-record correction — #351 upgrade-track inventory (cinatra-engineering#119 §5)

This note is the forward correction (truthful verification-record spec
cinatra-engineering#119 §5) for the attribution record that landed with the
squash merge of PR #443 (`chore(upgrade-track): inventory + pin-drift first
pass`, squash commit `0bbde391ed4de863a6da4b9d5c5e8605aeb68be6`,
closing #351).

## What landed

PR #443 is the inventory + pin-drift first pass of the major-version upgrade
track. It changes exactly two files — `docker-compose.yml` (pins the floating
`nangohq/nango-server:hosted` tag to its immutable public-registry-resolved
digest; records the Postgres consolidation target as comments without bumping
the image) and a new `docs/upgrade-track.md` (the current -> target inventory
ledger plus the patches/overrides obsoleted-by-version table). Neither file
matches any high-risk glob in `.github/gate-suite.json` `highRiskPaths`. It was
merged to `main` as squash commit `0bbde391ed4de863a6da4b9d5c5e8605aeb68be6`.

## What was wrong

The #443 squash record carried a complete machine arm, but its trailer block had
three surface-form defects that the `truthful-attribution-gate` post-merge
(default-branch push) arm rejected. The block as merged was:

```
Assisted-by: Claude (claude-opus-4-8[1m])
Gate-suite: cinatra-core@2026.06.2
Accountable: Sandro Groganz (@groganz)
Closes cinatra-ai/cinatra#351
```

The gate rejected it with these error-severity findings (verbatim job-log
lines):

```
[error] no-record: record invalid: malformed Assisted-by trailer: "Assisted-by: Claude (claude-opus-4-8[1m])"
[error] no-record: record invalid: malformed Accountable trailer: "Accountable: Sandro Groganz (@groganz)"
[error] no-record: record invalid: non-trailer line in the final trailer block (a record cannot hide behind prose): "Closes cinatra-ai/cinatra#351"
[error] no-record: record invalid: missing Assisted-by — mandatory on every merge ("Assisted-by: none" for human-only changes)
[error] no-record: record invalid: Gate-suite present without Accountable (gate arm requires both)
[error] no-record: record invalid: no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)
```

The three root defects, against the gate grammar (`scripts/truthful-attribution-gate.mjs`):

1. **`Assisted-by` model-id contained `[` `]`.** The `ASSISTED_RE` model
   character class is `[A-Za-z0-9._/:-]` — square brackets are not allowed, so
   `(claude-opus-4-8[1m])` fails the model sub-pattern and the whole line is read
   as a malformed owned trailer. The accepted form drops the bracketed window
   tag: `Assisted-by: Claude Code (claude-opus-4-8)`.
2. **`Accountable` omitted the `<email>` component.** `ACCOUNTABLE_RE` requires
   `<full-name> <<email>> (@<login>)` and the gate matches it against
   `.github/gate-suite.json` `accountable{github,name,email}`. The canonical
   accepted form is
   `Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`; the #443 record
   dropped `<sandro@cinatra.ai>`.
3. **`Closes cinatra-ai/cinatra#351` sat inside the final trailer block.** The
   trailer block is the final contiguous run of non-blank lines; `Closes …` is
   not trailer-shaped (no `Key:` form), so it broke the block — which in turn
   made the parser treat the (already-malformed) `Assisted-by`/`Accountable`
   lines as absent, cascading to `missing Assisted-by` and `no verification
   arm`. The issue link belongs in its own paragraph above the trailer block (or
   is unnecessary here — the issue auto-closed on merge regardless).

## Root cause: a malformed merge-record trailer, not a missing verification

The defect is **not** that #443 lacked verification. #443 is a non-high-risk
change (neither of its two files matches a high-risk glob), so the **machine
arm** (`Gate-suite` + `Accountable`) is the correct and sufficient verification
arm, and all required contexts in `.github/gate-suite.json` concluded success on
the reviewed head before merge (build, RBAC/Workflows browser e2e, the gates,
etc. — all green at the reviewed SHA `65698a309886c57447fe2803e2ba663a731e2346`).
Only the trailer block's surface form was wrong. There is no merge tool that
injects or normalizes the verification arm — the merger transcribes it into the
squash body at merge time, and the transcription carried the three defects
above.

The #443 code payload on `main` is correct and unchanged by this correction:
the Nango digest pin, the Postgres recorded-target comments, and
`docs/upgrade-track.md` are exactly as reviewed; `docker compose config -q`
validates on the merged tree. This is a record-format correction only.

## The correction

This note re-asserts the well-formed machine arm bound to the defective SHA via
a `Correction-for:` trailer, in the canonical accepted grammar:

```
Correction-for: 0bbde391ed4de863a6da4b9d5c5e8605aeb68be6
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: Codex CLI (gpt-5.5)
Gate-suite: cinatra-core@2026.06.2
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
```

`Codex CLI` is recorded because the merge-time review of #443 was performed with
the Codex CLI (`gpt-5.5`) and this correction note's content reflects that
review record. This correction is a docs-only governance note; it matches no
high-risk glob, so its own machine arm is the correct and sufficient
verification arm. Landed via a pull request so the gate can verify the machine
arm with PR context. The green tip supersedes the red post-merge result on the
defective SHA.
