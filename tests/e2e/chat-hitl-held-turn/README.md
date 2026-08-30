# chat-hitl S9k — the dev-runtime held-turn flow

The one place in this epic where the **runtime** is asked to produce a hold, rather
than a test being handed one.

Issue [#2824](https://github.com/cinatra-ai/cinatra/issues/2824), epic
[#2784](https://github.com/cinatra-ai/cinatra/issues/2784). Plan conformance:
[PLAN: Agents Lifecycle](https://github.com/cinatra-ai/engineering/wiki/PLAN:-Agents-Lifecycle)
§11 / §12.

## What it proves

A browser types one message into `/chat`. From there exactly **one** thing is
stood in for — the model layer, which on a key-free stack makes the one decision a
model makes here (which tool this turn calls) and words the answer. Everything
below it is real:

1. the conversation's own assistant calls `agent_run` — since
   [#2935](https://github.com/cinatra-ai/cinatra/issues/2935) (lifecycle-b W5d)
   nothing dispatches before the model — and the runtime creates a real
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

The driving message embeds its own `inputParams`, so the assistant passes on the
inputs the sentence states outright and invents none: the same message always
starts the same run with the same arguments.

Never run `pnpm seed` against this database — the seed truncates `agent_templates`.

## What is world, and what is subject

`fixtures.mts apply` writes three things, each through a **shipped writer**: an
OpenAI *presence* placeholder (no real key; generation is served by the scripted
provider, and under its flag the runtime reports a provider as available whether
or not this row exists — so the row is world for the instance rather than a
precondition of this flow's turn, written and restored so the instance is left as
it was found), the MCP public base URL, and **one**
`agent_assigned_skills` row. Without that row the recommendation scorer has no
candidate to offer, so the checkpoint answers "no recommendation candidates" and the
run dispatches unheld.

No hold, no park, no run and no decision is ever seeded. Those are the subject.

### And every one of them is put back — including the account's privileges

`auth.setup.ts` also grants an **identity** two permanent privileges so the dispatch
can happen at all: it appends `admin` to the account's Better Auth role string, and
it makes that account an `owner` of the organization owning the agent. The account
is chosen by `E2E_CHAT_HITL_USER_EMAIL`, so "it is only a test account" is not
something this suite may assume.

This suite runs on a developer's own dev instance and against a real account, so it
snapshots the state it is about to change **before** its first write and restores it
afterwards:

- the `restore` teardown project runs after the suite whether it **passed or
  failed**, which is the only kind of restore worth having;
- `fixtures.mts restore` puts the connection row, the MCP origin and the assignment
  back, then **re-reads all three** and prints `restore verified` only when they
  match the snapshot;
- `account-state.ts` removes the one `admin` token the promotion added and removes the
  membership row, then re-reads both and prints `account restore verified`. An
  account that **already** carried `admin` records `roleChanged: false` and is never
  written on either side — blindly stripping `admin` on the reuse path would revoke
  a grant this suite never made;
- `restore.teardown.ts` attempts **both** halves and asserts **both** verdicts, so a
  teardown that silently failed reds the run;
- **a teardown restores only ITS OWN run's snapshot.** Each snapshot is stamped with
  a run token minted once per `playwright test` invocation
  (`run-token.global-setup.ts`), and a teardown that finds a foreign snapshot — or
  no snapshot at all — prints `skipped: not this run's snapshot` and changes
  nothing. It never prints a verified verdict for a restore it did not perform, and
  it never deletes the other run's snapshot file. Without that stamp, a second run
  refused by the claim below still tore the FIRST run's account and instance down
  and consumed its snapshot, after which the first run's own teardown vouched for a
  restore that had already been taken from it;
- a snapshot file that is **already there** stops the run before its first write.
  It means an account this suite escalated has not been put back yet: either a run
  is in flight against the same account, or an earlier run was killed before its
  teardown. That file is the only record of the original state, so overwriting it
  would strand the grants for good. Inspect it, undo the grants it names, and
  delete it — or, for the instance half alone, run
  `node --conditions=react-server --env-file-if-exists=.env.local --import tsx
  tests/e2e/chat-hitl-held-turn/fixtures.mts restore` by hand, which is allowed to
  consume any snapshot precisely because no run token is set in that shell;
- **nothing is removed or cleared that this fixture did not write.** The restore
  does not replay the snapshot and does not act on "the snapshot said there was no
  row": it compares the **live** state against what the fixture itself wrote and
  reverts only that. The placeholder key's sealed bytes are fingerprinted at write
  time (a hash of the ciphertext — nothing is decrypted, and the value hashed is
  this suite's own published placeholder), so a **real key stored during the run is
  never cleared** and a **connection a developer created during the run is never
  deleted**. Same rule for the MCP origin pair and the assignment row. The rules
  live in `state-rules.ts` and are unit-covered by
  `__tests__/state-rules.test.ts`, which runs in the root vitest tier — no database,
  no browser, no stack;
- **the membership is identified by `(organizationId, userId)`**, which is what
  production's `member_org_user_uniq` enforces, on both the pre-read and the
  insert's conflict target. The synthetic id is only ever the id this fixture mints
  for a row it creates, and the delete is narrowed to it so a row a concurrent actor
  created for the same pair is never removed;
- **one predicate decides whether the account already carries `admin`.**
  `roleCarriesAdmin` answers it from the pre-read, and that answer gates the write.
  The promote and the strip statements are built from a single SQL token expression,
  so a role spelled `" admin"` can no longer read as absent on one side and present
  on the other;
- both halves restore and assert **only what the snapshot recorded as changed**. The
  claim is "everything I changed, I put back", not "nothing on this instance moved
  while the suite ran" — the wider claim would erase a developer's concurrent edit
  under a passing verdict, and would red on a `lastValidatedAt` stamp that has
  nothing to do with this suite;
- an instance that **already holds an OpenAI key** gets no connection write at all:
  presence is already satisfied, and overwriting a sealed key is a change no
  teardown could undo without holding credential material on disk. The snapshot
  carries the row's non-secret fields only, read without decrypting anything;
- a row this fixture *created* is removed rather than factory-reset, because "no
  row" and "a default row" are different states to every reader — but only while it
  is still, provably, the row this fixture created.

## The evidence it writes

Screenshots go through the S9h recorder (`scripts/audit/lib/chat-hitl-capture-recorder.mjs`)
at the **`audit`** tier, so each record is graded on everything it claims, and a
violation fails the test rather than being logged. Every record is labeled
`build: "development"` per the 2026-08-13 capture ruling.

They are **provisional**. S9g alone adopts and canonicalizes AC-15 records, so
nothing here is written to the canonical capture index.

### Runs mint into scratch; the committed set is the frozen reference

Two directories, and the difference is the whole policy:

- The **frozen reference** — four graded PNGs and one
  `capture-index.provisional.json` — is pinned in history at
  <https://github.com/cinatra-ai/cinatra/blob/ec30b7513c6541ec01af7dbef1d0a1979dc074f0/evidence/2824-s9k>.
  Nothing a run does touches it, and the hashes cited in that PR's round comments
  stay true for as long as that commit does.
- **`test-results/chat-hitl-held-turn-captures/`** is where **a run mints**. It is
  the Playwright config's own gitignored `outputDir`, so a passing run — a
  developer's, or the #2886 CI job — leaves `git status --porcelain` **empty**.

Re-recording the set is a **deliberate** act, never a side effect of running the
suite. Point the run directory somewhere of your own and drive a full green run:

```
E2E_CHAT_HITL_EVIDENCE_DIR=test-results/my-refresh pnpm test:e2e:chat-hitl-held-turn
```

That writes four PNGs and an index from a run graded at the `audit` tier — which
is the only kind of capture worth citing. Nothing is committed: proof pictures are
posted on the PR and cited by permalink, never carried in the product tree.

The scratch root is the recorder's own `CAPTURE_OUTPUT_ROOT`. The recorder
**refuses** a screenshot path outside it, before the shutter, and grades the same
rule again when it validates the record — so a record is honest only when its
`screenshot` field names where the file really is.

## Why `retries: 0`

#2824 asks for a *deterministic* proof. A retry converts an intermittent runtime
defect into a green check, which is exactly the failure mode a required gate must
not have. If this suite is flaky, that is a finding about the runtime and it should
be read as one.
