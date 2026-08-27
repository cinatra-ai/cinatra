# cinatra#2930 W3 (PR #3014) — the HITL screen card, pictured on the hosts a real run can reach

Twelve pictures, six readings, one run. Every picture is a full browser window at
1440×900, device scale 2, uncropped, light **and** dark, taken on a booted app with
a real model provider, on a run the app's own dispatch created out of a real
conversation. `capture-records.json` carries the SHA-256, the URL, the resolved
theme, every anchor counted in its own scope and the database readback at each
shutter; `page-controls.json` carries what each card actually held — its controls,
its labels, its text and its rectangle — read off the DOM rather than inferred
from the pixels. `TIMELINE.md` puts the shutters beside the database's own clock.
`RUN-READBACK.md` carries the rows.

## The headline, first

**The card is real, it is one card, and it is the same card on both hosts a real
run reaches.** A run that stops to ask draws exactly ONE lifecycle card — the
kind's own root, carrying the kind, the host and the state — in the conversation
it was started from and on its own run page, in both themes, and the question is
answered from inside the card: pressed there, the run moved and the answer landed
in its inputs. Pressed on the mid-run question, the card's OWN `Continue` —
`[data-action="submit-hitl-screen"]` — resumed the run, which then ran to
`completed`.

**And three things this round found that the pull request does not say.**

1. **There is no ratified drawing of this card at the contract's own pin.** The
   contract pins `specCommit` `design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f
   specs/app-lifecycle-cards.html`. Both files were fetched at that exact commit
   (reads only) and rendered. `specs/app-lifecycle-cards.html` has twelve sections
   and draws four cards — review, verification, recommendation, schedule proposal
   — and the strings `HITL`, `pause`, `human input` and `awaiting` do not occur in
   it at all. Its §IX presence matrix names those same four cards and no fifth.
   `specs/app-components.html` has no pause screen either: its sections are the
   generic component drawings plus *Standard scheduling step* and *Retiring the
   in-stepper trigger HITL*, which is about scheduling. The pull request's
   **deviation 1** states that "the drawing is not missing but is in a SIBLING
   file at the same commit: the HITL screen is the PAUSE SCREEN in
   `specs/app-components.html`". **That reading does not survive opening the
   file.** The three rendered drawings are in `drawings/`.
2. **The shipped capture recorder refuses a record of this kind, so the picture
   leg the pull request owes cannot be registered in the canonical index on this
   head.** The branch's own path from a browser to a record is
   `scripts/audit/lib/chat-hitl-capture-driver.mjs --walk`. It was pointed at the
   cells and it refused, twice, in the two places the vocabulary is closed:

   ```
   cell "HC-light__chat_thread__hitl-screen-asking": kind "agent_hitl_screen" is not one of
     artifact_review_gate/recommendation_hold/trigger_schedule_proposal/verification_summary
   cell "HC-light__chat_thread__hitl-screen-asking": state "asking" is not one of pending/decided
   ```

   and, with the kind omitted:

   ```
   record "HC-light__chat_thread__hitl-screen-asking": a chat_thread record must declare the
     lifecycle `declaredKind` it photographed (one of artifact_review_gate/recommendation_hold/
     trigger_schedule_proposal/verification_summary) — it declares "undefined"
   ```

   The code facts: `scripts/ci/lib/capture-record-contract.mjs:161` `CARD_KINDS`
   holds four kinds and no `agent_hitl_screen`;
   `scripts/audit/lib/chat-hitl-capture-recorder.mjs:232` derives `LIFECYCLE_KINDS`
   from it; `:247` fixes `CAPTURE_STATES` to `["pending", "decided"]`; `:1063`
   makes a declared kind out of that list mandatory for a `chat_thread` record;
   `:1470`–`:1474` refuse a plan that names either outside those lists. This slice
   draws a fifth kind and a third state and edits neither file, so the canonical
   index cannot bind a cell of it. **Nothing was changed to work around this**:
   `scripts/ci/chat-hitl-capture-index.json` is untouched at its committed 81
   records, and the pictures were taken by a lane driver
   (`drivers/07-capture-cells.mjs`) that writes the SAME shape beside them.
3. **In the conversation, the card draws a second primary input beside the chat
   box.** §I of the pinned drawing states the rule in as many words, under the
   heading *"The rule, wherever a card meets a chat box"*, and it is quoted in the
   cell verdicts below. The card's field on `chat_thread` keeps the enclosing box,
   the raised ground and a send affordance — the three things that rule says a
   card's field gives up. On `run_card` the same treatment is what the same rule
   asks for, and it passes there.

