# cinatra#2619 — live fresh-instance walk (and the owed #2615 walk items 6–9)

Captured 2026-08-10 on a **fresh** local instance: a brand-new database, the real
setup wizard with `CINATRA_E2E_SETUP_BYPASS=false`, and the committed provider
HTTP-boundary stub (`tests/e2e/setup/support/provider-boundary-stub.mjs`)
preloaded via `NODE_OPTIONS --import` for the model step. Everything inside the
app is real — Postgres, the boot phases, the run perimeter, BullMQ/Redis, the
worker. Only outbound HTTP to the two provider hosts is answered from the stub's
scripted table.

## Branch composition — read this before reading the captures

The walk instance ran a **composition**, not this PR's branch alone:

| ingredient | ref |
| --- | --- |
| this lane's fix | `fix/2619-import-org-scope` |
| baseline | `origin/main` @ `c4ba2150e` |
| **cinatra#2615, still UNMERGED** | `origin/fix/2523-run-now-actually-runs` @ `4ce5794` cherry-merged in |

`#2615` was verified OPEN at walk time and was merged into a throwaway branch
(`walk/2619-plus-2615`) for the walk only. It is **not** part of this PR's diff.
The trigger-step captures (3–5) therefore prove **#2615's behaviour running on a
2619-fixed instance** — which is exactly what #2615's own walk could not reach,
because it was blocked at this issue's defect (its
`evidence/2523-walk/tr245-walk-04-FAIL-agent-template-scope-error.png`).

## The captures

| file | what it proves |
| --- | --- |
| `01-CONTROL-damaged-row-unknown_scope.png` | **The control.** The repro agent's row was deliberately put back into the reported damaged shape (`org_id=NULL`, `owner_level='organization'`, `owner_id=''`) with one UPDATE. Pressing Run then throws the issue's exact error — `AgentTemplateScopeError … unknown_scope (scope: organization)` at `packages/agents/src/auth-policy.ts:1765 @ assertActorWithinAgentTemplateScope`, through `assertAgentRunScopeAuthorized → createAgentRunPendingInput → createAndTriggerRunCore → SetupScreen`. The defect is real on this instance and the evaluator is doing its job. |
| `02-AC1-agent-setup-screen-reached.png` | **AC1.** After ONE restart — no code change, no manual SQL — the boot reconcile healed the row and Run on `@cinatra-ai/blog-draft-writer-agent` reaches the **agent setup screen** (`Agentic Run Progress`, `pending approval`, the `Idea` field). No `unknown_scope`. |
| `03-trigger-step-reached.png` | Setup approval hands the run to the trigger step (`/…/trigger`, run status `pending_trigger`) — #2615's hand-off, reached for the first time on a real instance. |
| `04-immediate-trigger-dispatched.png` | **The owner ruling, immediate arm.** "Run right after setup" → the run transitions AND **dispatches**. |
| `05-schedule-arms-without-running.png` | **The owner ruling, schedule arm.** "Schedule for later" → the run **arms** and does not run. |

## The dispatch is MEASURED, not inferred

`queue-events.txt` is the raw BullMQ event stream (`bull:lane2619-jobs:events`).
For the immediate run `65941801-0a0a-4333-9b82-f5e4c29f24bf` it carries three
distinct jobs, in order:

1. `jobId=65941801-…` — the creation-time job (added → waiting → active → completed).
2. `jobId=resume-setup-65941801-…` — the setup-approval resume leg.
3. **`jobId=agent-builder-65941801-…` — added at ts `1786322318890`** — the job the
   IMMEDIATE trigger put on the queue. It went added → waiting → **active** →
   completed, and the store's trigger row records `released_at = 00:38:38.259+00`,
   the same instant.

The worker really picked it up: `dev-server-lines.txt` carries

```
[wayflow] dispatch failed for run 65941801-… targeting http://localhost:3110/agents/cinatra-ai/blog-draft-writer-agent/:
  Failed to fetch Agent Card … 404
```

That line can only be produced by the worker **executing the dequeued job**. The
run then landed `failed` with that exact reason persisted on `agent_runs.error`.
The WayFlow container on :3110 belongs to another lane and does not serve this
agent, so the failure is environmental — at the LAST hop, after a genuine
dispatch. **It is not a scope denial and it is not a silent success**: the
pre-#2615 bug answered `ok:true` having enqueued nothing at all, and this run
enqueued, ran, and reported a true failure.

For the scheduled run `1dfcdcfb-…`: status `armed`; trigger row
`trigger_type=scheduled`, `enabled=t`, **`released_at` NULL**,
`scheduled_at=2026-12-01 08:00:00+00`, `timezone=Europe/Berlin`,
`job_scheduler_id=trigger-release-1dfcdcfb-…`. Redis holds
`bull:lane2619-jobs:trigger-release-1dfcdcfb-…` (the armed scheduler) and
**no `agent-builder-1dfcdcfb-…` job exists** — armed, not run.

