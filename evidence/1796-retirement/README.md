# cinatra#1796 / #2047 row 8 — reviewer + auditor retirement teardown: live evidence

Captured on the branch tree (`lane/198-retirement-core`) against a real running
stack: Next dev server on its own port (3198), a dedicated database
(`cinatra_lane198`) on the shared verify postgres (5634), redis 6579, and a
lane-scoped WayFlow container mounting **this branch's** pinned extension tree.
Activation fence ON (`CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=on`).

## What is proven here

| # | Claim | Evidence |
|---|---|---|
| 1 | The host BOOTS with both packages removed — no dangling registration, import or generated-map reference crashes the boot | `/api/health` → 200; boot log anchors 42 bundled packages, none retired |
| 2 | The live agent catalog carries ZERO rows for either retired package, and all five migrated flows are registered | `SELECT count(*) FROM cinatra.agent_templates WHERE package_name IN (…)` → `0`; 35 templates present incl. all five |
| 3 | The real agent-run SURFACE offers neither agent | `screenshots/lane198-02-agents-search-reviewer.png`, `screenshots/lane198-03-agents-search-auditor.png` — "No agents match" |
| 4 | The catalog renders the retained flows normally (no blank/error cards from the removed bindings) | `screenshots/lane198-01-agents-catalog.png` |
| 5 | WayFlow mounts this tree with ZERO retired agents | `wayflow-mounted-agents.txt` — 25 mounted, none retired |
| 6 | The exact-identity matcher's discrimination holds on a REAL surface | the same mount list still carries `code-reviewer-agent` and `security-reviewer-agent` — the retained packages the boundary-exact grep must never match |

## Honest gap (see the PR body)

The brief's full walk — *run produces the artifact → core gate appears
run-embedded → approve → the flow's next step proceeds* — is **NOT** proven here.
`/api/llm-bridge` returns 403 in this lane: LLM provider credentials resolve from
Nango/DB, this lane has no Nango instance, and the provider-facing public MCP URL
is operator/owner-gated. That is an environment wall, not a finding about this
diff, and it is reported rather than worked around.

## Pre-existing defect surfaced (NOT caused by this PR)

`email-drafting-agent` and `email-recipient-selection-agent` fail to
STANDALONE-mount in WayFlow:

```
ValidationError: 1 validation error for InputMessageNode
  Value error, The InputMessageNode component received a property titled
  `draftBundle`, but did not expect any properties
```

Proven pre-existing by mounting the **previous** pins
(`fcd0cb3e55fbc…` / `061a8ddb3d2e…`, i.e. the pins on `origin/main` before this
PR) in an identical container: **identical failure**. Both flows are exercised in
production as inlined subflows of `email-outreach-agent`, which mounts cleanly.
Recorded for the coordinator; out of scope for this teardown.
