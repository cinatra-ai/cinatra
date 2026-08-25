# S9d rework — evidence (cinatra#2788, PR #2939)

## Round 5 — every pictured cell re-shot on a chain with nothing stood in

Rounds 3 and 4 had to report one thing about themselves, and the maintainer
rejected the round for it: **the assistant's own turn came from the deterministic
model bridge**, and it was visible in the pictures in the assistant's own words —
"CINATRA_UAT_OK: deterministic chat reply." That is gone. All **fourteen**
pictures were taken again, and every leg of every pictured chain is the shipped
one.

**The chat turn now runs on the REAL provider, over the platform's own public
ingress.** The limit rounds 3 and 4 named was real: a real-model chat turn hands
the tool catalogue to the provider as ONE provider-hosted MCP reference, so it
needs a PUBLICLY reachable MCP URL, and the runtime refuses the turn outright
without one (`checkPublicMcpReachability`). This round has one. The instance's
public base URL was stated **through the product's own tunnel tab**
(`/configuration/development?tab=tunnel`), which is what records
`publicBaseUrlSource: "manual"` — no database row was hand-edited — and the
public `/api/mcp` endpoint answers. What follows from that is the whole point of
the round:

- the model chose the tool itself, and the thread's own dispatch part records it
  as a provider-hosted MCP call — `{"type":"tool_call","name":
  "schedule_proposal_render","serverLabel":"cinatra","id":"mcp_0e1afcff…"}`;
- the provider's servers called back into the shipped MCP endpoint over that
  public origin (`POST /api/mcp 200`, repeatedly);
- `usage_events` records `provider openai`, `model gpt-5.5` for the turn;
- and the assistant's words in the pictures are its own ("Schedule proposal is
  ready. Please confirm it on the scheduling card in this conversation to arm the
  one-time run."), not a bridge's marker.

`CINATRA_TEST_LLM_PROVIDER` was **UNSET** for the whole round. The scripted
runtime served nothing, and the server log carries **zero** scripted-runtime
lines.

**AND THAT IS NO LONGER ONLY THIS FILE'S WORD FOR IT.** Rounds 3 and 4 asserted
their database and runtime facts in prose and committed nothing a reader could
check. This round commits both:

- `readback/db-readback.json` — the rows themselves, produced by
  `readback/read-back.mjs` (committed beside it, and re-runnable against any
  lane) and left unedited. Every value `RUN-READBACK.md` and `TIMELINE.md` quote
  is in it, including the ledger rows naming which provider and model served each
  call, and every armed run this lane produced, discarded passes included.
- `readback/runtime-evidence.txt` — the server's own log lines, with the grep that
  produced each block so the extraction is repeatable, and ONE redaction applied
  everywhere it occurs: the instance's public origin, because a committed hostname
  is a leak and a lane the next operator cannot reproduce. Each block states what
  its lines can and cannot say — a log line does not name a caller's address, and
  a zero-result grep is not a capture of the process environment — and points at
  the row in `db-readback.json` that carries the load-bearing half.

Neither artifact makes the round self-proving — a lane can write its own log —
and this file does not claim it does. What they buy is that the numbers in the
prose can be checked against the rows and lines they were read from, instead of
being taken on faith.

**The agent's own execution is real too, and this time the run COMPLETED.** The
agent runtime called back into the shipped `/api/llm-bridge`, which resolved the
instance's own sealed `openai_connection` row by this run's own run token
(`[llm-bridge-run-select] served-by=run_token run=9384a346-…`); `usage_events`
records `provider openai`, `model gpt-5.5-2026-04-23` at `17:42:11.792+00`, and
the run reached `completed` with no error twelve seconds after the fire. The row
was written before the walk through the shipped sealed writer, from a credential
held only in the process environment: never printed, never logged, never written
to any file here, never committed.

**ONE RUN NOW CARRIES C1, C2, C3, C6 AND C8.** Round 4 had to say that C1 and C2
were two pictures of two different conversations; they are not any more. C1 and
C2 are the same card in the same thread before and after one Confirm, C3 is that
run's schedule step, C6 is that same card after the one-off came due, and C8 is
that same run's detail afterwards. C7 is a second, never-armed run — it has to
be, since an armed run's setup scheduling step is behind it — and C5 rides on its
own untouched proposal whose shipped 30-minute window was allowed to actually run
out.

