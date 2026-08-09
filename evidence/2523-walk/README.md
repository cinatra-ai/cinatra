# cinatra#2523 / PR #2615 — live wizard walk (lane TRIPLE-245)

Head under proof: `176cb7de6fccf10d461c7c81dd3c9081f4e57469`.

**THE RULING IS NOT PROVEN. Do not read this record as a pass.**

## How it ran

- Real Next dev server on the branch worktree, port 3152, dedicated database
  `tr245_walk` on the verify Postgres (5634), Redis 6579, 111/111 extensions
  pinned, schema built by the shipped `cinatra instance setup dev`.
- **`CINATRA_E2E_SETUP_BYPASS=false`** — the wizard gate was live and was walked,
  not skipped. `/` redirected to `/setup/account`.
- Real Chrome via Playwright, one browser, workers=1.
- The ONLY thing stubbed is the outbound HTTP boundary to `api.openai.com` /
  `api.anthropic.com`, using this repo's OWN committed acceptance harness
  (`tests/e2e/setup/support/provider-boundary-stub.mjs`, loaded via
  `NODE_OPTIONS=--import`). Every in-app path — server actions, the commit
  machine, Postgres, the rendered UI, dispatch — is real. No live provider key
  exists on this host (see "Why the boundary is stubbed").

## Per-item result

| # | Item | Result |
|---|---|---|
| 1 | Setup gate is live with bypass OFF | **PASS** — `/` → `/setup/account?next=/chat` |
| 2 | Account step creates the first full-access admin | **PASS** — `tr245-walk@local.test` landed with `role=admin` |
| 3 | Key / Name / Secrets steps complete | **PASS** — instance named, namespace derived, step nav advanced |
| 4 | Model step reachable credential-free | **PASS** — re-proves the #2596 finding on THIS head |
| 5 | Model step completes and setup succeeds | **PASS (boundary-stubbed)** — "Setup complete" rendered |
| 6 | Configure an IMMEDIATE trigger in the trigger UI | **FAIL — BLOCKED, never reached** |
| 7 | The agent actually runs (dispatch asserted, not the status flip) | **NOT PROVEN** |
| 8 | A SCHEDULE choice arms without running | **NOT PROVEN** |
| 9 | No silent success anywhere | **NOT PROVEN** |

## The blocker (item 6) — recorded, not fixed

Immediately after setup success, `/agents` → **Run** on
`@cinatra-ai/blog-draft-writer-agent` (the issue's own repro agent) throws before
the agent setup screen renders:

```
AgentTemplateScopeError: agent-template-scope: create/run-owner refused for
template 8742afe6-2b3f-43ae-88c3-8f5f7a767729 — unknown_scope (scope: organization)
  at assertActorWithinAgentTemplateScope (packages/agents/src/auth-policy.ts:1765)
  at assertAgentRunScopeAuthorized  (packages/agents/src/agent-run-serde.ts:536)
  at createAgentRunPendingInput     (packages/agents/src/store.ts:3162)
  at createAndTriggerRunCore        (packages/agents/src/run-actions.ts:329)
  at SetupScreen                    (packages/agents/src/instance-screens.tsx:193)
```

Cause, from the rows (`walk-templates.csv`): the extension agent import seeds
**32 of 35** templates with `owner_level='organization'` but `org_id` NULL **and**
`owner_id` empty. The organization arm of `evaluateActorWithinAgentTemplateScope`
resolves `owningOrgId = template.orgId ?? template.ownerId`, finds neither, and
correctly denies as `unknown_scope`. The evaluator is behaving as written; the
defect is upstream, in what the import writes.

The actor is not the problem: the wizard created the `default` org, made the
first admin its `owner`, and the session carries that org as active.

Sequence that produces it — the documented dev path: `cinatra instance setup dev`
→ boot (templates import while no org exists yet) → wizard creates the org. The
second boot logs `skipped — already up to date`, so no backfill ever anchors them.

**Not attributed to this PR's diff.** It is plausibly pre-existing on `main`; this
lane did not bisect it. What is certain is that it stands between a freshly
walked instance and the trigger form, so the walk this PR owes cannot complete on
this head. `agent_runs` count after the walk: **0**.

## Why the boundary is stubbed

No usable LLM provider credential exists on this host: no provider key variable
in the source `.env.local`, no stored provider config in any verify database, and
the last attempt recorded on this host is
`{"step":"credential-validation","message":"The openai credentials were accepted
but no models are available to this key."}`. The model step has no skip
affordance, so without the repo's own boundary stub the wizard cannot complete at
all.

## Captures

- `tr245-walk-01-setup-model.png` — model step, credential-free, bypass OFF
- `tr245-walk-02-model-step-blocked.png` — the step before the boundary stub
- `tr245-walk-03-setup-complete.png` — "Setup complete"
- `tr245-walk-04-FAIL-agent-template-scope-error.png` — the blocker
- `walk-templates.csv` — the seeded template rows with the null org anchor
