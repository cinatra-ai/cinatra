# cinatra#2930 W3 (PR #3014) — the HITL screen card, re-pictured at this head, with the card's own Continue on a setup gate and the four `decided` records the recorder now writes

Twelve full-window cells, light and dark, on ONE run the app's own dispatch created out of a real
conversation with a real model provider, reaching BOTH HITL screens. **All twelve are recorded
through the SHIPPED recorder and all twelve are registered in the canonical capture index** —
`scripts/ci/chat-hitl-capture-index.json`, **89 → 93 records**, the other 81 byte-identical.

Nothing in this set is carried over. **Every cell is re-taken at this head**, including the ones
whose pixels were expected to be unchanged, and the cell-by-cell notes below say per cell whether it
changed and why.

Two things at this head make the set different from the one before it, and both are measured rather
than asserted:

1. **On a setup gate in a conversation the card now owns the send.** The fields region holds **no
   button at all** and the card's own `[data-action="submit-hitl-screen"]` stands **outside** it.
   Measured on `chat_thread`: buttons inside `[data-conformance-id="hitl-screen-fields"]` = **0**,
   `[data-action="submit-hitl-screen"]` inside the region = **0**, outside it and inside the card =
   **1**, and the region declares `data-send-affordance="card"`. The run page is untouched: there the
   region takes the primary treatment and the renderer keeps its **1** button.
2. **The recorder writes a `decided` record of this kind as an ABSENCE instance.** All four
   `decided` cells carry one, written by `observeCapture` and accepted by the shipped validator, so
   they are in the index rather than beside it.

---

## What a `decided` record of THIS kind carries, and how these were registered

This kind's settled reading draws nothing at all — `settledIsAbsence: true` in
`scripts/ci/lib/capture-record-contract.mjs`. Read at this head before recording one, the rule is
`absenceInstanceViolations({ instance, kind, state })` (`capture-record-contract.mjs:339`), called by
BOTH tiers so neither can refuse what the other writes. Such a record's `instance` pins **the
absence**, and exactly this:

| field | value | why |
|---|---|---|
| `selector` | the kind's OWN root, `[data-lifecycle-card="agent_hitl_screen"]` | the thing that was owed |
| `matched` | **`0`** | the count actually READ for that root — a root still on screen is written down as such and the record is refused for it |
| `index` | **`null`** | there is no card for it to be the nth of |
| `id` | **`null`** | a card that was not on the screen cannot have been identified |
| `attributes` | **`{}`**, a PLAIN empty object | identity is read off an element and there was none — checked on the prototype and over every own key, so a Date, a Map, a symbol key or a non-enumerable one is refused |
| `absent` | **`true`** | the claim itself, in as many words — a record that pins a card it failed to find is a different and still-refused thing |

It is admissible **only** on a `decided` capture of a kind whose settled reading draws nothing; a
kind whose settled reading is a drawn card still owes the card it measured, and a `decided` record of
a settled-absence kind that carries no absence, or that pins a card, is refused.

The recorder writes it at `scripts/audit/lib/chat-hitl-capture-recorder.mjs:711`, and it takes
`matched` from the root's own frame-scoped count **this capture already measured twice around the
shutter** — nothing is measured a third time, and the drift check has already refused the capture if
the two disagreed. Every `decided` record below carries exactly:

```
{"selector":"[data-lifecycle-card=\"agent_hitl_screen\"]","matched":0,"index":null,"id":null,"attributes":{},"absent":true}
```

**How all twelve were registered.** The walk was driven with `--out` pointing at this directory's own
`capture-records.json`, because a walk whose clock is real is driven in more than one pass and a
half-finished pass must never leave the canonical index in a state no single run produced. The
finished set was then moved across by `drivers/17-register-records.mjs`, which calls the SHIPPED
`mergeWalkRecords` — the same function the driver's own `--out` path uses — so a record registered
here is what the driver would have written straight into the index: each rewritten cell replaced
WHERE IT STANDS, every record this round did not write left untouched and in place. It writes
nothing if `validateCaptureIndex` at the `graded` tier refuses the result.