## The reconcile, observed on three boots

`dev-server-lines.txt`:

```
[agents/org-reconcile] skipped — no-organization (candidates=3, organizations=0) — those templates stay refused at run start
[agents/org-reconcile] (org bootstrap) healed 3 template(s) onto org=d199d18e-… (level stamped on 3; scanned 3)
[agents/org-reconcile] healed 3 template(s) onto org=d199d18e-… (level stamped on 3; scanned 3)
[agents/org-reconcile] healed 4 template(s) onto org=d199d18e-… (level stamped on 3; scanned 4)
```

The first line is the pass REFUSING to guess with no organization yet — the
deficit is surfaced, never silently zeroed. The last line is **AC3**: the boot
after the row was re-damaged healed 4 templates, and only 3 of them needed the
level stamp — the deliberately damaged row already carried `owner_level`, so it
took the `org_id`-only path that cannot fire `agent_owner_move_trg`.

`store-and-queue-facts.txt` shows the end state: every template carries an
`org_id`, `0` rows match the ownerless predicate, and the repro agent's
`owner_id` is still `<empty>` — the reconcile anchored it without ever
rewriting an owner column.

## The write path CHANGED after captures 01–05 — so it was re-proven

Codex round 1 returned NOT MERGE-SAFE on the version that produced captures 01–05
and forced three changes to the reconcile's write path (one transaction instead of
two commits; a second predicate arm; an in-transaction cleanup of the same-path
relocation rows the level stamp manufactures). Screenshots taken before that would
be evidence for code that no longer exists, so the heal was driven again, live, on
the FINAL code:

* both damaged shapes were re-seeded on the same instance
  (`@cinatra-ai/blog-draft-writer-agent` → shape A, `@cinatra-ai/blog-idea-generator-agent`
  → shape B) and `path_relocations` was emptied of agent-template rows;
* ONE boot healed them —
  `[agents/org-reconcile] healed 5 anchor(s) + 3 level stamp(s) onto org=d199d18e-… (scanned 5; 3 same-path relocation(s) dropped)`;
* `06-AC1-reproven-on-final-code.png` is Run reaching the agent setup screen again,
  on that final code, run `8c7ffaf0-…`.

A SECOND, genuinely fresh database was then run end to end on the same final code
(`cinatra_lane_2619b`, wizard, bypass OFF) to exercise the fresh-instance path
rather than a re-damage:

```
[agents/org-reconcile] skipped — no-organization (candidates=3, organizations=0) — those templates stay refused at run start
[agents/org-reconcile] (org bootstrap) healed 13 anchor(s) + 13 level stamp(s) onto org=845c2e20-… (scanned 13; 13 same-path relocation(s) dropped)
```

The boot arm refuses to guess while no organization exists; the wizard creates one;
the injected org-bootstrap arm heals. 24 templates were born correct through the
import direction and needed nothing. The repro agent ends `org_id` set,
`owner_level='organization'`, `status=published`. (The 3 remaining `NULL` rows are
the `@cinatra/system-*` residual described below.)

`final-code-reproof.txt` holds the raw output. Captures 03–05 (the trigger walk)
are unaffected: they exercise #2615's trigger service against an already-healed
row, and nothing in the round-1 remedies touches that path.

## Two residuals, disclosed rather than papered over

1. **One same-path `path_relocations` row survives**, for
   `@cinatra-ai/blog-idea-generator-agent`: `old_slug ':'` → `new_slug 'organization:'`,
   `status completed`. That row was written by the **shipped bootstrap DDL backfill**
   (`SET owner_level='organization', owner_id=COALESCE(org_id,'')`), which fires the
   same trigger and is present on `origin/main` today. This change cleans up only the
   rows its OWN level stamp creates; it does not touch `drizzle-store.ts`, which is
   the fresh-install twin of a shipped migration and out of this lane's bounds.
2. **Three `@cinatra/system-*` templates** (Scrape / Research / Enrichment) are seeded
   by a different path AFTER the boot phase has run, so on the boot that creates them
   they are still ownerless and heal on the NEXT boot — exactly the AC3 contract, and
   the same behaviour observed on every boot of this walk. They are internal system
   agents, not the bundled agents this issue is about, and their seeder is a separate
   `insert(agentTemplates)` that deliberately writes `org_id: null`. Out of scope here.

## Not proven here

The agent's actual LLM execution. The bundled WayFlow runtime this lane could
reach does not serve this agent, so the run fails at the WayFlow hop by design of
the environment. Everything up to and including the dispatch is proven; the
agent's own output is not, and is not claimed.