## The real path to a HITL screen, and which moment it is

Establishing this was half the round, because two different parks look alike.

- The **skills park** is `pending_input` with the `recommendation_hold` card:
  `packages/agents/src/lifecycle-coordinator.ts:720` creates a run
  `initialStatus: parkOnCreate ? "pending_input" : "queued"`, and the
  recommendation hold opens from there. That is NOT this moment.
- The **HITL screen** is `pending_approval`, and for the setup loop the run states
  the moment itself: `packages/agents/src/execution.ts:2659` CASes
  `queued → pending_approval` and, only after that CAS wins, `:2681` calls
  `onAgentHitl` — *"THE SETUP LOOP ONLY. This branch is the agent asking for a
  field it needs — which is what the `hitl` moment IS."*

The run in these pictures is `@cinatra-ai/blog-draft-writer-agent`, asked for in
the app's own chat in the person's own words — *"Please run the Blog Draft Writer
Agent for me now."* — and created by the app's own dispatch. It reached **two**
HITL screens, and both are pictured:

| | gate | `x_renderer` | field | moment stated | the card's own Continue |
|---|---|---|---|---|---|
| **the setup screen** | `setup-<runId>` | `@cinatra-ai/agent-builder:schema-field-fallback` | `idea` | `hitl` / `agent_hitl_screen` | not drawn — see the verdict |
| **the mid-run screen** | `wayflow-<a2aTaskId>` | `@cinatra-ai/context-selection-agent:context-selector` | — | none | **drawn and live** |

The mid-run screen is the one the pull request's own sentence describes — *"when
an agent stops in the middle of a run to ask you something"* — and it is the one
whose renderer is manifest-declared `midRunHitl: true`
(`src/lib/generated/agent-bindings.ts:33`), which is what makes
`classifyHitlGate` draw the outer `Continue`
(`packages/agents/src/agent-hitl-screen-card.tsx:313`–`321`). The setup screen is
the one that STATES the moment. Neither alone answers the claim; together they do.

## The runtime, said first

