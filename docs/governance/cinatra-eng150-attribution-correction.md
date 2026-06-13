# Attribution-record correction — capability-provider impersonation fix (cinatra-engineering#150)

This note is the forward correction (truthful verification-record spec
cinatra-engineering#119 §5) for the attribution record that landed with the
squash merge of PR #212 (`fix(extensions): bind capability-provider identity to
the host-injected packageName`).

## What was wrong

The #212 squash record carried:

```
Assisted-by: Claude Code (claude-opus-4-8[1m])
Assisted-by: Codex CLI
```

and **no verification arm**. The `truthful-attribution-gate` post-merge
(default-branch push) arm rejected it on two error-severity findings:

1. **Malformed `Assisted-by`** — the model-id `claude-opus-4-8[1m]` contains
   `[` / `]`, which are outside the §1 model-id grammar
   (`[A-Za-z0-9._/:-]{1,64}`). The gate-representable identity is the base model
   id `claude-opus-4-8`.
2. **No verification arm** — a merge record needs either a human
   `Reviewed-by` (a real maintainer/peer PR approval) or the machine gate arm
   (`Gate-suite` + `Accountable`). The #212 squash carried neither.

The change in #212 is **not** a high-risk path (verified: only `src/lib/`
files; no `highRiskGlobs` match — `packages/sdk-extensions/**` was deliberately
left untouched).

Because the #212 change is not high-risk, the correct verification arm is the
machine gate arm (`Gate-suite` + `Accountable`). Earlier in the §5 correction
cycle the gate arm could not resolve on this repo — the committed suite pins
each required context to a reusable-workflow path
(`cinatra-ai/ci/.github/workflows/*.yml`), and reusable-workflow check-runs
reported `html_url`s of the form `.../cinatra/actions/runs/<id>/job/<id>` that
did not contain that path, so the gate's required-context resolution
(`html_url.includes(workflow)`) could not match them. That gap is now fixed:
the reusable engine was repaired (`cinatra-ai/ci@8eede102`) and re-pinned into
this repo's suite (`gate-suite.json` → `cinatra-core@2026.06.1`, each required
context pinned at `8eede102`). The machine arm now resolves the required
contexts on the reviewed head via `referenced_workflows@8eede102`, so this
correction is verified by the gate arm — no human `Reviewed-by` is required.

## The corrected record

This correction's verification arm is the machine gate arm. The squash record
is:

```
Assisted-by: Claude Code (claude-opus-4-8)
Gate-suite: cinatra-core@2026.06.1
Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)
Correction-for: bdb2151e3d0c41a5b7701b5156b4d2e1c3e8043b
```

The `Gate-suite` + `Accountable` arm is validated by the
`truthful-attribution-gate` on the default-branch push of this squash: the
cited suite (`cinatra-core@2026.06.1`) must equal the `gate-suite.json` at the
merged SHA, the `Accountable` trailer must match its `accountable` block, and
every `requiredContexts` entry must have concluded success on the reviewed
head. The code fix in #212 (commit `bdb2151`) is correct and stays merged; this
is a record-only correction.
