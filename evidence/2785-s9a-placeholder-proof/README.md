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
was a closed set of six names — `agent_run`, the two content-editor stand-ins,
`artifact_review_gates_list` and the two `*_render` primitives.
`schedule_proposal_render` was in none of them, on this branch or on the default
branch. So no turn on a key-free stack could reach the §VI producer, and the card
had no way to appear in a conversation at all.

This round adds the missing arm. It changes **two files, and one of them is the
assistant runtime** — said plainly, because "model layer only" would be wrong:

- `packages/llm/src/scripted-test-provider.ts` — a schedule intent, the producer's
  name, a reader for the template the turn names, and one branch that dispatches
  it. The arm is inside the same production fence as every other arm.
- `src/lib/assistant-runtime/runtime.ts` — one condition on the scripted
  short-circuit, so a turn the provider claims as a schedule question takes the
  same path the lifecycle question already took. The runtime still invents no
  intent of its own; it asks the provider, as before. This is a change to the
  central assistant runtime, not to a test double.

**The arm synthesizes most of the schedule, and that is a limit on what the
capture proves.** Only two values come out of the sentence: the template
identifier and the time of day. The `recurring` kind, the `UTC` timezone, the
`daily` frequency, the interval and the unused calendar fields are fixed choices
of this module. A real model would read all of them off the request. So a capture
driven through this arm proves the PRODUCER and the CARD; it does not prove a
model's reading of a schedule, and it is not offered as that.

**Behavioural reach, stated rather than left to be discovered.** Any signed-in
chat turn under the development flag whose text matches the schedule word set now
takes the scripted short-circuit. A turn that matches but names no template
dispatches nothing at all and keeps its streamed text — it deliberately does not
fall through to the gate listing, because answering a scheduling sentence with a
review backlog would be this seam inventing an intent nobody expressed. A
sentence that genuinely asks both still reaches the pull, decided by the pull's
own predicate exactly as before.

**What this does NOT change.** The producer, its authorization, the proposal
token, the envelope, the sink's recognizer, the card registry, the S1 shell and
every gate contract are untouched. The arm grants no authority: the tool it names
writes nothing. The provider cannot forge a card through the sink shown here —
the envelope is built inside the tool handler, and the recognizer accepts it only
from the server label the runtime stamps from a dispatch it actually performed.
The required gate re-ran after the change and its output was byte-identical to
`required-gate-run.txt` as that file stood AT S9a. That sentence describes S9a's
own change. The committed copy has moved for TWO reasons since, because the gate
suite holds it byte-identical to a fresh run: cinatra#2789 (S9e) drew the
verification card, and cinatra#2786 (S9b) enumerated the `chat_thread` mount for
`recommendation_hold`. Each retired a finding, and this head is the first tree
that carries both (see the table below). The S9a claim above is about the S9a
run, not about the bytes in the file today.

**One sentence in the pull-request body is now narrower than the tree.** That
body says the product diff against the default branch is empty. It no longer is:
it is these two files. The acceptance argument that body carries is
unaffected, because the one-card gate reads card owners, mounts and the registry,
and none of those is touched — but the sentence should be read as "no card
module is touched", which is what it was always claiming.

If the arm belongs in the slice that draws the schedule card rather than here, it
moves without the proof having to be re-argued: the capture programs are
committed, so the same two cells can be re-shot on whichever branch carries it.
The images below are evidence of the tree captured here and of nothing else.

## The runtime and the stack

