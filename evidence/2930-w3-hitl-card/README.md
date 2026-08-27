# cinatra#2930 W3 (PR #3014) — the HITL screen card, re-pictured at this head and RECORDED THROUGH THE SHIPPED RECORDER

Twelve pictures, six readings, one run. Every picture is a full browser window at
1440×900, device scale 2, uncropped, light **and** dark, taken on a booted app with a
real model provider, on a run the app's own dispatch created out of a real
conversation in the person's own words.

**What is different from the previous round.** Two things changed under this leg and
both are the reason it was owed again:

1. **The conversation hosts now draw the card's fields SUBORDINATE to the chat box**
   (§I's input rule), so every chat cell is a different picture. The treatment is
   MEASURED here, not asserted: `page-controls.json` carries the computed border,
   background, box-shadow and radius of the fields region and of the field itself, and
   the label's font-family, on each host and in each theme.
2. **The shipped capture recorder admits `agent_hitl_screen` as its fifth kind**, so the
   cells are recorded by `scripts/audit/lib/chat-hitl-capture-driver.mjs --walk` and
   registered in the canonical index — `scripts/ci/chat-hitl-capture-index.json` — where
   the other four kinds' records live. Eight of the twelve are registered there. The
   other four are refused by the recorder, the refusal is a finding below, and **nothing
   was changed to get past it**.

## What a record of this kind needs, and how these were registered

Read off `scripts/ci/lib/capture-record-contract.mjs` (`CARD_KINDS.agent_hitl_screen`),
`scripts/audit/lib/chat-hitl-capture-recorder.mjs` and
`scripts/audit/chat-hitl-acceptance-gate.mjs` before anything was driven:

- **The cell NAME is a claim and must parse.** `parseCellName` splits on `__`, finds the
  host token, and reads the kind token IMMEDIATELY BEFORE it and the state token after
  it. The kind tokens for this kind are `hitl-card` / `hitl-screen` /
  `agent-hitl-screen`; the states are `pending` and `decided` (its own `asking` token
  normalises to `pending`). So each cell here is named
  `<cell-id>__hitl-card__<host>__<state>[__dark]`.
- **The host must be one a picture of this kind can be taken on.** The kind declares
  `capturableHosts: ["chat_thread", "run_card"]` and gives `site_widget` and
  `page_gate_region` a `compositionOnly` REASON each. `validateWalkPlan` refuses a plan
  cell for either of those before a browser opens, and `validateCaptureRecord` refuses a
  record for one with the reason attached. So **no picture of those two was asked for**;
  their reasons are quoted at the end of this file.
- **A `pending` record owes**, all counted by the recorder on the screen: the
  conversation list (chat_thread only) frame-scoped; `[data-lifecycle-card-host="<host>"]`
  frame-scoped AND inside the pinned card root; `[data-lifecycle-card="agent_hitl_screen"]`
  frame-scoped; and the kind's ONE decision control, `[data-conformance-id="hitl-screen-fields"]`,
  counted INSIDE the card root. Each count must be ≥ 1 **and painted**.
- **It must pin the card it measured.** `instance` records the root selector, how many
  matched, which index was pinned and every attribute observed on that element.
- **It must carry its own provenance**: `declaredHost`, `declaredKind`, `declaredState`,
  `finalUrl` of the right URL class (`chat` for chat_thread, `run_detail` or `chat` for
  run_card), the repo-relative screenshot, its sha256 hashed FROM DISK, `build`,
  `framing`, `capturedAt`, and `recordedBy` equal to the one shared recorder id.
- **The measurement is taken twice**, before and after the shutter, and a capture whose
  counts moved is refused rather than written.
- **Registration** is the driver's own `--walk` write into
  `scripts/ci/chat-hitl-capture-index.json`, merged in place: a record it rewrote replaces
  the one that stood, and every other record survives untouched. That file went from 81
  to **89** records; the 81 that were there are byte-identical.
- **The prose the recorder does not write is added afterwards, and disclosed.**
  `observeCapture` writes the measurement and nothing else — no `runtime`, no `runId`, no
  database readback, no provider evidence — while every record already committed in that
  index carries all four, added the same way by the round that made it.
  `drivers/16-annotate-index-records.mjs` adds exactly those fields to the eight records
  this round's walk wrote, touches no assertion, no count and no hash, and re-validates the
  WHOLE index with the shipped validator before it writes anything.
- **The acceptance gate** reads the whole index twice — the ratified contract's
  `validateCaptureIndex` first (the canonical floor), then the audit tier's own extras —
  and separately binds every `chat_thread` cell the acceptance MANIFEST cites. This round
  adds records, not manifest rows, so the binding half is unchanged; the index half now
  validates 89 records instead of 81. It exits 0.

## THE REFUSAL — a `decided` record of this kind cannot be written by the shipped recorder

Driven twice, on two different runs, at the moment the answer landed:

```
walk cell "HC-decided__hitl-card__chat_thread__decided" produced a record the index would refuse:
  record "HC-decided__hitl-card__chat_thread__decided": a chat_thread record must carry the
  `instance` its card-scoped counts were read from — without it the counts describe whichever
  card led the DOM
```

It is a contradiction between two of the recorder's own rules, and it fires only for the
kind that declares `settledIsAbsence`:

- `scripts/ci/lib/capture-record-contract.mjs` — `settledIsAbsence: true` on this kind, so
  `requiredAssertionsFor` emits **no root-scoped requirement** for a `decided` capture: the
  card root is owed ABSENT, and there is no root left to count anything inside.
- `scripts/audit/lib/chat-hitl-capture-recorder.mjs`, `captureRequirementsFor` — the audit
  tier's own root-scoped addition is skipped for the same reason
  (`if (root && !(settledIsAbsence(kind) && state === "decided"))`).
- `observeCapture` — with no root-scoped spec, `rootSelector` is null, no card instance is
  resolved, and the record carries no `instance` field at all.
- `validateCaptureRecord` — at the audit tier, ANY record whose `declaredKind` has a card
  root must carry an `instance`, and this one cannot. `observeWalkCell` throws.

So the four `decided` cells are **not in the canonical index**. They were shot by
`drivers/15-shoot-the-refused-cells.mjs`, which writes the same record shape into
`capture-records.json` beside them, labelled `registered: false` with the refusal quoted
in each record. The picture is real and the reading is real; what is missing is a
registration the shipped recorder will not make. **This is a finding, not a workaround.**

## The runtime, said first

`node scripts/dev-server.mjs` (Next.js 16.2.10, Turbopack), `CINATRA_RUNTIME_MODE=development`,
`NODE_ENV != production`, on a **dedicated lane database** on the local verify Postgres
(5634) and the verify Redis (6579), loopback-only, with this branch's own pinned extension
tree (112 packages) and its bundled dev package registry and agent runtime container
brought up from this checkout. It is **not** a production-equivalent build: these are the
dev builds of the same components, and every record is labelled `development`.

**A REAL MODEL PROVIDER, configured through the app's own form.** The instance's provider
was set up on `/setup/model` by the driver on `main`
(`evidence/2790-s9f-host-parity/drivers/17-provider-setup-through-the-app.mjs`), which read
the credential from its process environment and typed it into the shipped form, so the app
sealed the connection itself. The credential is in no file here, in no argument, in no log
and in no record. `CINATRA_TEST_LLM_PROVIDER` is set in nothing this lane starts and the
server log carries **zero** scripted-runtime lines. What the instance actually called is in
`readback/run-readback.json`: provider `openai`, `gpt-5.5` — 6 streamed chat turns — and
`gpt-5.5-2026-04-23` — 12 generate calls inside the runs — 222,680 input and 5,342 output
tokens.

**The public origin was set through the app's own UI** at
`/configuration/development?tab=tunnel` — origin only, never by hand-editing the database —
and read back through the app's own `/api/mcp-settings`. The lane's public origin answered
`200` before any pictured turn.

**The instance namespace** was provisioned through the app's own `/setup/name` step before
any run materialised an artifact.

### The limits of this round, stated

- **Four turns were refused before the ingress was warmed.** The runtime HEADs the public
  MCP URL with a 2 500 ms budget and refuses the turn outright if it does not answer; the
  first hit through this lane's ingress takes about 3.3 s and, warmed, about 0.35 s. All
  four refusals are counted in `readback/run-readback.json`
  (`negativeScreens.publicMcpRefusals: 4`) rather than trimmed out. The pictured turns were
  taken with the ingress warm.
- **`drivers/13-run-readback.mjs` could not see its own subject and was fixed here.** Its
  `publicMcpRefusals` screen matched the wording the app STORES on a refused turn ("is not
  reachable") while the server writes "is unreachable", so it counted **zero** on a session
  that really did refuse four turns. Both spellings are counted now, and the positive
  callback line is counted too.
- **The process-table read establishes nothing on this host.** `ps -E` prints no
  environment for the listening process (`env.tokensSeen: 0`), so the positive evidence for
  a real provider is the usage rows, the **26** `POST /api/mcp 200` callbacks from the
  provider's own servers over the public ingress, the **2** `[llm-bridge-run-select]` lines
  the agent runtime produced, and the absent scripted lines.
- **The first run of this lane failed at artifact materialisation**, and it is on the
  record: `0f99ca1c-c81f-4170-83ea-dd6940d893d7` was answered on both gates, resumed, ran
  the flow and wrote the draft, then failed with *"artifact materialization failed — the run
  declared artifact output(s) it did not produce (1 of 1 failed): (binding-resolution):
  failed to load the run package's artifact bindings: 404 Not Found … no such package
  available"*. That is a LANE fact: the agent was installed through the product's Upload
  Extension screen, which writes the install row but publishes no tarball, and the binding
  resolver reads the package from the instance's own registry. The three packages were then
  published to that registry and the whole leg was driven again on a second run, which is
  the run every cell below stands on. Nothing about the card changed between them.
- **`drivers/05-chat-run-to-hitl-screen.mjs` named a table that does not exist**
  (`cinatra.agent_run_hitl_gate_artifacts`); the shipped table is
  `cinatra.agent_run_hitl_gates`, which the sibling drivers already read. Fixed here.

## The direct-SQL lane writes, disclosed — there are two

Both are account provisioning for a throwaway lane account on a database that is dropped
when the lane ends. Neither touches a run, a trigger, a gate, a record or any row a
photographed screen reads.

1. **`UPDATE public."user" SET role='admin'`** (`drivers/01-lane-setup.mjs`) — the setup and
   configuration screens this lane walks are admin-gated.
2. **`INSERT INTO public.member`** (`drivers/04-join-template-org.mjs`) — the lane account
   joins the organization the instance's own boot stamped every agent template with. A run
   proposal is refused outright for a template outside the caller's active organization.

`grep -rniE "insert into|SEEDED_|seedGate|seedTurn|update .* set status" drivers/` returns
the one `INSERT` above and nothing else. **No run, gate, park, record or review task in
this lane was inserted, and no status was written by hand.** One further lane fact is
disclosed rather than buried: the wizard's **Secrets** step was completed **through the
app's own form** with a lane-local placeholder value, because setup completeness gates
`/configuration` and this lane opens no OAuth connector connection. The connection service
itself is up and healthy; nothing was written to the database by hand for it.

## The requires, from the pinned drawing, verbatim

Fetched read-only at the contract's own `specCommit` —
`design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f specs/app-lifecycle-cards.html` — and
rendered with the capture browser into `drawings/`.

**§I, the turn shapes and the content slot.**

> "A **person's** turn is right-aligned: their name and initials above, then a **filled bubble** that hugs its text, then the quiet copy and edit marks beneath. The **assistant's** turn is left-aligned and carries **no bubble** — the Cinatra mark and name, then the content on the thread ground, filling the column. A **card takes that content slot**, at the column's full width, exactly where prose would otherwise sit."

**§I, one input, not two.**

> "The **chat box is the one primary input**: it is where a reader types by default, and the **prompt window** acts through it on the **active card** — the card bound to it — under that card's own authorization. The note field is **subordinate**: it stays, because a rationale belongs with the decision it rides, but it is never drawn as a second place to hold a conversation."

> "**How the weight is taken off it.** The note field gives up the three things that make the chat box read as somewhere to type — the **enclosing box**, the **raised ground** and the **send affordance** — and keeps a single quiet ruled baseline under a mono label."

> "No box of its own, no fill, no send. A ruled baseline under a mono label — it reads as a field on the card, not as somewhere to start typing."

**§I, THE INPUT RULE — the clause every cell here is graded against.**

> "**The rule, wherever a card meets a chat box** — Exactly one primary input is drawn per conversation, and it is the chat box. Any field a card carries is drawn subordinate to it. Where there is **no** chat box to be subordinate to — the run page and the review page — the card's field is the only input there is and takes the primary treatment instead. The hierarchy is between the two inputs, not a fixed look for either one."

**§IX, where each card appears.**

> "Every card appears on **every** host, and it is the **same card** wherever it appears: the same regions, the same states, the same data on screen, and the same actions its reader is authorized to take. Only the **frame** changes — the thread, the widget's panel, the run card's detail column, the gate region of the review page."

> "A reader who may not read the target gets **absent** — no card DOM at all."

**And the absence, which is a clause of its own:** §IX's presence matrix has four rows —
*Review*, *Verification*, *Recommendation*, *Schedule proposal*. There is no HITL row.
`drawings/DRAWING-2__lifecycle-cards-section-IX.png` is the picture of that, and
`drawings/DRAWING-3__components-no-pause-screen.png` is the picture of the sibling file
having no pause screen either. **There is no ratified drawing of this card at the
contract's pin**, which is what the pull request's deviation 1 now says.

**The plan's own words** (PLAN: Agents Lifecycle (B)):

> "an agent's HITL screen is fields with a Continue button"

> "A run at a moment shows its card on every host — the skills question, the schedule, **the HITL screen**, the review, the audit reading."

**The pull request's own words**, which every cell is also graded against:

> "when an agent stops in the middle of a run to ask you something, the question now shows up as a card of its own — in the conversation you are in, inside a third-party application, on the run page and on the review page — and it says which screen it is … the fields the step asks for and a Continue that answers them"

**The contract's anchors**, read by the recorder and by the sidecar:
`[data-lifecycle-card="agent_hitl_screen"]`, `[data-lifecycle-card-host]`,
`[data-conformance-id="agent-hitl-screen-card"]`,
`[data-conformance-id="hitl-screen-fields"]`, `[data-field-presentation]`, and the card's
own `[data-action="submit-hitl-screen"]`.

## The run these cells stand on

`@cinatra-ai/blog-draft-writer-agent`, asked for in the app's own chat in the person's own
words — *"Please run the Blog Draft Writer Agent for me now."* — and created by the app's
own dispatch (`agent_run`, off the model's own tool call; the transcript's tool calls are
`agent_list`, `agent_run` and nothing lifecycle-shaped). Run
`0998c3fb-facd-4881-acfe-f372decc73f5`, thread `0ae6d363-2081-48cc-91f5-2113b949c5cf`. It
reached **two** HITL screens and both are pictured:

| | gate | `x_renderer` | field | moment stated | the card's own Continue |
|---|---|---|---|---|---|
| **the setup screen** | `setup-0998c3fb…` | `@cinatra-ai/agent-builder:schema-field-fallback` | `idea` | `hitl` / `agent_hitl_screen` | **not drawn** (0) |
| **the mid-run screen** | `wayflow-6a85b4cd…` | `@cinatra-ai/context-selection-agent:context-selector` | — | none | **drawn, enabled** (1) |

## The measured field treatment — the numbers §I is graded on

Read off the live DOM by `drivers/14-page-controls-and-field-treatment.mjs`; every value is
in `page-controls.json` per cell.

| | `chat_thread` (light) | `chat_thread` (dark) | `run_card` (light) | `run_card` (dark) |
|---|---|---|---|---|
| `data-field-presentation` | **subordinate** | **subordinate** | **primary** | **primary** |
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

**That is §I's rule, measured.** In a conversation the field gives up its box (no border,
radius 0), gives up its fill (fully transparent), gives up its raised ground (no
box-shadow) and keeps *a single quiet ruled baseline* — one dashed 1px bottom rule on the
hairline token — *under a mono label* in JetBrains Mono, uppercase, tracked. On the run
page, where there is no chat box to be subordinate to, the same field takes the primary
treatment the same clause asks for: its own bordered, radiused, filled box on the muted
raised ground.

## The cells

Every count below was made by the shipped recorder on the screen the picture shows, in the
scope named, and every one is **painted** as well as attached.

### HC-pending — the conversation the run was started from, at the SETUP screen

`cells/HC-pending__hitl-card__chat_thread__pending.png` ·
`cells/HC-pending__hitl-card__chat_thread__pending__dark.png`
sha256 `394b793c42ec7ecfa6fe74789e56510074d07e19f50a3b3639e70229fdf71a41` ·
`d37603f98a3173a94d68468b347cbaaab75afd06fddc5c13eafe523f2f8f98a0`

**Requires** — §I's turn shapes and content-slot clause; §I's INPUT RULE in full; §IX's
"the same card … only the frame changes"; the plan's "an agent's HITL screen is fields with
a Continue button" and "A run at a moment shows its card on every host"; the pull request's
"a card of its own … in the conversation you are in"; and the five contract anchors with
`data-field-presentation="subordinate"`.

**Shows** — the person's turn right-aligned in a filled bubble; the assistant's turn
left-aligned with the Cinatra mark and name and **no bubble**, carrying its own sentence
*"Dispatched `@cinatra-ai/blog-draft-writer-agent` (runId: `0998c3fb-facd-4881-acfe-f372decc73f5`, status: `queued`). The run started."*; and the card filling the content slot at
the column's full width. Counted: `[data-conversation-list]` 1 (frame),
`[data-lifecycle-card-host="chat_thread"]` 1 (frame) **and** 1 (inside the pinned card
root), `[data-lifecycle-card="agent_hitl_screen"]` 1 (frame),
`[data-conformance-id="hitl-screen-fields"]` 1 (root). Also counted by the sidecar:
`[data-conformance-id="agent-hitl-screen-card"]` 1, `[data-field-presentation]` 1 =
`subordinate`, `[data-lifecycle-card-state]` 1, and **`[data-action="submit-hitl-screen"]`
0**. Exactly one lifecycle card is on the screen; the inline run panel stands beside it as a
progress summary (*Agentic Run Progress · Awaiting input · No messages yet.*) and draws no
second screen. Database at the shutter: `pending_approval`, `lifecycle_moment` `hitl`,
`lifecycle_card_kind` `agent_hitl_screen`, `input_params` `{}`.

**Verdict — PASS on identity, placement and the subordinate treatment; ONE §I sub-clause
does not show.**

- PASS: a card of its own, in the content slot, at full column width, with the kind, the
  host and the state on its own root, and one card only.
- PASS, measured: *"No box of its own, no fill … A ruled baseline under a mono label"* — the
  three numbers are in the table above, in both themes.
- PASS: the card's own Continue is **absent** on a setup gate, which is what the code draws
  (`classifyHitlGate` draws the outer Continue only for a mid-run binding), and the run
  panel beside it draws no outer Continue either, so the card and the panel agree.
- **DOES NOT SHOW — "no send".** The field renderer draws its own `Continue` button INSIDE
  `[data-conformance-id="hitl-screen-fields"]` (the sidecar's `sendAffordanceInFields` is
  one button, text `Continue`, carrying no `data-action`). §I's clause says the subordinate
  field gives up "the enclosing box, the **raised ground** and the **send affordance**", and
  its own example draws that field with no button at all. The pull request's stated
  exemption — *"The card's own Continue is the card's control, not an input, and it stays"*
  — does not reach this button, because the card's own Continue is measured at **0** here:
  the button in the picture belongs to the field's own subtree, not to the card. Stated as
  a defect, not softened. What it is NOT: it is not a second boxed input — the field itself
  carries none of the three weights, and the plan's own sentence requires a Continue
  somewhere.
- Noted, and **not this slice's**: the label reads **`Idea (optional)`** for an input the run
  cannot proceed without. The template's `required` is `["idea"]` while the gate's own field
  schema carries only `required: ["title"]`, so the fallback renderer
  (`packages/agents/src/schema-field-renderer.tsx`) has nothing at that level to read. The
  run page's block draws the identical label from the identical renderer.

### HC-decided — the same conversation after the setup gate was answered IN THE CARD

`cells/HC-decided__hitl-card__chat_thread__decided.png` ·
`cells/HC-decided__hitl-card__chat_thread__decided__dark.png`
sha256 `27aed1a0397fcb57833f02f26b5c95ff9b55d79707dad8016d24c674a96a13dc` ·
`c84dcc9a19f649bf2af07b351329c77017c9defd8a7e85c990d835c031f335f8`
**NOT REGISTERED — see the refusal above.**

**Requires** — the pull request's "a Continue that answers them", and the kind's own settled
reading: `packages/agents/src/agent-hitl-screen.ts` gives it two states and only two, and
`agent-hitl-screen-card.tsx:910` `if (!present || !asking) return null;` — `none` is NO DOM
AT ALL.

**Shows** — the answer *"How small teams keep their customer research organised"* was typed
into the field the card draws and the field's own `Continue` was pressed inside the card, in
the cookie host. Counted afterwards: card root **0**, owner anchor **0**, fields region
**0**, the card's Continue **0**; `[data-conversation-list]` **1** — the transcript is intact
and the card is gone. Readback either side of the press:

| | at | status | `input_params` | moment |
|---|---|---|---|---|
| before | `2026-08-27T09:23:09.393Z` | `pending_approval` | `{}` | `hitl` |
| after | `2026-08-27T09:23:53.927Z` | `pending_trigger` | `{"idea": {"title": "How small teams keep their customer research organised"}}` | `schedule` |

**Verdict — PASS on the reading, and the record is REFUSED by the recorder.** The card
re-read, settled to no DOM, and the run moved with the reader's own value merged into its
inputs. Stated exactly: the run advanced `pending_approval → pending_trigger` — setup
finished, awaiting the trigger choice — rather than to `queued`; that is the shipped setup
ladder and not a property of this card.

### HR-pending — the run page for the same run at the same moment

`cells/HR-pending__hitl-card__run_card__pending.png` ·
`cells/HR-pending__hitl-card__run_card__pending__dark.png`
sha256 `abc466af8f3cff92c9615cf905fcd1b5a05b71b64a71a88f4673d3a820310733` ·
`9f4044b7568f28c03813eca777229696f35b8ac0b3b1745334d12249d42012b6`

**Requires** — §I's run-page half — *"Where there is no chat box to be subordinate to … the
card's field is the only input there is and takes the primary treatment instead"*; §IX's
"the same card wherever it appears … only the frame changes"; the pull request's "on the run
page"; the anchors with `run_card` and `data-field-presentation="primary"`.

**Shows** — the run page's own *Agentic Run Progress* panel with an **Awaiting input**
badge, and inside it the same pause screen: `Idea (optional)`, the same textarea with the
same placeholder, the same `Continue`. Counted: `[data-lifecycle-card-host="run_card"]` 1
(frame) and 1 (root), `[data-lifecycle-card="agent_hitl_screen"]` 1 (frame),
`[data-conformance-id="hitl-screen-fields"]` 1 (root), `[data-conversation-list]` 0. Sidecar:
owner anchor 1, `[data-field-presentation]` = **primary**,
`[data-action="submit-hitl-screen"]` 0.

**Verdict — PASS.** Same card, same regions, same data, a different frame, and the field
takes exactly the primary treatment the drawing asks for where there is no chat box — its
own 1px-bordered, 7px-radius, white-filled box with an inset highlight, on the muted raised
ground of the fields region. The card wraps the panel's existing block rather than drawing a
second screen, which is what the pull request claims and what the picture shows.

Noted, and **not this slice's**: **the run page draws no step rail at a HITL gate** —
`stepRailPresent: 0` on both run-page cells. The rail slice #2970 covers the setup steps; a
HITL gate row on the rail is not in this slice's text.

### HC-midrun-pending / HR-midrun-pending — the question the agent stopped MID-RUN to ask

`cells/HC-midrun-pending__hitl-card__chat_thread__pending{,__dark}.png` ·
`cells/HR-midrun-pending__hitl-card__run_card__pending{,__dark}.png`
sha256 `cca28e16d33fd62ddf1830d5c8e525c6e8fd251dcea9c4db519f9e2c3a0f0de3` ·
`b5f8e3c42895765ed7ab1105ee62145a2e995815fb3373b5dafe1fe6825bac9b` ·
`7f84aefd96130e22ffd5a0cca00eac253e85cd887b5fdc4b86fc8f57565e977c` ·
`50fc956b1601938ba2088363383a7aee7a1fea4ebb3f9d4f85f97e2c2b68bcf8`

**Requires** — the pull request's sentence in full: *"when an agent stops in the middle of a
run to ask you something, the question now shows up as a card of its own … the fields the
step asks for and a Continue that answers them"*; §IX's same-card-every-host clause; §I's
input rule on the conversation host and its run-page half on the run page; all the anchors,
this time **including** `[data-action="submit-hitl-screen"]`.

**Shows** — after the setup answer the run was dispatched from its own trigger step
(`trigger_type` `immediate`, released `2026-08-27T09:25:07.920Z`), ran, and parked at a
runtime gate: `wayflow-6a85b4cd-e6fb-45c3-99ce-5242fbeabcb4`, renderer
`@cinatra-ai/context-selection-agent:context-selector`, materialised
`2026-08-27T09:25:09.577Z`. On both hosts the card draws the gate's own region — **Draft
Context**, *"No eligible context artifacts available for this slot. The agent will run
without context for `draftContext`."* — and the card's OWN `Continue →`,
`[data-action="submit-hitl-screen"]` **1**, enabled and painted. Counted on all four:
card root 1, host declaration 1 frame and 1 root, fields region 1 root, state declaration 1.
In the conversation the run panel is drawn beside the card as a progress summary (*Agentic
Run Progress · pending approval · No messages yet.*) and draws **no second screen**, so one
question is offered once.

**Verdict — PASS on the pull request's sentence and on §I.**

- PASS: the mid-run question is a card of its own on both hosts, in both themes, with the
  fields region and the card's own anchored Continue, and the Continue is drawn where the
  code draws it.
- PASS, and different from the setup gate: on `chat_thread` the card's Continue is **outside**
  the fields region (`sendAffordanceInFields` is empty), so on this gate the subordinate
  region carries no send affordance at all — §I's clause shows in full. On `run_card` the
  same anchored Continue sits **inside** the region, which is the primary treatment's own
  panel and is what §I asks for there.
- Measured, and **better than the previous round**: at the transcript's resting scroll the
  card's `Continue` is clear and topmost — `buttonIsTopmost: true` both before and after
  scrolling to the end (`drivers/12-measure-composer-occlusion.mjs`; button at y 694 in a
  900-px window, card floor at 737). The previous round measured `false` at rest.
- Stated: this gate's renderer draws **no input control** — no textarea, no label — because
  there is no eligible context to choose. So §I's "no box of its own, no fill" have no field
  to apply to here; what is measured is the region itself (transparent, unbordered, radius 0
  on `chat_thread`; the bordered muted panel on `run_card`) and the presentation attribute.

### HC-midrun-decided — after the card's OWN Continue was pressed

`cells/HC-midrun-decided__hitl-card__chat_thread__decided.png` ·
`cells/HC-midrun-decided__hitl-card__chat_thread__decided__dark.png`
sha256 `2b506320bfd09062315b3a9286ef7fa620706b8f6099a71036bd8c447254ace0` ·
`1dd4340505024d23c06551010bd21f3b2edb345de493a8263822d644ad1293e3`
**NOT REGISTERED — see the refusal above.**

**Requires** — the pull request's "a Continue that answers them" and "the run resumes"; the
kind's own settled reading as above.

**Shows** — `[data-action="submit-hitl-screen"]` was pressed inside the card in the
conversation at `2026-08-27T09:28:5x`, and the run RESUMED: `pending_approval → completed`,
`completed_at` `2026-08-27T09:29:35.715Z`; the artifact materialised (*How Small Teams Keep
Customer Research Organised*, `@cinatra-ai/blog-post-artifact:post`, updated
`2026-08-27T09:29:46.801Z`) and **the run's own review gate opened** —
`cinatra.artifact_review_gates`, 1 row, `lifecycle-review:15259f72…`, `pending`, created
`2026-08-27T09:30:01.351Z`. Counted afterwards: every HITL-card anchor **0**;
`[data-conversation-list]` **1**. The picture shows the HITL card gone and the review card in
its place in the same turn.

**Verdict — PASS on the reading, and the record is REFUSED by the recorder.** The card's own
Continue answers, the run resumes to completion, the card settles to no DOM, and the next
card in the lifecycle takes the slot.

### HR-decided — the run page's settled reading of this card

**No cell, and this is a code fact rather than a missing picture.** The card has **two
states and only two** (`packages/agents/src/agent-hitl-screen.ts`: `{state: "none"}` and
`{state: "asking"}`), and it renders `null` for anything that is not `asking`
(`agent-hitl-screen-card.tsx:910`). Its root, when drawn, always carries
`data-lifecycle-card-state="asking"`. **There is no settled reading of this card to
photograph on any host** — which is exactly what the capture contract encodes as
`settledIsAbsence: true` for this kind. Probed on the run page after completion:
`[data-lifecycle-card="agent_hitl_screen"]` **0**, and the surface draws
`artifact_review_gate` in its place (run `completed`, `completed_at`
`2026-08-27T09:29:35.715Z`). Recorded in `page-controls.json`'s sibling probe rather than
claimed as a cell.

### HW and HP — the two composition-only cells

**No picture was taken of either, and none was asked for.** The capture contract at this head
declares this kind capturable on `chat_thread` and `run_card` only, and gives each excluded
host its own reason, verbatim:

> **`site_widget`** — "a card travels from the run's own turn, and a widget conversation cannot start a run that reaches `pending_approval`: `agent_run` is not in the delegated widget allowlist (packages/mcp-server/src/delegated-widget-tool-policy.ts), and the content-editor launch claims no present human and runs queued -> running -> completed without ever parking (src/lib/host-content-editor-dispatch.ts). The mount is real and is proven by the card suite's widget arms and the real-store submit tier; it is the PICTURE that has no reachable subject."

> **`page_gate_region`** — "the review page draws a gate region for ONE review task, and this card refuses a MARKED artifact-review gate (packages/agents/src/agent-hitl-screen-core.ts) while the run's HITL context answers only for `pending_approval` — so a single-gate run shows the review gate or this one, never both, and no sequence reaches a run parked on a non-review gate while a review page for a different review task of the same run exists. The region composes the card; the composition is what is recorded, not a photograph of it."

Both are enforced mechanically: `validateWalkPlan` refuses a plan cell for either host
before a browser opens, and `validateCaptureRecord` refuses a record for one, each with the
reason attached.

## What was NOT changed to make any of this pass

`scripts/audit/chat-hitl-anchor-contract.json` — untouched.
`node scripts/audit/chat-hitl-acceptance-gate.mjs --print-anchor-digest` prints `recorded`
and `recomputed` as the same
`fa31fa2f1e73b545ba42e923636af4e4ac6025d623b6c5fdcc68d32342994d46`, at the same design pin.
`scripts/ci/lib/capture-record-contract.mjs`, `scripts/audit/lib/chat-hitl-capture-recorder.mjs`
and `scripts/audit/lib/chat-hitl-capture-driver.mjs` — untouched. The capture index gained
**eight** records and lost none; its other 81 are byte-identical. No product file is in this
commit.

## Reproducing it

```
export WALK_BASE=http://127.0.0.1:<port>
export SUPABASE_DB_URL=<the lane database>
export LANE_ACCOUNT=<the lane account>  LANE_SECRET=<its password>
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

node scripts/audit/lib/chat-hitl-capture-driver.mjs --walk evidence/2930-w3-hitl-card/capture-walk.json \
  --steps hc-pending-light,hc-pending-dark,hr-pending-light,hr-pending-dark
node evidence/2930-w3-hitl-card/drivers/14-page-controls-and-field-treatment.mjs
node scripts/audit/lib/chat-hitl-capture-driver.mjs --walk evidence/2930-w3-hitl-card/capture-walk.json \
  --steps hc-answer-light        # presses Continue IN the card; the decided record is REFUSED
node evidence/2930-w3-hitl-card/drivers/15-shoot-the-refused-cells.mjs
node evidence/2930-w3-hitl-card/drivers/09-run-right-after-setup.mjs   # dispatch -> the mid-run gate
node scripts/audit/lib/chat-hitl-capture-driver.mjs --walk evidence/2930-w3-hitl-card/capture-walk.json \
  --steps hc-midrun-pending-light,hc-midrun-pending-dark,hr-midrun-pending-light,hr-midrun-pending-dark
node scripts/audit/lib/chat-hitl-capture-driver.mjs --walk evidence/2930-w3-hitl-card/capture-walk.json \
  --steps hc-midrun-answer-light # presses the card's OWN Continue; the decided record is REFUSED
node evidence/2930-w3-hitl-card/drivers/15-shoot-the-refused-cells.mjs
node evidence/2930-w3-hitl-card/drivers/11-render-the-drawings.mjs     # the drawings, at the pin
node evidence/2930-w3-hitl-card/drivers/12-measure-composer-occlusion.mjs
node evidence/2930-w3-hitl-card/drivers/13-run-readback.mjs            # the rows
node evidence/2930-w3-hitl-card/drivers/16-annotate-index-records.mjs  # runtime/runId/dbAt/provider, re-validated
```

No driver here holds a credential or an origin: every one reads what it needs from the
environment of the lane driving it.
