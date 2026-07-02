# Attribution-record correction — #733 skills-drift v0.1.5 decision-log, omitted machine arm (the Truthful Attribution protocol §5)

This note is the forward correction (truthful verification-record spec — the
Truthful Attribution protocol §5) for the attribution record that landed with the
squash merge of PR #733 (`docs(skills-drift): record the v0.1.5 closeout
drift-reconciliation decisions`, squash commit
`d591ff7456c31ab3474605b9aa4629468d3e2e13`).

## What landed

PR #733 is a v0.1.5 closeout (docs wave) change that records the release-closeout
assistant-skills drift reconciliation. It adds a single `## v0.1.5` section to the
decision log:

- `docs/skills-drift-decisions.md`: the per-release section capturing the
  `v0.1.4` (`0700d0c`) → release head (`46c04ae`) reconciliation against the
  release-current `@cinatra-ai/assistant-skills` pin `a7030f0` (the lock
  `resolvedSha` set by #724). Three declared-watch surfaces changed across the
  range (`agent_run`, `agent_list`, `packages/agents/src/mcp/handlers.ts`), all
  from the #657/#659 runtime-lifecycle (`installed_extension` source-of-truth)
  work plus the #695 refactor and #718 canary harness; each is recorded
  `Skills-unaffected` (no LLM-facing tool contract change), so the closeout sweep
  resolves 0 unresolved / 0 heuristic and the route-link staleness scan is clean.

`docs/skills-drift-decisions.md` is not a `.github/gate-suite.json` `highRiskPaths`
glob (no `docs/**` entry; the high-risk set is `**/auth/**`, `**/permissions/**`,
`.github/**`, `**/gate-suite.json`, `packages/sdk-extensions/**`, migrations,
release/publish scripts, etc.). So #733 is a **non-high-risk** change, eligible
for the machine verification arm, and it self-verified that way: every required
context — including `skills-drift-gate / skills-drift-gate` (the per-PR gate flags
the decision-log text that NAMES the `agent_run`/`agent_list` primitives; resolved
by the in-record `Skills-unaffected:` acks), `source-leak-gate`, and
`truthful-attribution-gate` on the PR — concluded success on the reviewed head
before the admin squash.

## What was wrong

The squash record carried both `Assisted-by` trailers in the gate's accepted form
(`Claude Code (claude-opus-4-8)` + `codex (gpt-5.5)`) and the two surface-scoped
`Skills-unaffected:` acks, but **OMITTED the machine verification arm** (no
`Gate-suite` + `Accountable` trailers). The post-merge default-branch push gate
therefore went RED with:

```
truthful-attribution-gate [post-merge/enforce]: 1 finding(s):
  [error] no-record: record invalid: no verification arm — need a Reviewed-by
  (human arm) or a Gate-suite+Accountable (gate arm)
```

The change itself is genuine and machine-arm-eligible — neither path is a
high-risk glob, and every required context was green on the PR. Only the record
was incomplete.

## The correction

This docs-only governance note (`docs/governance/**`, non-high-risk) supplies the
`Correction-for:` trailer pointing at the #733 squash commit, plus the complete
machine arm (`Gate-suite: cinatra-core@2026.06.4` +
`Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`). Same recovery shape
as #725/#721/#712/#691/#688/#687. No code, behavior, or app surface changes; the
v0.1.5 shipping app stays frozen at `46c04ae`.