`pnpm dev` (Next.js 16.2.10, Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, on a **dedicated lane database** on the local verify
Postgres and Redis, loopback-only, with this branch's own pinned extension tree
(112 packages) and its bundled dev package registry and agent runtime container
brought up from this checkout. It is **not** a production-equivalent build: these
are the dev builds of the same components, and every record is labelled
`development`.

**A REAL MODEL PROVIDER, configured through the app's own form.** The instance's
provider was set up on `/setup/model` by a driver that read the credential from
its process environment and typed it into the shipped form, so the app sealed the
connection itself. The credential is in no file here, in no argument, in no log
and in no record. `CINATRA_TEST_LLM_PROVIDER` is set in nothing this lane starts.
What is positively established is the other side: `cinatra.usage_events` records
the calls the instance actually made — `openai` / `gpt-5.5` (2 streamed chat
turns) and `openai` / `gpt-5.5-2026-04-23` (11 generate calls inside the run).
`RUN-READBACK.md` §3 carries the counts and the limits of every reading.

**The public origin was set through the app's own UI** at
`/configuration/development?tab=tunnel` — origin only, never by hand-editing the
database — and read back through the app's own `/api/mcp-settings`. The funnel
answered `200` before any pictured turn.

**The instance namespace** was provisioned through the app's own `/setup/name`
step before any run materialised an artifact.

## The direct-SQL lane writes, disclosed — there are two

Both are account provisioning for a throwaway lane account on a database that is
dropped when the lane ends. Neither touches a run, a trigger, a gate, a record or
any row a photographed screen reads.

1. **`UPDATE public."user" SET role='admin'`** (`drivers/01-lane-setup.mjs`) — the
   setup and configuration screens this lane walks are admin-gated.
2. **`INSERT INTO public.member`** (`drivers/04-join-template-org.mjs`) — the lane
   account joins the organization the instance's own boot stamped every agent
   template with. A run proposal is refused outright for a template outside the
   caller's active organization.

`grep -rniE "insert into|update |delete from" drivers/` returns exactly those two
statements and nothing else. The narrower seeding screen —
`grep -rniE "insert into|SEEDED_|seedGate|seedTurn|update .* set status"` —
returns only the `INSERT`, and it is quoted here as the screen it is rather than
as the write inventory, which is the list above. **No run, gate, park, record or
review task in this lane was inserted, and no status was written by hand.**

## The requires, from the pinned drawing, verbatim

Every clause below is copied character-for-character out of the two files fetched
at the contract's `specCommit` and rendered in `drawings/`.

**§I, the conversation — the chrome a card in a thread is drawn in.**

> "A **card takes that content slot**, at the column's full width, exactly where prose would otherwise sit."

> "The **assistant's** turn is left-aligned and carries **no bubble** — the Cinatra mark and name, then the content on the thread ground, filling the column."

> "**The rule, wherever a card meets a chat box** — Exactly one primary input is drawn per conversation, and it is the chat box. Any field a card carries is drawn subordinate to it. Where there is **no** chat box to be subordinate to — the run page and the review page — the card's field is the only input there is and takes the primary treatment instead. The hierarchy is between the two inputs, not a fixed look for either one."

> "**How the weight is taken off it.** The note field gives up the three things that make the chat box read as somewhere to type — the **enclosing box**, the **raised ground** and the **send affordance** — and keeps a single quiet ruled baseline under a mono label."

**§IX, where each card appears — the parity the slice is built on.**

> "Every card appears on **every** host, and it is the **same card** wherever it appears: the same regions, the same states, the same data on screen, and the same actions its reader is authorized to take. Only the **frame** changes — the thread, the widget's panel, the run card's detail column, the gate region of the review page."

> "A reader who may not read the target gets **absent** — no card DOM at all."

> "**Presence is not layout** … A host supplies the frame and the measure a card is laid out at; it never drops a region, a state or an affordance the card's own section draws, and never adds one."

**And the absence, which is a clause of its own:** §IX's presence matrix has four
rows — *Review*, *Verification*, *Recommendation*, *Schedule proposal*. There is
no HITL row. `DRAWING-2__lifecycle-cards-section-IX.png` is the picture of that.

**The pull request's own words**, which every cell is also graded against:

> "when an agent stops in the middle of a run to ask you something, the question now shows up as a card of its own — in the conversation you are in, inside a third-party application, on the run page and on the review page — and it says which screen it is … the fields the step asks for and a Continue that answers them … inside a third-party application the Continue now ANSWERS, under your own sign-in, instead of being shown to you switched off."

**The contract's anchors**: `[data-lifecycle-card="agent_hitl_screen"]`,
`[data-lifecycle-card-host="<host>"]`,
`[data-conformance-id="agent-hitl-screen-card"]`,
`[data-conformance-id="hitl-screen-fields"]`, `[data-action="submit-hitl-screen"]`.

## The cells

### HC — the conversation the run was started from, at the setup screen

`cells/HC__chat_thread__light.png` · `cells/HC__chat_thread__dark.png`

**Requires** — §I's content-slot and no-bubble clauses; §IX's "the same card …
only the frame changes"; the pull request's "a card of its own … in the
conversation you are in … the fields the step asks for and a Continue that
answers them"; the four anchors above; and the panel not drawing a second screen
beside it.

**Shows** — the person's own sentence, the assistant's turn with the Cinatra mark
and name and **no bubble**, and the card filling the content slot at the column's
full width. Counted on the screen: `[data-lifecycle-card="agent_hitl_screen"]` 1,
`[data-lifecycle-card-host="chat_thread"]` 1,
`[data-conformance-id="agent-hitl-screen-card"]` 1,
`[data-lifecycle-card-state]` (on the root) 1,
`[data-conformance-id="hitl-screen-fields"]` 1, and
`[data-action="submit-hitl-screen"]` **0**. Inside the card: the label
`Idea (optional)`, a textarea placeheld *"What should this post be about?"*, and a
`Continue` button that is the FIELD RENDERER's own, not the card's anchored one.
Exactly one lifecycle card is on the screen. The transcript's own tool calls, read
from the rows rather than the pixels, are `agent_run`, `skill_file_read` and
`agent_run_get` — **no lifecycle-card tool call anywhere in the trace**. Database
at both shutters: `pending_approval`, `lifecycle_moment` `hitl`,
`lifecycle_card_kind` `agent_hitl_screen`, `input_params` `{}`.

**Verdict — PASS on identity and placement, FAIL on one §I clause.**

- PASS: the card is a card of its own, in the content slot, at full column width,
  with the kind, the host and the state on its own root, and one card only.
- FAIL, clause quoted: *"Exactly one primary input is drawn per conversation, and
  it is the chat box. Any field a card carries is drawn subordinate to it."* The
  card's field keeps all three of the things §I says a card's field gives up — the
  enclosing box, the raised ground (`bg-surface-muted` panel) and a send
  affordance (`Continue`) — so two boxed inputs are drawn in this conversation.
  The drawing states the rule generally, under a heading that says "wherever a
  card meets a chat box", and carves no exception for a field that is the answer
  rather than a rationale. It could be that such an exception is intended; the
  drawing at the pin does not contain one, and this slice records no deviation for
  it.
- Noted, not a defect of this slice: the label reads **`Idea (optional)`** for an
  input the run cannot proceed without — the template's `required` is `["idea"]`,
  while the gate's own field schema (the object under `idea`) carries only
  `required: ["title"]`, so the fallback renderer has nothing at that level to
  read as required. The run page's inline block draws the identical label from the
  identical renderer, so this is a standing reading of the shipped renderer, not
  something W3 introduced.
- The pull request's "and a Continue that answers them" is **satisfied in
  substance and not by the anchor it names**: the control on this screen is the
  renderer's, and `[data-action="submit-hitl-screen"]` is absent, because a setup
  gate is not `isMidRun`. The run panel draws no outer Continue for a setup gate
  either, so the card and the panel agree. The anchored Continue is pictured on
  the mid-run cells below.

### HC-settled — the same conversation after Continue was pressed IN THE CARD

`cells/HC-settled__chat_thread__light.png` · `cells/HC-settled__chat_thread__dark.png`

**Requires** — the pull request's "the Continue that answers them", and the card's
own contract that `none` is NO DOM at all (§IX: *"A reader who may not read the
target gets absent — no card DOM at all"*, and the kind's own two-state shape in
`packages/agents/src/agent-hitl-screen.ts:44`–`58`).

**Shows** — the answer *"How small teams keep their customer research organised"*
was typed into the field the card draws and the card's own `Continue` was pressed
inside it, in the cookie host, at `2026-08-26T23:42:46.802Z`. Counted afterwards:
every card anchor **0**; `[data-conversation-list]` 1 — the transcript is intact
and the card is gone. Readback either side of the press:

| | status | `input_params` |
|---|---|---|
| before | `pending_approval` | `{}` |
| after | `pending_trigger` | `{"idea": {"title": "How small teams keep their customer research organised"}}` |

**Verdict — PASS.** The card re-read, settled to no DOM, and the run moved with
the reader's own value merged into its inputs. Stated exactly: the run advanced
`pending_approval → pending_trigger` — *"setup finished, awaiting the user's
trigger choice"* — rather than to `queued`; that is the shipped setup ladder and
not a property of this card.

### HR — the run page for the same run at the same moment

`cells/HR__run_card__light.png` · `cells/HR__run_card__dark.png`

**Requires** — §IX's *"it is the same card wherever it appears: the same regions,
the same states, the same data on screen"*, and *"only the frame changes"*; §I's
run-page half — *"Where there is no chat box to be subordinate to — the run page
and the review page — the card's field is the only input there is and takes the
primary treatment instead"*; the pull request's "on the run page"; the anchors
with `run_card`.

**Shows** — the run page's own *Agentic Run Progress* panel with an
**Awaiting input** badge, and inside it the same pause screen: `Idea (optional)`,
the same textarea, the same `Continue`. Counted:
`[data-lifecycle-card="agent_hitl_screen"]` 1,
`[data-lifecycle-card-host="run_card"]` 1,
`[data-conformance-id="agent-hitl-screen-card"]` 1, `[data-lifecycle-card-state]`
1, `[data-conformance-id="hitl-screen-fields"]` 1,
`[data-action="submit-hitl-screen"]` 0, `[data-conversation-list]` 0. Same regions,
same data, different frame — the chat host's card carries a border and the
`surface-strong` ground; here the frame is the panel's own.

**Verdict — PASS.** Same card, same regions, same data, and the field takes the
primary treatment the drawing asks for where there is no chat box. The card wraps
the panel's existing block rather than drawing a second screen, which is what the
pull request claims and what the picture shows.

### HC-midrun / HR-midrun — the question an agent stopped in the MIDDLE of its run to ask

`cells/HC-midrun__chat_thread__{light,dark}.png` ·
`cells/HR-midrun__run_card__{light,dark}.png`

**Requires** — the pull request's sentence in full: *"when an agent stops in the
middle of a run to ask you something, the question now shows up as a card of its
own … the fields the step asks for and a Continue that answers them"*; §IX's
same-card-every-host clause; all five anchors, this time **including**
`[data-action="submit-hitl-screen"]`.

**Shows** — after the setup answer the run was dispatched from its own trigger
step, ran, and parked at a runtime gate:
`wayflow-c8a1367a-22bb-4f6f-8200-2f8c8d8335bd`, renderer
`@cinatra-ai/context-selection-agent:context-selector`, materialised
`2026-08-26T23:52:31.658Z`. On both hosts the card draws the gate's own region —
**Draft Context**, *"No eligible context artifacts available for this slot. The
agent will run without context for `draftContext`."* — and the card's OWN
`Continue →`, `[data-action="submit-hitl-screen"]` **1**, enabled. Counted on all
four: card 1, host 1, owner anchor 1, state 1, fields region 1, Continue 1. In the
conversation the run panel is drawn beside the card as a progress summary
(*Agentic Run Progress · pending approval · No messages yet*) and draws **no
second screen**, so one question is offered once.

**Then it was pressed, in the conversation, at `2026-08-27T00:02:06.956Z`**, and
the run moved `pending_approval → completed` (`completed_at`
`2026-08-27T00:03:34.767Z`), the card left the transcript, and the run's own
review gate opened (`cinatra.artifact_review_gates`, 1 row). The card's own
Continue answers, and the run resumes.

**Verdict — PASS on the pull request's sentence, with the same §I clause failing
on `chat_thread`.**

- PASS: the mid-run question is a card of its own on both hosts, in both themes,
  with the fields region and the card's own anchored Continue, and pressing it
  resumed the run.
- Measured, and stated because a picture would otherwise hide it: at the
  transcript's own resting scroll the card's `Continue` sits at y 847–875 in a
  900-px window and the topmost element at its centre is the composer, not the
  button (`drivers/12-measure-composer-occlusion.mjs`:
  `buttonIsTopmost: false`). Scrolled to the end — which is what the reader does —
  it is clear and topmost (`buttonIsTopmost: true`). The two chat cells are shot
  in that reading position, and the plan says so.
- The §I "one primary input" failing clause applies here too: the card carries its
  own send affordance in a conversation that already has a chat box.

### HP — the review page's gate region

`cells/HP__page_gate_region__light.png` · `cells/HP__page_gate_region__dark.png`

**Requires** — the pull request's "on the review page", and §IX's every-host
clause.

**Shows** — the review page for this run's own review task. Counted:
`[data-lifecycle-card-host="page_gate_region"]` 1 — the region is composed —
`[data-lifecycle-card="artifact_review_gate"]` 1, and
`[data-lifecycle-card="agent_hitl_screen"]` **0**. Run status at both shutters:
`completed`.

**Verdict — the cell is RECORDED AS NOT REACHED, with the code fact that makes it
so.** The mount is real and unconditional:
`src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/page.tsx:338`
mounts `<AgentHitlScreenCard runId={runId} />` inside the page's
`LifecycleCardSurfaceProvider host="page_gate_region"`. It draws only when the
run is at a HITL screen, and two shipped rules make that state and a review page
for the same run mutually exclusive for a single-gate run:

- `packages/agents/src/hitl-context.ts:79` — `deriveRunHitlContext` returns `null`
  unless `run.status === "pending_approval"`; a run whose artifact is under review
  after finishing is `completed`, as this one is.
- `packages/agents/src/agent-hitl-screen-core.ts:100`–`103` — a MARKED
  artifact-review gate is refused by the card's own core
  (`context.xRenderer === ARTIFACT_REVIEW_REDIRECT_RENDERER_ID` ⇒
  `AGENT_HITL_SCREEN_NONE`), so a run parked ON the very gate the review page is
  for never draws this card there.

So the card appears on that host only for a run parked on a NON-review gate while
a review page for a DIFFERENT review task of the same run exists. No sequence
this fleet offers reaches that: the agents whose runs park at an input gate open
their review gate at the end of the run, when the run is no longer parked. The
picture is kept as the record of the region actually holding the review card and
not this one; no HITL-screen cell is claimed for it.

### HW — the card inside a third-party application

**No picture, and this is a refusal to invent one.** A widget cell requires a run
STARTED FROM THE WIDGET'S OWN CONVERSATION, because a card travels from the run's
own turn. Three shipped facts make that unreachable on this head:

1. **A widget conversation cannot start an agent run.**
   `packages/mcp-server/src/delegated-widget-tool-policy.ts:122`–`135` —
   `DELEGATED_WIDGET_ALLOWLIST` is, per kind, exactly the kind's
   `*_content_editor_run`, the four read-only lifecycle pulls
   (`DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS`) and the one bound-card decide
   primitive. `agent_run` is not in it, and `:206` resolves the offered set from
   that map alone.
2. **The card has no slot to mount in without an `agent_run` part.**
   `packages/chat/src/assistant-parts.ts:414` — `LIFECYCLE_SLOT_TOOL_NAMES` is
   `["agent_run"]`; `packages/chat/src/chat-messages-view.tsx:392` mounts
   `<AgentHitlScreenCard runId={runId} wireRef={gateSignal} />` at that dispatch
   part's own container. No `agent_run` part, no mount.
3. **The one run a widget turn CAN create never reaches the state.**
   `src/lib/host-content-editor-dispatch.ts:18`–`26` states it outright — *"THE
   LAUNCH CLAIMS NO PRESENT HUMAN, deliberately … So the run is created `queued`,
   exactly as before, and the inline queued -> running -> completed ladder below
   is unchanged"* — and the ladder is that and only that (`:544`
   `queued → running`, `:580` `running → completed`, `:527`/`:567` the two failure
   edges). It never enters `pending_approval`, which is the only status
   `deriveRunHitlContext` answers for.

