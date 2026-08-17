# S9a — the two transcript cards are placeholders

This slice's central claim is visual: two of the four lifecycle kinds are not
drawn. The claim needs three proofs. All three are here.

Captured 2026-08-17 on the DEVELOPMENT RUNTIME, on the real application, against
this branch. The two chat cells replace the earlier round's "not delivered"
record.

## Read this first — one product change was needed, and it is not evidence

The ruling for the schedule cell is **real dispatch**: a person types a
scheduling request, the assistant calls `schedule_proposal_render`, and the card
that draws is photographed inside that conversation. That could not be done on
this branch, and the reason is code, not scheduling.

**The deterministic scripted provider could not name that tool.** Its vocabulary
was a closed set of five names — `agent_run`, the two content-editor stand-ins,
`artifact_review_gates_list` and the two `*_render` primitives. `schedule_proposal_render`
was in none of them, on this branch or on the default branch. So no turn on a
key-free stack could reach the §VI producer, and the card had no way to appear in
a conversation at all.

This round adds the missing arm, in the **model layer only**:

- `packages/llm/src/scripted-test-provider.ts` — a schedule intent, the producer's
  name, and one branch that dispatches it for the template the turn names. The
  arm is inside the same production fence as every other arm.
- `src/lib/assistant-runtime/runtime.ts` — one condition, so a turn the provider
  claims as a schedule question takes the same short-circuit the lifecycle
  question already took. The runtime still invents no intent of its own; it asks
  the provider, exactly as before.

**What this does NOT change.** The producer, its authorization, the proposal
token, the envelope, the sink's recognizer, the card registry, the S1 shell and
every gate are untouched. The arm grants no authority: the tool it names writes
nothing. Both gate outputs are byte-for-byte what this branch already recorded —
`required-gate-run.txt` re-ran identical after the change.

**One sentence in the pull-request body is now narrower than the tree.** That
body says the product diff against the default branch is empty. It no longer is:
it is these two model-layer files. The acceptance argument they carry is
unaffected, because the one-card gate reads card owners, mounts and the registry,
and none of those is touched — but the sentence should be read as "no card
module is touched", which is what it was always claiming.

If the arm belongs in the slice that draws the schedule card rather than here, it
moves without costing this proof: the images and the logs stay true of whatever
branch carries the arm.

## The runtime and the stack