**Nothing pressed *Run now*.** The walk plan contains no such action, no context
was on the run page between Confirm and the fire, the stamp landed 143 ms after
the second the person stated, and the runtime named the release job itself
(`[trigger-release] released gate for run 9384a346-…`).

**TWO typed sentences in `capture-walk.json` changed, and they are named rather
than left to be noticed** — the one the person types in `state-the-schedule` and
the one they type in `expired-clock`, which are the plan's only two `type`
actions. Both now state the instant and the timezone. The deterministic bridge answered any sentence with a daily recurrence,
so the old wording ("a few minutes from now") never had to be complete; a real
model reads it as a person would and ASKS which timezone to use instead of
guessing, ending the turn in a question rather than a card. Stating the instant
is what a person does when they mean a particular one. Every cell id, every
context, every viewport and every assertion in the walk is unchanged.

**Five armed runs were discarded before the pictured one**, each for a stated
reason — `RUN-READBACK.md` lists them with their release stamps. Two of them
failed artifact materialization because this lane's own dev registry held no
published copy of the agent package; publishing it there is what let the pictured
run reach `completed`. That was a LANE gap, not a product finding. All five
released within 143 ms of the second they were armed for, with nobody on the run
page — five independent corroborations that the schedule fires on its own tick.

**One cell still carries a FAIL and says so:** C7, against the named drawing's
two-column frame. It is not a regression this PR introduces; it is a standing gap
between the drawing and the shipped setup wizard, which this slice does not
touch. `PLAN-WALK.md` carries the graded verdict for every picture, written after
looking at the pixels.

## Round 4 — the two cells that carried a FAIL, re-shot on the fixed card

> **History.** Round 5 re-shot all fourteen pictures, so none of round 4's pixels
> is committed any more. This section is kept because the conformance fixes it
> describes are still the reason C2 and C6 read the way they do.

Round 3 reported three honest FAILs. Two of them were conformance failures in the
settled branch of the one schedule renderer, and both are now fixed:

1. **C2** — an ADJUSTED-then-confirmed card drew a supersede line over its rows
   ("This card was adjusted before it was set — open the run to see the schedule
   that was set."), so it declined the sentence it exists for: §7.2, "the same
   card, with the same option rows, **shows the schedule as it stands** — no
   label, no summary box". The card now re-opens on the settled rows and says
   nothing over them. `superseded` stays a resolver answer and stays on the wire —
   Confirm still refuses on the same comparison — it simply stopped being chrome
   the plan does not define.
2. **C6** — a FIRED one-off drew a disabled **Save changes**. §7.2: "once a
   one-off has fired it cannot be changed", and Save changes is defined for the
   changeable state only. A fired one-off now draws **no floor at all**: no Save
   changes, no Cancel schedule, no Run now, and no status line standing in for
   them. The rows simply stand, read-only, on the server's schedule.

So **C2 and C6 were re-shot, and nothing else was**. They were walked on their own
new run through the SAME recipe `capture-walk.json` carries: the schedule stated
in the chat composer, the rows ADJUSTED on the card before Confirm (the
deterministic producer proposes a daily recurrence; the person chose *Schedule for
later* and put `2026-08-24 09:34` / `UTC` in), Confirm, and then the one-off left
to come due on its own tick — `released_at 2026-08-24 09:34:00.088+00`, 88 ms
after the second the person stated. Nothing pressed *Run now*: the walk plan has
no such action, no context in this round was on a run page, and the runtime logged
the release job opening the gate for this run by name (`RUN-READBACK.md` quotes
it — the stamp alone would not say WHO released, because *Run now* writes the same
one). The agent then
executed on the REAL model: `usage_events` records `provider openai`,
`model gpt-5.5-2026-04-23` at `09:34:04.876+00`, and the run reached `completed`
with no error five seconds after the fire.

**C1, C3, C5, C7 and C8 kept round 3's pixels at the time**, because the fix
touched only the settled branch of the renderer. (Round 5 has since re-shot all
fourteen — see the top of this file — so none of round 3's or round 4's pixels
are committed any more.) One consequence is stated rather than left to
be noticed: C1 and C2 are no longer two pictures of ONE conversation — C1 is round
3's thread and C2/C6 are round 4's — so the "one card, in one place, before and
after one press" reading is carried by C2's own record (one card instance, one
thread URL, Confirm gone from the card root) and by the walk's own actions — one
context, one page, one press between the two steps — instead of by a picture pair.
What a reader can check in the committed pixels is narrower and is stated as such:
C2 shows ONE settled card in that conversation with Confirm gone and Save changes
in its place.
`RUN-READBACK.md` and `TIMELINE.md` carry both runs, and the index count was
unchanged: four records replaced where they stood, 58 in, 58 out. (Round 5 then
replaced all ten S9d records the same way.)

