# chat-hitl S9k — the dev-runtime held-turn flow

The one place in this epic where the **runtime** is asked to produce a hold, rather
than a test being handed one.

Issue [#2824](https://github.com/cinatra-ai/cinatra/issues/2824), epic
[#2784](https://github.com/cinatra-ai/cinatra/issues/2784). Plan conformance:
[PLAN: Agents Lifecycle](https://github.com/cinatra-ai/engineering/wiki/PLAN:-Agents-Lifecycle)
§11 / §12.

## What it proves

A browser types one message into `/chat`. From there nothing is simulated:

1. the runtime routes the turn through its own hard pre-router and creates a real
   run that **parks** — `agent_runs.status = pending_input`, `human_present = true`,
   a `recommendation` park row in `parked`, and **zero** queue jobs behind it;
2. the transcript draws the §V card at the `agent_run` producing slot, on the
   `chat_thread` host, in state `held`, with §V's three per-chip controls and
   without the retired row-level Confirm/Skip;
3. the person decides **in the chat** — Confirm in one held run, Skip in a second,
   separately held run, because one hold cannot be both;
4. the same card settles **in place**: state `decided`, nothing left to press, and
   the URL unchanged across the decision;
5. the run advances — the park reads `released` and **exactly one** queue job names
   the run;
6. reloading the same thread brings the settled card back.

Every DOM claim is paired with a claim read out of Postgres and Redis. That pairing
is the point: a card drawn over a run that was dispatched anyway satisfies every
selector in the spec, and is precisely the defect this gate exists to catch.

## Running it

```
pnpm test:e2e:chat-hitl-held-turn
```

The config boots its own `pnpm dev` on `E2E_CHAT_HITL_PORT` (default 3126) with the
deterministic scripted provider. It needs, in the environment or `.env.local`:
`SUPABASE_DB_URL`, `REDIS_URL`, `BULLMQ_QUEUE_NAME`, `BETTER_AUTH_SECRET`,
`CINATRA_ENCRYPTION_KEY`, and a `BETTER_AUTH_URL` matching the port.

A fresh database is `node scripts/apply-public-schema.mjs` plus `pnpm auth:migrate`
— never `pnpm db:migrate`. A fresh checkout also needs
`node scripts/ci/sync-dev-extensions.mjs --pinned` followed by a second
`pnpm install`: the agent this flow dispatches and the skill it assigns are
materialized at boot from the companion extension repos, and without them the app
does not boot at all.

## Which agent, and why it is the only one

`@cinatra-ai/lint-policy-agent`. Three constraints leave exactly one candidate, and
each was learned by watching a dispatch be refused:

1. it must be **installed**, not merely registered — most agents ship as opt-in
   extensions and are refused with *"Agent is not installed … Install it from the
   marketplace"*, so only the **required closure** qualifies, and the required
   closure is what every boot materializes;
2. it must **not** be a creation-flow package (the reviewer lanes and the author
   lane), because those take an Anthropic-pin preflight whose catalog-sync state has
   nothing to do with a recommendation hold;
3. it must declare **no required connector dependencies**, or
   `assertAgentRunReadyByPackage` refuses the dispatch as unconfigured.

`lint-policy-agent` is installed by the required closure, is deliberately excluded
from the creation-flow set, and declares no dependencies at all. That it is itself
"skill-free" costs nothing: the scorer offers whatever sits in
`agent_assigned_skills` for the package, and the fixture puts one row there.

The driving message embeds its own `inputParams`, so the dispatch takes the
brace-matched deterministic fast path and **no model is consulted for anything**.

Never run `pnpm seed` against this database — the seed truncates `agent_templates`.

## What is world, and what is subject

`fixtures.mts apply` writes three things, each through a **shipped writer**: an
OpenAI *presence* placeholder (no real key; generation is served by the scripted
provider, and without a bound provider adapter the turn goes conversation-only and
the pre-router never fires), the MCP public base URL, and **one**
`agent_assigned_skills` row. Without that row the recommendation scorer has no
candidate to offer, so the checkpoint answers "no recommendation candidates" and the
run dispatches unheld.

No hold, no park, no run and no decision is ever seeded. Those are the subject.

### And every one of them is put back

This suite runs on a developer's own dev instance, so it snapshots the state it is
about to change **before** its first write and restores it afterwards:

- the `restore` teardown project runs after the suite whether it **passed or
  failed**, which is the only kind of restore worth having;
- `fixtures.mts restore` puts the connection row, the MCP origin and the assignment
  back, then **re-reads all three** and prints `restore verified` only when they
  match the snapshot — `restore.teardown.ts` asserts that verdict, so a teardown
  that silently failed reds the run;
- an instance that **already holds an OpenAI key** gets no connection write at all:
  presence is already satisfied, and overwriting a sealed key is a change no
  teardown could undo without holding credential material on disk. The snapshot
  carries the row's non-secret fields only, read without decrypting anything;
- a row this fixture *created* is removed rather than factory-reset, because "no
  row" and "a default row" are different states to every reader.

## The evidence it writes

Screenshots go through the S9h recorder (`scripts/audit/lib/chat-hitl-capture-recorder.mjs`)
at the **`audit`** tier, so each record is graded on everything it claims, and a
violation fails the test rather than being logged. Records land in
`evidence/2824-s9k/capture-index.provisional.json`, labeled `build: "development"`
per the 2026-08-13 capture ruling.

They are **provisional**. S9g alone adopts and canonicalizes AC-15 records, so
nothing here is written to the canonical capture index.

## Why `retries: 0`

#2824 asks for a *deterministic* proof. A retry converts an intermittent runtime
defect into a green check, which is exactly the failure mode a required gate must
not have. If this suite is flaky, that is a finding about the runtime and it should
be read as one.