DEV RUNTIME, named on every cell, which is the standing rule for a
dispatch-dependent capture: `pnpm dev`, `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, `CINATRA_TEST_LLM_PROVIDER=scripted`. Neither
production fence (`assertScriptedProviderNotProduction`, `lifecycleSeedEnvVerdict`
FENCE 1a) was weakened; this branch does not touch them. **No real provider key
is present in the capture instance's environment: none was read, used or stored.**

`CINATRA_E2E_SETUP_BYPASS=true` was set. It skips the SETUP WIZARD and nothing
else; it is disclosed here because it is an env switch a reader should see named.

Throwaway Compose project `s9aproofcap` — own Postgres (55432), own Redis
(56379), own volumes, own network, own BullMQ queue name
(`cinatra-s9aproofcap-jobs`), dev server on 3105. Fresh database, provisioned
with `apply-public-schema.mjs` then `auth:migrate`. The operator's own project was
never started, stopped, read or written. `teardown-log.txt` counts the stack
before and after: 2 containers, 2 volumes, 1 network, 1 dev server, all removed.

## The cells

| cell | runtime | what it shows |
|---|---|---|
| `S9a-a__chat_thread__schedule-proposal-placeholder.png` | **development** | A scheduling request typed into the real composer. The assistant calls `schedule_proposal_render`, and what draws in the assistant turn is the S1 shell: a bordered strip reading "Schedule proposal / Waiting for your decision." No option rows, no Adjust, no Confirm. The thread and the composer are in frame. |
| `S9a-b__chat_thread__verification-placeholder.png` | **development** | The verification reading asked for by its ref, in a real conversation. The assistant calls `verification_record_render`, and what draws is the same shell: "Verification / Advisory reading." No outcome pill, no revisions, no fields. Thread and composer in frame. |
| `required-gate-run.txt` | — | The verbatim run of the required gate, exit 1, six findings unfiltered, naming both undrawn kinds. |

`capture-a-log.txt` and `capture-b-log.txt` are the unedited machine output.

## What is real, and what stands in

**Real** in both cells: the application, the `/chat` surface, the composer, the
conversation, the assistant runtime, the self-MCP transport carrying the signed-in
person's own chat credential, the producer tools and every authorization behind
them, the proposal token, the review gate, the repair, the verification record,
the `DATA_PART`, the card registry and the S1 shell. Both messages were typed into
the real composer of a real thread.

**Stood in for: the model layer, and nothing else.** The scripted provider decides
which tool the turn calls. It cannot fabricate a card — the envelope is built
inside the tool handler and the sink accepts it only from the (`cinatra` server
label, allowlisted tool) tuple the runtime stamps from the dispatch it actually
performed.

**Two disclosed preconditions**, neither inside the thing under test:

- Cell (a) names its template by identifier, because this provider holds no store
  and cannot resolve "the blog writer" to a row. That is the same stand-in the run
  card's own arm already makes, for the same reason, and it grants nothing: the
  real primitive decides whether the template exists and whether the asker may
  reach it.
- Cell (b) needs a run to hang its fixture on, and a fresh instance has none. One
  was created by the shipped run-start route (`/agents/cinatra-ai/planner-agent/new`),
  navigated to in the browser. Then the **existing** development seed
  (`POST /api/development/lifecycle-seed`, `fixture: repairVerification`) drove the
  shipped writers only: a real review gate, a real repair, a real successor gate,
  and a real verification record bound to it, outcome `drifted`. No seed arm was
  added and no row was hand-written.

## The layout, asserted before any pixel

Two mentions flip the thread into Slack layout, which suppresses `parts` — and
`parts` is the only mount point at a tool-call position. Both driving messages
carry **zero** mention tokens, and both captures assert the layout against the
app's own persisted thread before a screenshot is taken:

| | cell (a) | cell (b) |
|---|---|---|
| mention tokens in the driving message | `0` | `0` |
| `slackMode === false` | `true` | `true` |
| `taggedAssistantUserIds` | `[]` | `[]` |
| `parts.length > 0` | `true` (`parts=2`) | `true` (`parts=2`) |
| assistant `dataParts` viewTypes | `["trigger_schedule_proposal"]` | `["verification_summary"]` |
| page errors | `0` | `0` |

## The card identity, read off the live DOM

The S1 shell emits two of the three root attributes. Both are PRESENT on both
cells; the third is absent, and its absence is part of what makes these
placeholders rather than cards.

| | cell (a) | cell (b) |
|---|---|---|
| instances of the kind selector | `1` | `1` |
| `data-lifecycle-card` | `"trigger_schedule_proposal"` — PRESENT | `"verification_summary"` — PRESENT |
| `data-lifecycle-card-state` | `"pending"` — PRESENT | `"advisory"` — PRESENT |
| `data-lifecycle-card-host` | `null` — the shell emits none; an owner must | `null` — same |
| inside the conversation list | `true` | `true` |
| rendered text | `"Schedule proposal / Waiting for your decision."` | `"Verification / Advisory reading."` |

The verification state resolving to `advisory` is the resolver's own answer for
this kind, which is what the earlier round predicted it would be.

## The ratified anchors, enumerated and absent

The absence IS the evidence, so each anchor is named and counted rather than
summarized. Every list below is copied verbatim from `LIFECYCLE_CARD_CONTRACTS`
in `scripts/audit/chat-hitl-one-card-gate.mjs`, which reads them off the ratified
drawing. A bare conformance id is counted as `[data-conformance-id="…"]`, the
gate's own rule; an anchor already written as a selector is counted as written.
Each is counted twice — inside the card and across the whole document — so
"absent" cannot hide behind a narrow scope.

**Cell (a) — §VI, the schedule proposal. All five ABSENT, `inCard=0 inDocument=0`:**

1. `schedule-option-rows`
2. `schedule-proposal-floor`
3. `scheduled-run-chrome`
4. `[data-action="cancel-trigger-schedule"]`
5. `[data-action="release-trigger-now"]`

**Cell (b) — §VII, the verification card. All four ABSENT, `inCard=0 inDocument=0`
— the base anchor plus every member of the ratified one-of outcome group:**

1. `verification-in-thread`
2. `verification-verified`
3. `verification-drift`
4. `verification-findings-not-met`

Cell (b) is worth stating twice: the seeded record's real outcome is `drifted`,
so a drawn card would have to render the drift outcome. `verification-drift` is
absent anyway. The reading exists; the card does not.

## Provisional under the capture-ownership rule

These two cells are provisional wherever they are produced. The canonical cell
names, the capture index and the manifest's move to proven belong to the final
conformance slice. The names here are chosen to be as close to the eventual ones
as possible.