Two things about round 4's environment are worth stating plainly, because round 3
had to report the opposite of the second one:

- **The chat turn is still the deterministic bridge**, and it is visible in the
  pictures in the assistant's own words ("CINATRA_UAT_OK: deterministic chat
  reply"). A real-model chat turn hands the tool catalogue to the provider as one
  provider-hosted MCP reference and needs a PUBLICLY reachable MCP URL, which this
  machine does not have. The bridge stands in for ONE decision — which tool the
  turn calls; the producer, the proposal token, the org boundary and the card are
  all the shipped path.
- **The agent's own execution used the REAL model, and no fallback was needed.**
  The agent runtime calls back into the shipped `/api/llm-bridge`, which resolved
  the instance's own sealed `openai_connection` row (`POST /api/llm-bridge 200`,
  served by run token for this run) — the 424 the toolbox load can raise without a
  public MCP URL did not occur, so nothing was removed on the clock and the
  scripted runtime never served this run. The row was written before the walk
  through the shipped sealed writer, from a credential held only in the process
  environment: never printed, never logged, never written to any file here.

## Round 3 — what the maintainer rejected, and what the proof set is now

> **History.** Round 5 re-shot all fourteen pictures. This section is kept because
> the two rulings it records are what §7.2/§7.4 were amended to say, and they are
> still the sentences C3 is graded against.

Round 2's run-page cell (C3) showed a composition the plan does not contain: the
schedule's configuration opened **inside the rail column, under its own row**,
with the **agentic run progress** card drawn beside it on a run that had never
executed. Two rulings followed, and both are now in plan (A):

1. §7.2 step 5 / §7.4 step 7 — "open that step to see the configuration or change
   it — **it opens to the right of the steps, never directly under a step, and no
   agentic run progress card is shown with it**."
2. "It makes absolutely no sense to show the agentic run progress card here" —
   the agent has not run; there is no progress to show.

The ratified drawing says the same thing about the surface these cells
photograph (`images/lifecycle-screens/design-run-surface-rail-and-gate.png`):
"a **step rail** down the left names the run's ordered steps, and the **run
detail** on the right shows the selected step … Selecting a step opens it on the
right … right here in the run detail, under the same rail, never as a standalone
document."

So the code changed (the schedule row is a rail ENTRY; its surface opens in the
run-detail column; a run with no execution record draws no progress section and
opens on the schedule step) and the proof set changed with it: the schedule is
now walked through its **three stages on both page hosts**, which is what a
reader has to be able to see.

## Cells

`capture-walk.json` is the executable plan, and it was walked. Every cell is
**light + dark**, the **full browser window** (no clip, no element handle, no
fullPage), and counted off the live page by the recorder. The two page controls
were photographed the same way but are NOT records — see below for exactly what
that does and does not buy.

| cell | stage | host | what the picture must show | filed as |
|---|---|---|---|---|
| C1 | first shown | chat | the stated one-off, rows editable, **Confirm** | record, light + dark |
| C2 | configured, not run | chat | the SAME card after Confirm: same rows, **Save changes** | record, light + dark |
| C6 | ran | chat | the same card after the one-off fired; Save changes no longer offered | record, light + dark |
| C7 | first shown | run page | the run's own scheduling step — "When should this run?", the three rows, **Continue** (§7.4 today, step 4) | **page control** — see below |
| C3 | configured, not run | run page | the rail on the LEFT with **Schedule** selected, the form in the run detail on the RIGHT, **no agentic run progress card anywhere in the window** | record, light + dark |
| C8 | ran | run page | the run's steps in the run detail, the schedule step still listed in the rail | **page control** — see below |
| C5 | expired (extra) | chat | still visible, still editable, **Confirm** alone on the floor | record, light + dark |
| C4 | — | review page | this run's real artifact review | DROPPED — see `TIMELINE.md` |