DEV RUNTIME, named for every cell in this record and in each capture log's
first lines, which is the standing rule for a dispatch-dependent capture. The
screenshots themselves carry no burnt-in runtime label; the label lives here and
in the logs: `pnpm dev`, `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, `CINATRA_TEST_LLM_PROVIDER=scripted`. Neither
production fence (`assertScriptedProviderNotProduction`, `lifecycleSeedEnvVerdict`
FENCE 1a) was weakened; this branch does not touch them. **The capture
instance's `.env.local` holds no provider key**, and none was added to the
process environment: the scripted branch runs before any adapter resolves, so no
key is read, used or stored on this path.

`CINATRA_E2E_SETUP_BYPASS=true` was set. It is used here to skip the SETUP
WIZARD. It is not a no-op elsewhere in the codebase — it also makes the dataless
design-fixture routes reachable under a production build and arms a notifications
degrade path — and none of those surfaces is touched by either capture.

Throwaway Compose project `s9aproofcap` — own Postgres (55432), own Redis
(56379), own volumes, own network, own BullMQ queue name
(`cinatra-s9aproofcap-jobs`), dev server on 3105. Fresh database, provisioned
with `apply-public-schema.mjs` then `auth:migrate`. The operator's own Compose
project was never started, stopped or written to. It was READ once, at teardown:
the last line of `teardown-log.txt` lists Compose projects to show it still
running and untouched, and that listing is the only contact of any kind.

`teardown-log.txt` counts the stack before and after: 2 containers, 2 volumes,
1 network, 1 dev server, all removed.

`docker-compose.s9aproofcap.yml` is the throwaway stack's own definition,
committed so the ports, volumes and network above can be checked rather than
taken on trust.

## The cells

| cell | runtime | what it shows |
|---|---|---|
| `S9a-a__chat_thread__schedule-proposal-placeholder.png` | **development** | A scheduling request typed into the real composer. The assistant calls `schedule_proposal_render`, and what draws in the assistant turn is the S1 shell: a bordered strip reading "Schedule proposal / Waiting for your decision." No option rows, no Adjust, no Confirm. The thread and the composer are in frame. |
| `S9a-b__chat_thread__verification-placeholder.png` | **development** | The verification reading asked for by its ref, in a real conversation. The assistant calls `verification_record_render`, and what draws is the same shell: "Verification / Advisory reading." No outcome pill, no revisions, no fields. Thread and composer in frame. |
| `required-gate-run.txt` | — | The verbatim run of the required gate, exit 1, findings unfiltered. ROLLING RECORD, not a frozen S9a artifact: `scripts/audit/__tests__/chat-hitl-one-card-gate.test.mjs` compares this file byte for byte against a fresh run, so every change to the gate's output must land here too, and a stale copy is a red test. It read FIVE findings at S9a, naming both undrawn kinds. It read FOUR after cinatra#2789 (S9e) drew the verification card, which retired that kind's `[R5]` line. It read TWO after cinatra#2790 (S9f) enumerated the skills card's `site_widget` and `page_gate_region` mounts, and THREE on main after cinatra#2786 (S9b) enumerated its `chat_thread` adapter with a counted instance proof. **Re-recorded here, where the two land together:** all four hosts now carry a mount, so every `[R8]` host-gap line is retired and the file reads ONE finding. That one names the last undrawn kind — `trigger_schedule_proposal` — and that, not a count, is what this row is evidence of. The two captures above are dated evidence of the moment S9a proved and are unchanged. |

`capture-a-log.txt` and `capture-b-log.txt` were printed by the two capture
programs committed beside them — `capture-a-schedule.mjs` and
`capture-b-verification.mjs`. Read those two files: every line in the logs is
printed by one of them, so the assertions can be audited rather than believed,
and re-run rather than trusted.

**One substitution before a re-run.** Both programs carry `OUT = "<home>/…"`.
`<home>` is a placeholder, not a path: the operator's real home directory was
scrubbed out of these files on review, and no real path is restored here.
Replace `<home>` with your own home directory before you run either program. The
`OUT` directory is where the program reads `storage-state.json` and writes its
log and its screenshot; nothing else in either file depends on the location.

**One guard the logs predate.** Each program now stops with a non-zero exit if
the card it is about to photograph is missing, is not unique, or does not carry
the identity the log prints — a missing card used to yield zero anchor counts,
"ALL ABSENT: true" and exit 0, which is a passing proof of a page that drew
nothing. The guard prints nothing on the passing path, so both committed logs
are still byte-for-byte what the committed programs print on the runs they
record. The captures were not re-run to add it.

**One redaction, marked in place.** `teardown-log.txt` line 9 had the framework
version token the process table printed. The source-leak gate flags that shape,
so the token is replaced by a marker naming exactly what was removed and why.

## What this record ATTESTS rather than proves

A second read-only adversarial review of this round drew a line worth keeping
rather than papering over: a committed tree can prove that a program COULD have
printed a log, and cannot prove that it DID. So the statements below are the
author's attestation. They are not derivable from the files, and a reader should
treat them as claims:

- that the two logs are the unmodified output of the two committed programs,
  changed only by the one marked redaction above and by nothing else;
- that the operator's own Compose project was contacted exactly once, by the
  listing at the end of `teardown-log.txt`;
- that the required gate re-ran byte-identical after the model change. Only one
  gate output is committed, so a reader cannot diff the two — and that single
  file is a rolling record of the CURRENT gate output, so it no longer holds the
  S9a-era bytes at all.

What the tree DOES prove is checkable and is the part the claim rests on: the
programs contain no DOM injection, no stubbed fetch and no hand-written data
part; their anchor lists match the ratified contracts exactly; and their selector
rule is the gate's own. The captures can be re-run.

**One commit message is wrong and cannot be rewritten.** The commit that added
these two cells calls the change "two model-layer files". One of them is the
assistant runtime, which is not a model-layer file. The message stands as
written because the branch is never force-pushed; this record is the correction.

## What is real, and what stands in

**Real** in both cells: the application, the `/chat` surface, the composer, the
conversation, the assistant runtime, the self-MCP transport carrying the signed-in
person's own chat credential, the producer tools and every authorization behind
them, the proposal token, the review gate, the repair, the verification record,
the `DATA_PART`, the card registry and the S1 shell. Both messages were typed into
the real composer of a real thread.

**Stood in for: the model.** The scripted provider decides which tool the turn
calls, and for the schedule cell it also composes the schedule arguments, as the
section above states. It cannot fabricate a card through this path — the envelope
is built inside the tool handler and the sink accepts it only from the (`cinatra`
server label, allowlisted tool) tuple the runtime stamps from the dispatch it
actually performed. The runtime condition that routes these turns is the second
changed file, so the seam a reader should audit is those two files plus the two
capture programs, all committed here.

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

## The layout, recorded before any pixel

Two mentions flip the thread into Slack layout, which suppresses `parts` — and
`parts` is the only mount point at a tool-call position. Both driving messages
carry **zero** mention tokens, and both captures READ the layout off the app's
own persisted thread and record it in their logs before a screenshot is taken.
"Record", not "assert": the programs `say()` these values, they do not throw on
them, so what follows is a reading a reader can check against the logs rather
than a condition the run enforced. The log lines themselves are quoted verbatim
below and in `capture-a-log.txt` / `capture-b-log.txt`, where they carry the
programs' original wording.

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
