# Attribution-record correction — #278 + #279 (cinatra#246 stack) (cinatra-engineering#119 §5)

This note is the forward correction (truthful verification-record spec
cinatra-engineering#119 §5) for the attribution records that landed with the
squash merges of two PRs in the cinatra#246 content-editor relay work:

- **#278** — `fix(content-editor): carry real agent_run OBO identity to /api/mcp (#246)`,
  squash commit `b83469b7f3ebc7caac8357ed49d848dba1799f20`.
- **#279** — `fix(wordpress): log (don't silently swallow) Nango credential-sync failures (#246)`,
  squash commit `aed4aba7ac04831d9f1844659d6ca494d5f79a67`.

## What was wrong

Both squash records carried only the transparency arm:

```
Assisted-by: Claude Code (claude-opus-4-8)
Assisted-by: codex (gpt-5.5)
```

and **no verification arm trailer**. The `truthful-attribution-gate` post-merge
(default-branch push) arm on `main` rejected both with the error-severity
finding (verbatim job-log line):

```
[error] no-record: record invalid: no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)
```

## Root cause: the squash record dropped the machine-arm trailers, not a missing review or a failing gate

Neither PR is a high-risk change — their touched paths
(`src/lib/content-editor-run-identity.ts`, `src/lib/host-content-editor-dispatch.ts`,
`src/lib/wordpress-api.ts`) match none of the §3 `highRiskPaths` globs in
`.github/gate-suite.json`. The post-merge gate accordingly offered *either*
arm ("need a Reviewed-by **or** a Gate-suite+Accountable"); for a non-high-risk
change the **machine (gate) arm** is the correct one:

```
Gate-suite: cinatra-core@2026.06.2
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
```

Both PRs were genuinely verified at PR time:

- Authored by the dedicated machine identity `cinatra-agent-bot[bot]`, so
  author ≠ approver held.
- Approved by @groganz on each PR (a real GitHub `APPROVED` review), satisfying
  the branch-protection 1-review requirement.
- The full required-context suite (the `cinatra-core` gate-suite, including the
  PR-context `truthful-attribution-gate`) was green on both PRs before merge.

The defect was purely in the synthesized squash body: it carried the two
`Assisted-by` lines from the branch commits but **did not include** the
`Gate-suite` + `Accountable` machine-arm trailers that this repo's merge records
must carry (there is no merge tool that injects them — they are transcribed from
`.github/gate-suite.json` into the squash body at merge time, and that step was
skipped). The code and its review are sound; only the record was malformed.

## The correction

This note is merged with the full machine arm and a `Correction-for` trailer
naming both affected commits, restoring a green attribution tip on `main`. A
direct-push `Correction-for` cannot green the gate (no PR context ⇒ the machine
arm is unverifiable), so the correction is carried by this PR's properly-armed
squash merge per the §5 mechanism. No code behavior changes.