Fourteen pictures, all taken by **round 5**, and every one of them says which run
it stands on. **One armed run carries C1, C2, C3, C6 and C8** — the same card in
the same conversation before and after one Confirm, that run's schedule step, that
same card once the one-off came due, and that same run's detail afterwards. **C7 is
a second, never-armed run**, and that stage can only exist there, since an armed
run's setup scheduling step is behind it. **C5 rides on its own untouched
proposal**, whose shipped 30-minute window was allowed to actually run out.
`RUN-READBACK.md` gives every row, including the proposal-ref→consume-key join
that binds the conversation to the run. `PLAN-WALK.md` carries the graded verdict
for each picture, written after looking at the pixels; **one cell still carries a
FAIL on a clause and says so** (C7, against the named drawing — a standing gap in
the setup wizard, not a regression this PR introduces).

| file | sha256 | filed as |
|---|---|---|
| `C1__chat-first-shown__light.png` | `064fbd044500cf0d50bc46ca31aaea48a1ec2a64b653c5fc1f2c9a5b0b4207dc` | record `S9d-C1__schedule-card__chat_thread__pending` |
| `C1__chat-first-shown__dark.png` | `3d960614b45231411efdf971d366a88cdfb3fb902bb2a9e2392de21531d77aa3` | record `S9d-C1__schedule-card__chat_thread__pending__dark` |
| `C2__chat-configured__light.png` | `a56b17646f5b896cb31237ce4424b47584cf60ac4e71097e7a7dc34b2cd41eaf` | record `S9d-C2__schedule-card__chat_thread__decided` |
| `C2__chat-configured__dark.png` | `65a3d02ad9b46131b8ef75e9e176a78f3f9a373776d60117414fca4f1f8d63af` | record `S9d-C2__schedule-card__chat_thread__decided__dark` |
| `C5__chat-expired__light.png` | `ddd1973a5607cb2281606623ee3bae19328354a7844ee1521214a4e75fb31b7f` | record `S9d-C5__schedule-card__chat_thread__pending__expired` |
| `C5__chat-expired__dark.png` | `43cbeb53bd69d9afae925dbcd0e1f8ecce1938f39e1c15979cc8bf8165c529d2` | record `S9d-C5__schedule-card__chat_thread__pending__expired__dark` |
| `C3__run-page-configured__light.png` | `698f017dc575521f7d73219fbe1219cf946a2134d7093270e42417a2f25867d7` | record `S9d-C3__schedule-card__run_card__decided` |
| `C3__run-page-configured__dark.png` | `63ab1513f40133c57f7493b68d875e2245e3d4ae0e91b5448c8864504bda7c9d` | record `S9d-C3__schedule-card__run_card__decided__dark` |
| `C6__chat-ran__light.png` | `e87625ecab474290bf736c54aafca8dfd67f4661a4d7091d585b303fed2f3d3f` | record `S9d-C6__schedule-card__chat_thread__decided__after-fire` |
| `C6__chat-ran__dark.png` | `ccabf74343e98b9118cee1ca7d434e69ab59dafe1e31e844bf1830dd2f56370e` | record `S9d-C6__schedule-card__chat_thread__decided__after-fire__dark` |
| `C7__run-setup-scheduling-step__light.png` | `411fc70e6ca118e5be252299bbb9128540cc2617e6375699343f7fceafe33296` | page control (light) — no index record |
| `C7__run-setup-scheduling-step__dark.png` | `3082afe8621e456965c40b1eacfa30fccdc64a8dd49ff8670e35d97f6a6a8cc0` | page control (dark) — no index record |
| `C8__run-detail-after-fire__light.png` | `3831af1d87c0a6f4dd60a6b284149d23d472ecbaf2653448fcb792009e64c359` | page control (light) — no index record |
| `C8__run-detail-after-fire__dark.png` | `86fff475add5688313ea40b11e92b77a65ac601110e0eee0af6e2024a8a32514` | page control (dark) — no index record |

The two round 2's **C3** records were deleted from
`scripts/ci/chat-hitl-capture-index.json` (56 records → 54) together with their
two images: they photograph the rejected composition, and a record that
describes pixels the product no longer draws is worse than no record. Nothing
was edited in place and no record was hand-written — the index is
recorder-measured only, and the next walk writes the new ones.

Round 5 then replaced all ten S9d records where they stood — 58 records in, 58
out, the other 48 byte-identical and in the same order — and re-took the four page
controls. Each was written by `chat-hitl-capture-driver.mjs --walk` in this lane,
and none was edited afterwards. What a READER can check without taking that on
trust is narrower, and is what the record is worth: every S9d record's `sha256`
matches the committed PNG beside it, and its `assertions` are counts the image can
be read against. `recordedBy` is a field in a JSON file, not a signature — it says
which tool wrote the record, and it cannot prove it.