- **before: 89 records** (8 of them this kind's, all `pending`, from the previous shoot)
- **after: 93 records** — the 8 `pending` cells REPLACED in place with this head's pictures, and the
  4 `decided` cells ADDED
- the shipped validator accepts **all 93**; `chat-hitl-acceptance-gate` reads the index at **93
  records** and exits 0

`drivers/16-annotate-index-records.mjs` then added the four fields the recorder does not write —
`runtime`, `runId`, `dbAt`, `gatesAtCapture`, `providerEvidence` — to those twelve records and to no
others, and re-validated the whole index before writing.

---

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js 16.2.10, Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, on a **dedicated lane database** on the local verify Postgres (5634) and
the verify Redis (6579), loopback-only, with this branch's own pinned extension tree (112 packages)
and its bundled dev package registry and agent runtime container brought up from this checkout. It is
**not** a production-equivalent build: these are the dev builds of the same components, and every
record is labelled `development`.

**A REAL MODEL PROVIDER, configured through the app's own form.** The instance's provider was set up
on `/setup/model` by the driver on `main`
(`evidence/2790-s9f-host-parity/drivers/17-provider-setup-through-the-app.mjs`), which read the
credential from its process environment and typed it into the shipped form, so the app sealed the
connection itself. The credential is in no file here, in no argument, in no log and in no record.
`CINATRA_TEST_LLM_PROVIDER` is set in nothing this round starts and the server log carries **zero**
scripted-runtime lines. What the instance actually called is in `readback/run-readback.json`:

| provider | model | operation | calls | input tokens | output tokens |
|---|---|---|---|---|---|
| `openai` | `gpt-5.5` | `stream` | **3** | 64,520 | 802 |
| `openai` | `gpt-5.5-2026-04-23` | `generate` | **11** | 59,004 | 2,752 |

**The public origin was set through the app's own UI** at `/configuration/development?tab=tunnel` —
origin only, never by hand-editing the database — and read back through the app's own
`/api/mcp-settings`, which answered the origin just saved. The public origin answered before any
pictured turn. **The instance namespace** was provisioned through the app's own `/setup/name` step
before any run materialised an artifact. The agent and its agent dependency were installed through
the product's own **Upload Extension** screen at `/configuration/extensions/upload`, after their
packages were published to the instance's own registry.

### The limits of this round, stated

- **The FIRST run of this round failed, and it is on the record.** Run
  `9dc2d652-4d09-480c-97e5-184a99cc3466` reached the setup gate, was answered in the card, and then
  failed at dispatch: `[context-route] rejected kind=resolve code=forbidden status=403 … bridge auth
  failed`, and `WayFlow task failed`. That is an ENVIRONMENT fact of this round's own bring-up, not a
  reading of the card: the agent runtime container's narrow env file
  (`docker/wayflow/.wayflow.env`, written by `scripts/gen-wayflow-env.mjs`) had not been generated for
  this checkout, so the container held no `CINATRA_BRIDGE_TOKEN` and the context-resolve route
  refused its callback — which is the exact failure that file exists to prevent, and which the
  compose file documents in its own comment. The file was generated, the container recreated
  (`/.health` `{"status":"ok","agents":29,"failed":0}`), and the WHOLE leg was driven again on a
  second run. **Every cell below stands on that second run**, and nothing about the card changed
  between them. The failed run is left in the readback rather than deleted.
- **The mid-run gate in this run had no eligible context to choose.** The context selector answered
  *"No eligible context artifacts available for this slot. The agent will run without context for
  `draftContext`."* — so on that screen the renderer draws a notice and **no input at all**
  (`fieldControl` is `null` in `page-controls.json` for all four mid-run cells). §I's field clause has
  no subject on that screen, and this set does not claim it does: what the mid-run cells DO prove is
  the second half of the same rule — the region is still marked `subordinate` in a conversation and
  `primary` on the run page, and the card's own Continue is drawn and live on both.
- **The process-table read establishes nothing on this host.** `ps -E` prints no environment for the
  listening process (`tokensSeen: 0`), so the positive evidence for a real provider is the usage rows
  above, the **12** `POST /api/mcp 200` callbacks from the provider's own servers over the public
  ingress, the `[llm-bridge-run-select]` line the agent runtime produced, and the absent scripted
  lines.
- **No refused turn in this round.** `negativeScreens.publicMcpRefusals` is **0**: the ingress was
  warmed before the first pictured turn (the runtime HEADs the public MCP URL with a 2 500 ms budget
  and refuses the turn outright if it does not answer; the first cold hit through this ingress takes
  about 3.3 s and, warmed, about 0.35 s — measured at 0.24–0.47 s here).

## The direct-SQL lane writes, disclosed — there are two

Both are account provisioning for a throwaway account on a database that is dropped when the round
ends. Neither touches a run, a trigger, a gate, a record or any row a photographed screen reads.

1. **`UPDATE public."user" SET role='admin'`** (`drivers/01-lane-setup.mjs`) — the setup and
   configuration screens this round walks are admin-gated.
2. **`INSERT INTO public.member`** (`drivers/04-join-template-org.mjs`) — the account joins the
   organization the instance's own boot stamped every agent template with. A run proposal is refused
   outright for a template outside the caller's active organization.

`grep -rniE "insert into|SEEDED_|seedGate|seedTurn|update .* set status" drivers/` returns the one
`INSERT` above and nothing else. **No run, gate, park, record or review task was inserted, and no
status was written by hand.** One further fact is disclosed rather than buried: the wizard's
**Secrets** step was completed **through the app's own form** with a local placeholder value, because
setup completeness gates `/configuration` and this round opens no OAuth connector connection.

One more environment fact, disclosed for the same reason: the database was created empty and the
committed `public` schema seed was applied to it with the repository's own
`scripts/apply-public-schema.mjs` — the script that exists for exactly this (the dev server's
instrumentation hook touches `public.user` and fails without it). It writes no `cinatra.*` row; the
app's own boot creates its schema.

## The requires, from the pinned drawing, verbatim

Fetched read-only at the contract's own `specCommit` — `design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f
specs/app-lifecycle-cards.html` — served from loopback and rendered with the capture browser into
`drawings/`.

**§I, THE INPUT RULE — the clause every cell here is graded against.**

> "**The rule, wherever a card meets a chat box** — Exactly one primary input is drawn per
> conversation, and it is the chat box. Any field a card carries is drawn subordinate to it. Where
> there is **no** chat box to be subordinate to — the run page and the review page — the card's field
> is the only input there is and takes the primary treatment instead. The hierarchy is between the two
> inputs, not a fixed look for either one."

**§I, how the weight is taken off — the clause the setup gate failed before this head.**

> "No box of its own, no fill, no send. A ruled baseline under a mono label — it reads as a field on
> the card, not as somewhere to start typing."

**§I, the turn shapes and the content slot.**

> "A **person's** turn is right-aligned: their name and initials above, then a **filled bubble** that
> hugs its text … The **assistant's** turn is left-aligned and carries **no bubble** … A **card takes
> that content slot**, at the column's full width, exactly where prose would otherwise sit."

**§IX, where each card appears.**

> "Every card appears on **every** host, and it is the **same card** wherever it appears: the same
> regions, the same states, the same data on screen, and the same actions its reader is authorized to
> take. Only the **frame** changes …"

**And the absence, which is a clause of its own.** Measured at the pin, read-only: in
`specs/app-lifecycle-cards.html` the strings `HITL`, `pause`, `human input` and `awaiting` occur
**0 / 0 / 0 / 0** times, and §IX's presence matrix has four rows — *Review*, *Verification*,
*Recommendation*, *Schedule proposal*. `drawings/DRAWING-2__lifecycle-cards-section-IX.png` is the
picture of that, and `drawings/DRAWING-3__components-no-pause-screen.png` is the picture of the
sibling file having no pause screen either (`pause screen` occurs **0** times in
`specs/app-components.html`; its only HITL section is "Retiring the in-stepper trigger HITL", which is
about scheduling). **There is no ratified drawing of this card at the contract's pin**, which is what
the pull request's deviation 1 says.

**The plan's own words** (PLAN: Agents Lifecycle (B)):

> "an agent's HITL screen is fields with a Continue button"

> "A run at a moment shows its card on every host — the skills question, the schedule, **the HITL
> screen**, the review, the audit reading."

**The pull request's own words**, which every cell is also graded against:

> "the fields the step asks for and a Continue that answers them"

and, for this head: on `chat_thread` the setup gate's fields region holds NO button and the card's
OWN Continue stands outside it (`cardOwnsTheSetupSend`, `data-send-affordance="card"`, the stylesheet
backstop at `src/app/globals.css`); **the mid-run gate is unchanged**.

**The contract's anchors**, read by the recorder and by the sidecar:
`[data-lifecycle-card="agent_hitl_screen"]`, `[data-lifecycle-card-host]`,
`[data-conformance-id="agent-hitl-screen-card"]`, `[data-conformance-id="hitl-screen-fields"]`,
`[data-field-presentation]`, `[data-send-affordance]`, and the card's own
`[data-action="submit-hitl-screen"]`.

## The run these cells stand on

`@cinatra-ai/blog-draft-writer-agent`, asked for in the app's own chat in the person's own words —
*"Please run the Blog Draft Writer Agent for me now."* — and created by the app's own dispatch
(`agent_run`, off the model's own tool call; the transcript's tool calls are `agent_list`, `agent_run`
and nothing lifecycle-shaped). Run **`6928e825-6eb0-49da-88ae-a9faf446a5bc`**, thread
`e84977d4-3427-4210-9b6b-d3b7d42d8fce`. It reached **two** HITL screens and both are pictured:

| | gate | `x_renderer` | field | moment stated | the card's own Continue |
|---|---|---|---|---|---|
| **the setup screen** | `setup-6928e825…` | `@cinatra-ai/agent-builder:schema-field-fallback` | `idea` | `hitl` / `agent_hitl_screen` | **drawn on `chat_thread` (1), outside the region — NEW at this head**; not drawn on `run_card` (0) |
| **the mid-run screen** | `wayflow-f1a87077…` | `@cinatra-ai/context-selection-agent:context-selector` | — | none | **drawn and enabled on both** (1 / 1) — unchanged |

## The measured field treatment — the numbers §I is graded on

Read off the live DOM by `drivers/14-page-controls-and-field-treatment.mjs`; every value is in
`page-controls.json` per cell.

### The SETUP gate — the screen this head changed

| | `chat_thread` light | `chat_thread` dark | `run_card` light | `run_card` dark |
|---|---|---|---|---|
| `data-field-presentation` | **subordinate** | **subordinate** | **primary** | **primary** |
| `data-send-affordance` | **`card`** | **`card`** | *(absent)* | *(absent)* |
| **buttons inside the fields region** | **0** | **0** | **1** (`Continue`) | **1** (`Continue`) |
| **`[data-action="submit-hitl-screen"]` inside the region** | **0** | **0** | 0 | 0 |
| **…outside the region, inside the card** | **1** | **1** | 0 | 0 |
| the card's Continue — box | `97 × 28` at `(1104, 683)` | `97 × 28` at `(1104, 683)` | — | — |
| the card's Continue — enabled | **yes** | **yes** | — | — |
| primary inputs in the conversation | **1** (the chat box) | **1** | 0 (no chat box) | 0 |
| fields region — border | `0px` all round, style `none` | `0px`, `none` | `1px solid` | `1px solid` |
| fields region — background | `rgba(0, 0, 0, 0)` | `rgba(0, 0, 0, 0)` | `rgb(247, 247, 243)` | `lab(3.87463 0.500388 -12.2712)` |
| fields region — box-shadow | `none` | `none` | `none` | `none` |
| fields region — radius | `0px` | `0px` | `14px` | `14px` |
| the field itself — border | top `0px`; **bottom `1px dashed rgba(21, 33, 58, 0.14)`** | top `0px`; **bottom `1px dashed rgba(255, 255, 255, 0.1)`** | `1px solid` all round | `1px solid` all round |
| the field itself — background | `rgba(0, 0, 0, 0)` | `rgba(0, 0, 0, 0)` | `rgb(255, 255, 255)` | `oklab(… / 0.0305882)` |
| the field itself — box-shadow | `none` | `none` | `rgba(255, 255, 255, 0.8) 0px 1px 0px 0px inset` | `none` |
| the field itself — radius | `0px` | `0px` | `7px` | `7px` |
| the label — font-family | **`"JetBrains Mono", … monospace`** | **`"JetBrains Mono", … monospace`** | `Inter, … sans-serif` | `Inter, … sans-serif` |
| the label — size / case / tracking | `9.5px` / `uppercase` / `1.33px` | `9.5px` / `uppercase` / `1.33px` | `12px` / `none` / `normal` | `12px` / `none` / `normal` |

**That is §I's rule, measured, and all three give-ups are now present in a conversation.** The field
gives up its box (no border, radius 0), gives up its fill (fully transparent), gives up its raised
ground (no box-shadow) and keeps *a single quiet ruled baseline* — one dashed 1px bottom rule on the
hairline token — *under a mono label* in JetBrains Mono, uppercase, tracked; and it now gives up **the
send** as well: **no button of any kind inside the region**, with the card's own Continue standing
outside it. On the run page, where there is no chat box to be subordinate to, the same field takes
the primary treatment the same clause asks for, and the renderer keeps its own button.

### The MID-RUN gate — unchanged at this head

| | `chat_thread` light | `chat_thread` dark | `run_card` light | `run_card` dark |
|---|---|---|---|---|
| `data-field-presentation` | subordinate | subordinate | primary | primary |
| `data-send-affordance` | *(absent — the card did NOT take a send over)* | *(absent)* | *(absent)* | *(absent)* |
| buttons inside the fields region | **0** | **0** | **1** (`Continue`) | **1** |
| `[data-action="submit-hitl-screen"]` inside / outside the region | **0 / 1** | **0 / 1** | **1 / 0** | **1 / 0** |
| the card's Continue — box, enabled | `97 × 28` at `(1104, 433)`, enabled | same | `97 × 28` at `(1093, 447)`, enabled | same |
| fields region — border / background / radius | `0px` / `rgba(0, 0, 0, 0)` / `0px` | same | `1px solid` / `rgb(247, 247, 243)` / `14px` | `1px solid` / `lab(3.87463 …)` / `14px` |
| an input inside the region | **none** — the selector had nothing to choose | none | none | none |

**Read this row honestly.** `cardOwnsTheSetupSend` deliberately excludes a mid-run gate, so the region
carries no `data-send-affordance` there and nothing was taken away from that screen — the card's own
Continue is the control the run page has always drawn for a mid-run gate, and it is the same control
in a conversation. On `run_card` that Continue sits INSIDE
`[data-conformance-id="hitl-screen-fields"]` because on the run page that anchor is on the panel's own
inline block, which encloses the renderer and the button together; §I's "no send" clause is a clause
about the **subordinate** field and does not reach the primary treatment, which is why nothing here is
called a defect.

## The cells

Every count below was made by the shipped recorder on the screen the picture shows, in the scope
named, and every one is **painted** as well as attached. All twelve are registered in
`scripts/ci/chat-hitl-capture-index.json`.

### HC-pending — the conversation the run was started from, at the SETUP screen

`cells/HC-pending__hitl-card__chat_thread__pending.png` ·
`cells/HC-pending__hitl-card__chat_thread__pending__dark.png`
sha256 `2b950a5f0670d16bff4de7484dc7cd2f32aafe65351c159ada649474514a5212` ·
`da312059634130477a700ec82aca88eb71cb494d91879fe6f7b22c906dd5cd9c`
shot `2026-08-27T14:12:26.454Z` · `2026-08-27T14:12:42.924Z` — **REGISTERED**

**CHANGED at this head, and this is the cell the change is about.**

**Requires** — §I's input rule and its "No box of its own, no fill, no send. A ruled baseline under a
mono label", verbatim above; the plan's "an agent's HITL screen is fields with a Continue button";
the pull request's "the fields the step asks for and a Continue that answers them".

**Shows** — the card in the assistant's turn, in the content slot, at the column's full width, with no
bubble. `[data-lifecycle-card="agent_hitl_screen"]` **1/1 painted**;
`[data-lifecycle-card-host="chat_thread"]` **1/1**; `[data-conformance-id="agent-hitl-screen-card"]`
**1/1**; `[data-conformance-id="hitl-screen-fields"]` **1/1 inside the pinned card root**;
`[data-conversation-list]` **1/1**. The region declares `data-field-presentation="subordinate"` and
`data-send-affordance="card"`. **Buttons inside the region: 0.** The card's own
`[data-action="submit-hitl-screen"]`: **0 inside the region, 1 outside it**, `97 × 28` at
`(1104, 683)`, enabled, reading `Continue`. Exactly **one** primary input in the conversation and it is
the chat box. Field: transparent, unbordered, unshadowed, radius `0px`, one 1px dashed bottom rule on
the hairline token, under `IDEA (OPTIONAL)` in JetBrains Mono, `9.5px`, uppercase, `1.33px` tracked.

**Verdict — PASS on every clause.** One primary input; the card's field subordinate on all three
give-ups including the send; the card's own Continue present, outside the field, and live.

### HC-decided — the same conversation after the setup gate was answered IN THE CARD

`cells/HC-decided__hitl-card__chat_thread__decided.png` ·
`cells/HC-decided__hitl-card__chat_thread__decided__dark.png`
sha256 `8cb5a4eea73d1168606a9c16024acf91299b8d9aee47ffab99bb5c45a93c510f` ·
`cb668c63a7f82cda1f120e9674333f42ff420fad0d8b11b7bc1737895b2fb369`
shot `2026-08-27T14:15:42.796Z` · `2026-08-27T14:15:54.713Z` — **REGISTERED (new — the recorder
refused this record before this head)**

**NEW at this head.** The picture existed before; the RECORD did not.

**Requires** — the pull request's "a Continue that answers them"; this kind's own settled reading,
which draws nothing at all.

**Shows** — the reader typed into the card's own field and pressed **THE CARD'S OWN Continue**
(`[data-action="submit-hitl-screen"]` — at this head the only send on that screen). The app's own
shipped server action took it, from the conversation host, with the value wrapped under the gate's own
field name:

```
[approveReviewTaskInternal] setup-path resumed run=6928e825-… fieldName=idea actor=…
  approveReviewTask("setup-6928e825-…", {"idea":{"title":"How small teams keep customer research organised"}}, "idea")
```

**Readback.** Before, at `2026-08-27T14:14:38.141Z`: `pending_approval`, moment `hitl`, card kind
`agent_hitl_screen`, `input_params` **`{}`**. After, at `2026-08-27T14:15:54.802Z`:
**`pending_trigger`**, moment `schedule`, card kind `trigger_schedule_proposal`, `input_params`
**`{"idea": {"title": "How small teams keep customer research organised"}}`** — the reader's own value,
merged. Counted on the screen: `[data-lifecycle-card="agent_hitl_screen"]` **0/0**,
`[data-conformance-id="hitl-screen-fields"]` **0/0**, `[data-conversation-list]` **1/1**.

**The record.** `absent: true`, `matched: 0`, `index: null`, `id: null`, `attributes: {}`, pinning the
kind's own root — validated by the shipped validator at the graded tier.

**Verdict — PASS.** The card's own Continue answers through the one shipped core, the value lands
merged under its own field name, and the card settles to no DOM.

### HR-pending — the run page for the same run at the same moment

`cells/HR-pending__hitl-card__run_card__pending.png` ·
`cells/HR-pending__hitl-card__run_card__pending__dark.png`
sha256 `3d3f5148b7f189122e0518c55eca71df7bed8d51eacc3305d1b2de0d25d0c240` ·
`a0057a70c126f0ddeee39e41b7cab3fb9aa90d7d0988feb1a6004ffe50998988`
shot `2026-08-27T14:12:55.588Z` · `2026-08-27T14:13:07.459Z` — **REGISTERED**

**UNCHANGED in intent at this head, and re-taken to prove it.** This is the host the fix deliberately
does not reach, so the picture is expected to look as it did — and it does; only the run id in it is
new.

**Requires** — §I's "Where there is no chat box to be subordinate to — the run page and the review
page — the card's field is the only input there is and takes the primary treatment instead", verbatim
above; and the pull request's "the panel's existing inline HITL block is UNCHANGED".

**Shows** — the same screen the run page has always drawn, now inside the card's root.
`[data-lifecycle-card="agent_hitl_screen"]` **1/1**, `[data-lifecycle-card-host="run_card"]` **1/1**,
`[data-conformance-id="agent-hitl-screen-card"]` **1/1**, `[data-conformance-id="hitl-screen-fields"]`
**1/1 inside the pinned root**, `[data-conversation-list]` **0** (there is no conversation here).
`data-field-presentation="primary"`, **no** `data-send-affordance`. **Buttons inside the region: 1**
(`Continue`, the renderer's own). The card's own `[data-action="submit-hitl-screen"]`: **0** in the
whole frame — the card adds no control of its own on a setup gate here, which is exactly what
`cardOwnsTheSetupSend` states. Region: `1px solid` all round, filled, radius `14px`; the field: its own
`1px solid` box, filled, radius `7px`, inset highlight; the label `Idea (optional)` in Inter, `12px`,
sentence case.

**Verdict — PASS.** The primary treatment where §I asks for it, the renderer's own control kept, and
nothing added.

### HC-midrun-pending / HR-midrun-pending — the question the agent stopped MID-RUN to ask

`cells/HC-midrun-pending__hitl-card__chat_thread__pending.png` ·
`cells/HC-midrun-pending__hitl-card__chat_thread__pending__dark.png`
sha256 `69f352e1379090056b1d095ffc0851face759bc5ae1a458542549b421e4f0202` ·
`c91204348f06dd393b0d2132fe20fbbab1ba2b38cfd3f7c90562a4e81c6897a1`
shot `2026-08-27T14:16:56.152Z` · `2026-08-27T14:17:12.261Z` — **REGISTERED**

`cells/HR-midrun-pending__hitl-card__run_card__pending.png` ·
`cells/HR-midrun-pending__hitl-card__run_card__pending__dark.png`
sha256 `30f87e4ffe94cbb2d9f2eb640b1c7f39d0e51490e5fe0750bf756f9a5857a3ef` ·
`f0c60f62baf1d1a2b9aa9d4327226b37cdcf18ea09c0388c7ac1ea82e78f3b40`
shot `2026-08-27T14:17:24.909Z` · `2026-08-27T14:17:37.442Z` — **REGISTERED**

**UNCHANGED at this head, and re-taken to prove it.** The fix names the mid-run gate as a shape it
deliberately leaves alone, and the measurements confirm it: no `data-send-affordance` on either host,
and the card's own Continue exactly where it was.

**Requires** — §IX's "Every card appears on every host, and it is the same card wherever it appears:
the same regions, the same states, the same data on screen"; the plan's "A run at a moment shows its
card on every host"; the pull request's "a Continue that answers them".

**Shows** — the SAME card, the same one region, the same one control, on both hosts, differing only in
frame. Both hosts: `[data-lifecycle-card="agent_hitl_screen"]` **1/1**, the host declaration **1/1**,
the owner anchor **1/1**, `[data-conformance-id="hitl-screen-fields"]` **1/1 inside the pinned root**.
Card text, identical on all four cells: *"Draft Context — No eligible context artifacts available for
this slot. The agent will run without context for `draftContext`. — Continue"*. The card's own
`[data-action="submit-hitl-screen"]` is present, painted and **enabled** on both hosts (`chat_thread`
`97 × 28` at `(1104, 433)`, outside the region; `run_card` `97 × 28` at `(1093, 447)`, inside the
panel's own block). `chat_thread` keeps `data-field-presentation="subordinate"` and one primary input
(the chat box); `run_card` keeps `primary` and has none.

**Verdict — PASS on §IX and on the plan's sentence; the §I FIELD clause is NOT EXERCISED here** and is
not claimed: this gate's renderer drew a notice and no input at all in this run, so there was no field
to be subordinate. The hierarchy declaration itself is present and correct on both hosts.

### HC-midrun-decided — after the card's OWN Continue was pressed

`cells/HC-midrun-decided__hitl-card__chat_thread__decided.png` ·
`cells/HC-midrun-decided__hitl-card__chat_thread__decided__dark.png`
sha256 `88fc08c0a69b9f0ea2a88d1a7e4b2de962f8afb00c7baeb1ff8dadf52594530f` ·
`f53a013dc790b7c1dc59e714721dfcb9eb9989a5722d5fd4c67a8c0dda14a865`
shot `2026-08-27T14:23:41.516Z` · `2026-08-27T14:23:54.596Z` — **REGISTERED (new — the recorder
refused this record before this head)**

**Requires** — the pull request's "a Continue that answers them" and "the run resumes"; this kind's own
settled reading.

**Shows** — `[data-action="submit-hitl-screen"]` was pressed INSIDE the card in the conversation,
between the readback at `2026-08-27T14:19:06.964Z` (`pending_approval`, task `f1a87077…`) and the
resume the server log records:

```
[approveReviewTaskInternal] wayflow-path resumed run=6928e825-… task=f1a87077-… actor=… resultState=completed
```

and the run RESUMED and finished: `pending_approval → completed`, `completed_at`
**`2026-08-27T14:20:19.843Z`**, WayFlow task `0afeda2a-…` `state=completed` at `14:20:18.355Z`; the
artifact materialised (*How Small Teams Keep Customer Research Organized*,
`@cinatra-ai/blog-post-artifact:post`, updated `2026-08-27T14:20:32.199Z`) and **the run's own review
gate opened** — `cinatra.artifact_review_gates`, 1 row, `lifecycle-review:b61c5e70…`, `pending`,
created **`2026-08-27T14:20:22.929Z`**. Counted on the screen: every HITL-card anchor **0/0**;
`[data-conversation-list]` **1/1**. The picture shows the HITL card gone and the review card in its
place in the same turn, carrying the materialised draft.

**The record.** The same absence instance as HC-decided, validated the same way.

**Verdict — PASS.** The card's own Continue answers, the run resumes to completion, the card settles
to no DOM, and the next card in the lifecycle takes the slot.

**One honest note about how this pair was driven.** The first attempt shot the settled reading at a
fixed delay after the press and the SHIPPED validator refused the record — *"the recorded absence
counted 1 card(s) at [data-lifecycle-card="agent_hitl_screen"] — a root that is still on the screen is
not a settled reading, whatever the record calls it"* — because the run had not finished resuming
yet. Nothing was changed to get past that; the walk was split instead, into a press step that observes
no cell and a reading step that waits for the review gate's own card to take the slot. The refusal is
the validator doing its job and it is recorded here rather than smoothed away.

### HR-decided — the run page's settled reading of this card

**No cell, and this is a code fact rather than a missing picture.** The card has **two states and only
two** (`packages/agents/src/agent-hitl-screen.ts:50` `{state: "none"}` and `:52` `{state: "asking"}`),
and `agent-hitl-screen-card.tsx:1186` returns `null` for anything that is not `asking`; its root, when
drawn, always carries `data-lifecycle-card-state="asking"`. **There is no settled reading of this card
to photograph on any host** — which is exactly what the capture contract encodes as
`settledIsAbsence: true` for this kind, and why a `decided` record of it pins an absence. Probed on the
run page after completion, in both themes (`readback/run-page-settled-probe.json`):
`[data-lifecycle-card="agent_hitl_screen"]` **0**, `[data-conformance-id="hitl-screen-fields"]` **0**,
`[data-action="submit-hitl-screen"]` **0**, and the surface draws `artifact_review_gate` (`run_card`,
`pending`) in its place. Recorded as a probe rather than claimed as a cell.

### HW and HP — the two composition-only cells

**No picture was taken of either, and none was asked for.** The capture contract at this head declares
this kind capturable on `chat_thread` and `run_card` only, and gives each excluded host its own
reason, verbatim:

> **`site_widget`** — "a card travels from the run's own turn, and a widget conversation cannot start a
> run that reaches `pending_approval`: `agent_run` is not in the delegated widget allowlist
> (packages/mcp-server/src/delegated-widget-tool-policy.ts), and the content-editor launch claims no
> present human and runs queued -> running -> completed without ever parking
> (src/lib/host-content-editor-dispatch.ts). The mount is real and is proven by the card suite's widget
> arms and the real-store submit tier; it is the PICTURE that has no reachable subject."

> **`page_gate_region`** — "the review page draws a gate region for ONE review task, and this card
> refuses a MARKED artifact-review gate (packages/agents/src/agent-hitl-screen-core.ts) while the run's
> HITL context answers only for `pending_approval` — so a single-gate run shows the review gate or this
> one, never both, and no sequence reaches a run parked on a non-review gate while a review page for a
> different review task of the same run exists. The region composes the card; the composition is what is
> recorded, not a photograph of it."

Both are enforced mechanically: `validateWalkPlan` refuses a plan cell for either host before a browser
opens, and `validateCaptureRecord` refuses a record for one, each with the reason attached.

## Named as NOT this slice's

- **The setup field's label reads "Idea (optional)" for an input the run cannot proceed without.** The
  template's `required` is `["idea"]` while the gate's own field schema carries only
  `required: ["title"]`, so the fallback renderer has nothing at that level to read. That label logic is
  `packages/agents/src/schema-field-renderer.tsx` — not this slice's — and the run page's inline block
  draws the identical label from the identical renderer. Visible in all four setup cells as
  `IDEA (OPTIONAL)` / `Idea (optional)`.
- **The run page draws no step rail at a HITL gate.** Measured `stepRailPresent` **0** on all four
  `run_card` cells. The rail slice #2970 covers the setup steps; a HITL-gate row on the rail is not in
  this slice's text.
- **The assistant's own sentence under the card** ("Dispatched … The run started.") is what pull
  request 2996 replaces with the platform's message.

## What was NOT changed to make any of this pass

`scripts/audit/chat-hitl-anchor-contract.json` — untouched.
`node scripts/audit/chat-hitl-acceptance-gate.mjs --print-anchor-digest` prints `recorded` and
`recomputed` as the same
`fa31fa2f1e73b545ba42e923636af4e4ac6025d623b6c5fdcc68d32342994d46`, at the same design pin.
`scripts/ci/lib/capture-record-contract.mjs`, `scripts/audit/lib/chat-hitl-capture-recorder.mjs` and
`scripts/audit/lib/chat-hitl-capture-driver.mjs` — untouched. No product file is in this commit. The
capture index gained **four** records and REPLACED **eight** in place; its other 81 are byte-identical.

## The drivers that changed in this round

- **`drivers/15-shoot-the-refused-cells.mjs` is DELETED.** It existed for one reason: the shipped
  recorder refused a `decided` record of this kind, so those cells had to be shot beside the index and
  marked `registered: false`. At this head the recorder writes them, they are in the index, and a
  driver whose whole header quotes a refusal that no longer happens would be a lie left in the tree.
- **`drivers/14-page-controls-and-field-treatment.mjs` gained one measurement**, `sendAffordance`:
  the region's `data-send-affordance`, the count of buttons INSIDE
  `[data-conformance-id="hitl-screen-fields"]`, the count of `[data-action="submit-hitl-screen"]`
  inside it and outside it within the card, that control's box and enabled state, and the number of
  primary inputs in the conversation. Two numbers rather than one, because *"no button in the region"*
  and *"a Continue on the card"* are two different claims and a total cannot tell them apart.
- **`drivers/17-register-records.mjs` is NEW** — the shipped `mergeWalkRecords` move described above.
- **`capture-walk.json`** — the setup answer presses `[data-action="submit-hitl-screen"]`; the mid-run
  chat steps wait on the region that does NOT declare `data-send-affordance="card"` (the card's own
  Continue no longer tells the two gates apart, because the setup gate draws one too); and the mid-run
  press is split from the mid-run reading, which now waits for the review gate's own card instead of a
  clock.

## Reproducing it

```
export WALK_BASE=http://127.0.0.1:<port>
export SUPABASE_DB_URL=<the round's own database>
export LANE_ACCOUNT=<the account>  LANE_SECRET=<its password>
node scripts/apply-public-schema.mjs                                  # a fresh database only
node scripts/gen-wayflow-env.mjs && docker compose --profile wayflow up -d verdaccio wayflow
node evidence/2930-w3-hitl-card/drivers/01-lane-setup.mjs
node evidence/2930-w3-hitl-card/drivers/02-instance-namespace.mjs      # /setup/name
# the wizard's Secrets step, through the app's own form (see the disclosure above)
# the provider step, inside the credential wrapper:
#   evidence/2790-s9f-host-parity/drivers/17-provider-setup-through-the-app.mjs
node evidence/2930-w3-hitl-card/drivers/03-set-public-origin.mjs       # /configuration/development?tab=tunnel
node evidence/2930-w3-hitl-card/drivers/04-join-template-org.mjs
# publish the run package and its dependencies to the instance's own registry, then
# install the agent and its agent dependency through /configuration/extensions/upload
node evidence/2930-w3-hitl-card/drivers/05-chat-run-to-hitl-screen.mjs # the run, from the chat

export WALK_COOKIE="$(node evidence/2930-w3-hitl-card/drivers/06-mint-lane-cookie.mjs)"
export WALK_COOKIE_DOMAIN=127.0.0.1
export WALK_THREAD_URL=/chat/<vendor>/<assistant>/<threadId>
export WALK_RUN_PAGE=/agents/<vendor>/<slug>/<runId>
export WALK_ANSWER=<the reader's own answer>

W=scripts/audit/lib/chat-hitl-capture-driver.mjs
O=evidence/2930-w3-hitl-card/capture-records.json
P=evidence/2930-w3-hitl-card/capture-walk.json
node $W --walk $P --out $O --steps hc-pending-light,hc-pending-dark,hr-pending-light,hr-pending-dark
node evidence/2930-w3-hitl-card/drivers/14-page-controls-and-field-treatment.mjs
node $W --walk $P --out $O --steps hc-answer-light,hc-decided-dark   # presses THE CARD'S OWN Continue
node evidence/2930-w3-hitl-card/drivers/09-run-right-after-setup.mjs # dispatch -> the mid-run gate
node $W --walk $P --out $O --steps hc-midrun-pending-light,hc-midrun-pending-dark,hr-midrun-pending-light,hr-midrun-pending-dark
node evidence/2930-w3-hitl-card/drivers/14-page-controls-and-field-treatment.mjs
node $W --walk $P --out $O --steps hc-midrun-answer                  # the press, observing no cell
node $W --walk $P --out $O --steps hc-midrun-decided-light,hc-midrun-decided-dark
node evidence/2930-w3-hitl-card/drivers/13-run-readback.mjs
node evidence/2930-w3-hitl-card/drivers/11-render-the-drawings.mjs   # the drawings, at the pin
RECORDS_IN=$O node evidence/2930-w3-hitl-card/drivers/17-register-records.mjs
CELLS=<the twelve> node evidence/2930-w3-hitl-card/drivers/16-annotate-index-records.mjs
node scripts/audit/chat-hitl-acceptance-gate.mjs && node scripts/ci/chat-hitl-evidence-gate.mjs
node scripts/audit/chat-hitl-one-card-gate.mjs && node scripts/audit/file-size-ratchet.mjs
```