The pull request's **deviation 4** — *"DELIVERED — the widget's Continue acts"* —
therefore has no reachable surface to be pictured on from a real dispatch, and
the parity ratchet's `site_widget` cell is recorded by transcript rather than by a
capture. What the submit half is proven by is its own real-Postgres integration
tier, which the pull request states; that is a different kind of evidence from a
picture, and this round did not turn one into the other.

## What was NOT changed to make any of this pass

`scripts/ci/chat-hitl-capture-index.json` — untouched, 81 records, byte-identical
to the committed file. `scripts/audit/chat-hitl-anchor-contract.json` — untouched;
`node scripts/audit/chat-hitl-acceptance-gate.mjs --print-anchor-digest` prints
`recorded` and `recomputed` as the same
`7bf05ccc728c174ea1fbf4c9850056ead0107308cd0b8499730bff868f129e02`. No product
file is in this commit.

## Reproducing it

```
export WALK_BASE=http://127.0.0.1:<port>
export SUPABASE_DB_URL=<the lane database>
export LANE_ACCOUNT=<the lane account>  LANE_SECRET=<its password>
node evidence/2930-w3-hitl-card/drivers/01-lane-setup.mjs
node evidence/2930-w3-hitl-card/drivers/02-instance-namespace.mjs
node evidence/2930-w3-hitl-card/drivers/03-set-public-origin.mjs
node evidence/2930-w3-hitl-card/drivers/04-join-template-org.mjs
node evidence/2930-w3-hitl-card/drivers/05-chat-run-to-hitl-screen.mjs   # the run, from the chat
node evidence/2930-w3-hitl-card/drivers/07-capture-cells.mjs             # HC + HR
node evidence/2930-w3-hitl-card/drivers/08-answer-in-the-card.mjs        # Continue, in the card
node evidence/2930-w3-hitl-card/drivers/09-run-right-after-setup.mjs     # dispatch → the mid-run gate
node evidence/2930-w3-hitl-card/drivers/07-capture-cells.mjs             # the mid-run cells
node evidence/2930-w3-hitl-card/drivers/10-answer-midrun-in-the-card.mjs # the anchored Continue
node evidence/2930-w3-hitl-card/drivers/11-render-the-drawings.mjs       # the drawings, at the pin
node evidence/2930-w3-hitl-card/drivers/13-run-readback.mjs              # the rows
```

The provider step is the one on `main`
(`evidence/2790-s9f-host-parity/drivers/17-provider-setup-through-the-app.mjs`),
run inside the credential wrapper. No driver here holds a credential or an origin:
every one reads what it needs from the environment of the lane driving it.