## The two cells this index cannot hold — filed as PAGE CONTROLS

C7 and C8 are real screens and they are photographed, but neither can be an
honest **record** here. Every record in
`scripts/ci/chat-hitl-capture-index.json` asserts
`[data-lifecycle-card-host="<host>"]` on the screen it photographs —
`requiredAssertionsFor` in `scripts/ci/lib/capture-record-contract.mjs` requires
it with or without a card kind — and:

- **C7** is the run's SETUP scheduling step, the shipped trigger screen
  (`packages/agents/src/trigger-screen-client.tsx`). It draws no lifecycle card.
- **C8** is the run detail after the fire, where the schedule is a rail **row**
  and its surface is not drawn. No card on the screen either.

Both readings were counted off the live pages and are `0` in
`page-controls.json`, so this is measured rather than asserted. Giving either
screen an anchor for the recorder to count would mean drawing something the plan
and the drawing do not define, and making the index accept a card-less record
would change the anti-fraud contract S9h owns.

So they are filed as PAGE CONTROLS, and it is worth being exact about how much
that is worth. Each is a real full-window picture in light and dark; its painted
anchor counts are read off the live page through the SAME `playwrightPage`
reader a walk cell is measured with, so the counts are measurements and not
claims. But the entry does **not** go through `observeWalkCell`, the
capture-record contract, the index schema or any CI gate: it is a sidecar this
round writes, with its PNG, sha256, framing, app-relative final path, resolved
theme and counts in `page-controls.json` (and the sha256 table above) and **no
index record** — each entry saying so in as many words:

> `"record": "NONE — not a lifecycle host; filed as the page control (see README.md)"`

`drivers/page-control.mjs` is the driver. It writes no verdict: the verdicts are
in `PLAN-WALK.md`, written from the pixels. A repository search found no earlier
sidecar of this shape, so this is a filing this round PROPOSES, not one it
inherits — which is the open question for the maintainer below.

## What the environment forced in rounds 3 and 4 — BOTH LIMITS ARE GONE

**Round 5 removed both of the limits below**, and they are kept here only so a
reader can see what changed and why the earlier pictures looked the way they did.
The public ingress the first limit needed now exists and is stated through the
product's own tunnel tab, so the chat turn runs on the real provider; and because
the real model reads the person's sentence as written, the one-off no longer has
to be corrected on the card, so the second limit's consequence never arises. See
"Round 5" at the top.

Two things in ROUNDS 3 AND 4 were not what the walk plan's note describes, and
both were environment limits rather than product findings. They were stated in
those rounds' `PLAN-WALK.md` verdicts and in `TIMELINE.md` rather than left for a
reader to notice.

1. **The assistant's own proposal came from the deterministic model bridge, not
   from a real model.** A real-model chat turn hands the platform's tool
   catalogue to the provider as ONE provider-hosted MCP reference, so it needs a
   PUBLICLY reachable MCP URL (`checkPublicMcpReachability`; the runtime refuses
   the turn outright without one, and the widget/chat tool build returns the
   "Cinatra MCP public URL is not configured" error). Opening a public ingress to
   a development server was not available for this round, so the chat surface ran
   on the deterministic bridge — which is visible IN the pictures, in the assistant's
   own words: "CINATRA_UAT_OK: deterministic chat reply." The bridge stands in
   for ONE decision, which tool the turn calls; the producer, the proposal token,
   the org boundary and the card are all the shipped path.
2. **Because that bridge only ever proposes a daily recurrence, the ONE-OFF was
   stated by the person ON THE CARD** — choosing *Schedule for later* and putting
   `2026-08-23 21:22` / `UTC` into the card's own fields before pressing Confirm.
   That is the plan's own sentence ("until you confirm, you change the schedule
   directly on the card — the rows are never locked behind a separate step"), so
   the path is a shipped one and the round exercises that sentence instead of
   only photographing it. Its one visible consequence in round 3 was the line C2
   and C6 drew above the rows — the shipped `SUPERSEDED_SCHEDULE_COPY`, "This card
   was adjusted before it was set — open the run to see the schedule that was
   set." Round 3 reported it as a FAIL against C2's plan sentence rather than
   papering over it; **that line is now gone** (see "Round 4" at the top), and
   round 4's C2/C6 are the same adjusted-then-confirmed path photographed on the
   fixed card.

