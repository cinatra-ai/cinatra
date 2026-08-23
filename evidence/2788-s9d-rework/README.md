# S9d rework — evidence (cinatra#2788, PR #2939)

## Round 3 — what the maintainer rejected, and what the proof set is now

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

Fourteen pictures. Twelve of them are ONE run — the run the schedule armed and
the scheduler released — and the two C7 pictures are the fresh, never-armed run
that stage can only exist on: an armed run's setup scheduling step is behind it.
`RUN-READBACK.md` gives both rows. `PLAN-WALK.md` carries the graded verdict for
each picture, written after looking at the pixels; **three cells carry a FAIL on
a clause and say so** (C2, C6, C7).

| file | sha256 | filed as |
|---|---|---|
| `C1__chat-first-shown__light.png` | `1b8e9b4998ee646ec228affac81bd4140ee44a613eb9a7a161e8565335560060` | record `S9d-C1__schedule-card__chat_thread__pending` |
| `C1__chat-first-shown__dark.png` | `8573b88f438348488390b10a97b2871f0523910832a8938077b704758a40a4bc` | record `S9d-C1__schedule-card__chat_thread__pending__dark` |
| `C2__chat-configured__light.png` | `c3b024963654b5e3c47074f529716648a30bfd6a139fffe40309257aaec63ee8` | record `S9d-C2__schedule-card__chat_thread__decided` |
| `C2__chat-configured__dark.png` | `81823e5c91936307efc8977c30ec41e11cf1356784460b004ce651b37cabc908` | record `S9d-C2__schedule-card__chat_thread__decided__dark` |
| `C5__chat-expired__light.png` | `59c45ffb4f73437d2d10d684161db83825c04043910092de68a6e374ef0430c5` | record `S9d-C5__schedule-card__chat_thread__pending__expired` |
| `C5__chat-expired__dark.png` | `8345fbef5ff93b0e5eb51370a654ade0c8fb54d6d32989e66f46593cb6059671` | record `S9d-C5__schedule-card__chat_thread__pending__expired__dark` |
| `C3__run-page-configured__light.png` | `eb796975fa197e99b7b40b76096d407bf71fad18148973ce5007b499e00bcf1a` | record `S9d-C3__schedule-card__run_card__decided` |
| `C3__run-page-configured__dark.png` | `5c40280524311292cd08a35a792cd2706c2ba1bcf4596ce567fbbf729c96f3d1` | record `S9d-C3__schedule-card__run_card__decided__dark` |
| `C6__chat-ran__light.png` | `061057980105cd7987bc6d6353954ae0322eb4728cbab5915b94d03c86fb24fc` | record `S9d-C6__schedule-card__chat_thread__decided__after-fire` |
| `C6__chat-ran__dark.png` | `f6d490078f923d361278c9761e112c934fbe11f8f507ca0679e6ecde2e1209de` | record `S9d-C6__schedule-card__chat_thread__decided__after-fire__dark` |
| `C7__run-setup-scheduling-step__light.png` | `d1a21a6ba61245c74ee16c317da3645700f5728d7f89465146af84d1b6b98b46` | page control (light) — no index record |
| `C7__run-setup-scheduling-step__dark.png` | `4765eff1216e9d314bf13394fb6d726e803f548017112d052c6041791a626686` | page control (dark) — no index record |
| `C8__run-detail-after-fire__light.png` | `55e772fcb20ae68b117dd0ce674cc525ab1c87a270e20cf878dd94d78c4b8c58` | page control (light) — no index record |
| `C8__run-detail-after-fire__dark.png` | `d38d4360d6784bf158c1f326024a2891d060eed491ac99eff77370615b2e2c30` | page control (dark) — no index record |

The two round 2's **C3** records were deleted from
`scripts/ci/chat-hitl-capture-index.json` (56 records → 54) together with their
two images: they photograph the rejected composition, and a record that
describes pixels the product no longer draws is worse than no record. Nothing
was edited in place and no record was hand-written — the index is
recorder-measured only, and the next walk writes the new ones.

C1/C2 keep their round 2 records for now. The next walk **re-shoots** them,
because the stated schedule is now a ONE-OFF (the "ran" stage is the card after a
one-off has fired), so their pictures will change even though their cell names do
not.

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

## What the environment forced, said plainly

Two things in this round are not what the walk plan's note describes, and both
are environment limits rather than product findings. They are stated here, in
`PLAN-WALK.md`'s verdicts and in `TIMELINE.md` rather than left for a reader to
notice.

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
   only photographing it. Its one visible consequence is the line C2 and C6 draw
   above the rows — the shipped `SUPERSEDED_SCHEDULE_COPY`, "This card was
   adjusted before it was set — open the run to see the schedule that was set."
   It is reported as a deviation against C2's plan sentence rather than papered
   over.

**The agent's own execution used the REAL model.** That half needs no public
ingress: the agent runtime calls back into the shipped `/api/llm-bridge`, which
resolves the instance's own sealed `openai_connection` row. The row was written
before the walk through the shipped writer the setup wizard uses, from a
credential held only in the process environment — never printed, never logged,
never written to any file produced here, never committed.

**Nothing pressed *Run now*.** The one-off fired on the shipped delayed job at
`released_at 2026-08-23 21:22:00.163+00`, 163 ms after the second the person
stated and seventeen minutes after the row was written.

## Red first

`RED-FIRST.md` carries round 3's table: the four DOM facts of the reworked
composition, and the run-detail predicates, were written before the component was
touched and failed against `2ba505904` for the stated reasons.

## What is still owed on this round

- Nothing on the cells: all fourteen pictures are taken, graded and filed. The
  index holds ten new records (C1/C2/C5 replaced in place, C3 new); C7 and C8 are
  page controls with no record, by the reasoning above.
- C4 stays dropped. See `TIMELINE.md`.
- The maintainer's answer on whether the page-control filing is the one they
  want for C7 / C8 is still the open question. It is a shape this round proposes:
  a measured sidecar with no record and no gate behind it. The alternatives are
  to widen the record contract so a card-less screen can hold one, or to accept
  that these two stages are photographed but not indexed.
- Three cells FAIL a clause and are reported that way rather than softened: C2
  ("shows the schedule as it stands" — the card draws the shipped supersede line
  instead), C6 ("Save changes no longer offered" — the control is drawn, disabled)
  and C7 (the named drawing's two-column frame — the setup wizard's page has
  neither column). None of the three is a regression this PR introduces; each is
  a standing gap between a sentence and the shipped screen.

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