**The agent's own execution used the REAL model.** That half needs no public
ingress: the agent runtime calls back into the shipped `/api/llm-bridge`, which
resolves the instance's own sealed `openai_connection` row. The row was written
before the walk through the shipped writer the setup wizard uses, from a
credential held only in the process environment — never printed, never logged,
never written to any file produced here, never committed.

**Nothing pressed *Run now*, in any round.** Round 3's one-off was released at
`released_at 2026-08-23 21:22:00.163+00`, 163 ms after the second the person
stated and seventeen minutes after the row was written; round 4's at
`released_at 2026-08-24 09:34:00.088+00`, 88 ms after its own stated second and
seven minutes after its row was written. The stamp itself proves RELEASE and not
WHO released — *Run now* writes the same one — so what each round can say for it
is set out in `RUN-READBACK.md`: round 3 has its walk's own actions and the
timing; round 4 has those plus the runtime's `[trigger-release]` lines naming the
release job for its run.

## Red first

`RED-FIRST.md` carries round 3's table: the four DOM facts of the reworked
composition, and the run-detail predicates, were written before the component was
touched and failed against `2ba505904` for the stated reasons.

## What is still owed on this round

- Nothing on the cells: all fourteen pictures are taken, graded and filed, and
  every one of them was re-shot by round 5 on a chain with nothing stood in. The
  index holds 58 records; round 5 replaced the ten S9d records where they stood
  and left the other 48 byte-identical. C7 and C8 are page controls with no
  record, by the reasoning above.
- C4 stays dropped. See `TIMELINE.md`.
- The maintainer's answer on whether the page-control filing is the one they
  want for C7 / C8 is still the open question. It is a shape this round proposes:
  a measured sidecar with no record and no gate behind it. The alternatives are
  to widen the record contract so a card-less screen can hold one, or to accept
  that these two stages are photographed but not indexed.
- ONE cell still FAILs a clause and is reported that way rather than softened:
  C7 (the named drawing's two-column frame — the setup wizard's page has neither
  column). It is not a regression this PR introduces; it is a standing gap between
  a drawing and the shipped setup wizard, and the slice does not touch that screen.
  The two FAILs round 3 reported — C2's supersede line and C6's disabled **Save
  changes** — were fixed in round 4 and are PASS again on round 5's own pixels.

## Owed elsewhere: six cells the Audit relabel left with old pixels

The **do not shoot here — a UI lane owns these** list. cinatra#2945 (merged)
relabelled the audit lane **Core analysis → Audit** everywhere a person can see
it, and six committed captures still show the retired word, so six index records
now describe text the product does not draw. **B1–B4** in
`evidence/2852-before-after/captures` photograph the review card's chip row and
its decision floor, whose heading `review-gate-card.tsx` changed from
`Core analysis · Suggestions` to `Audit · Suggestions`; **G5** and **G6** in
`evidence/2791-s9g-conformance/captures` photograph the audit card itself on the
run page and on the review page, whose heading `verification-summary-card.tsx`
changed from `Core analysis` to `Audit` and whose rail entry in
`run-step-rail.ts` changed with it. The re-shoot is a pixels-only round on a lane
with a browser: reach the same four surfaces the two rounds already reached
(B1 / B2 the page gate region and B3 / B4 a real transcript, on one run with
every suggestion accepted and then one chip dismissed; G5 the run page and G6 the
review page's verification view on an advisory audit), take each capture the way
its round took it, and re-record all six through
`scripts/audit/lib/chat-hitl-capture-driver.mjs` so the six index records are
replaced by measurements of the new pixels rather than edited in place — the
anchors these cells are graded on did not move, only the word on them did, so a
record whose hash still matches the old image is the only thing standing between
the index and the truth. Nothing about these six is fixed by this commit.

## Round 2, kept for the record

Round 2 walked the same path through the recorder and merged eight records
(48 → 56). Its four answers to round 1 still stand and are not re-litigated here:
full-window framing declared per cell and written into every record; no seeded
transcript and no hand-minted token; the summary box, the held-steps block and
the "Armed ·" line removed from the card on every host; and the two control
labels — `Cancel trigger` → **Cancel schedule**, `Release now` → **Run now**,
`data-action` ids unchanged. Plan (A) §7.2 now names those two controls itself,
so the open deviation round 2 recorded against that sentence is closed.
