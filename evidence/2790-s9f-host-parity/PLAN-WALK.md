# cinatra#2790 (S9f) — the plan walk, cell by cell

Every cell this lane presents, with the EXACT plan sentences that govern the
surface and the state it shows. The quotes are copied character-for-character
from the ratified plan page `PLAN: Agents Lifecycle` in the engineering wiki;
each one is an exact substring of that page and can be grepped against it.

Read it as a contract: a cell that shows something no quoted sentence sanctions
does not belong here, and a sentence that sanctions something the cell does not
show is a quote that should not have been used.


CELL: R1__recommendation-card__page_gate_region__decided
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> `LIFECYCLE_CARD_HOSTS` (:390-395) — `chat_thread`, `site_widget`, `run_card`, `page_gate_region`. In this page's words: the chat, the widget, the run page, the review page.

CELL: R2__recommendation-card__page_gate_region__decided__above-gate
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **No mount on the review page.**
PLAN> **You decide** on the card: **Approve** or **Reject** (a note is optional on approve and expected on reject) settles it once and for all.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.

CELL: R3__recommendation-card__page_gate_region__decided__dark
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> `LIFECYCLE_CARD_HOSTS` (:390-395) — `chat_thread`, `site_widget`, `run_card`, `page_gate_region`. In this page's words: the chat, the widget, the run page, the review page.

CELL: R4__recommendation-card__page_gate_region__decided__above-gate__dark
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **No mount on the review page.**
PLAN> **You decide** on the card: **Approve** or **Reject** (a note is optional on approve and expected on reject) settles it once and for all.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.

CELL: W1__recommendation-card__site_widget__held__column
PLAN> The card appears in the reply: **one chip per skill, each carrying its own Confirm, Adjust and Skip**. There is no heading plate and no single submit for the whole row. An agentic run progress card is not visible while the recommended skills can be selected, because they are being chosen before the agent actually runs.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.
PLAN> Recommendation and schedule decisions are not widget-operable at this commit — the recommendation card refuses credential-declaring hosts, and the schedule card's actions have no UI caller anywhere.

CELL: W2__recommendation-card__site_widget__held__column__dark
PLAN> The card appears in the reply: **one chip per skill, each carrying its own Confirm, Adjust and Skip**. There is no heading plate and no single submit for the whole row. An agentic run progress card is not visible while the recommended skills can be selected, because they are being chosen before the agent actually runs.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.
PLAN> Recommendation and schedule decisions are not widget-operable at this commit — the recommendation card refuses credential-declaring hosts, and the schedule card's actions have no UI caller anywhere.

CELL: W3__recommendation-card__site_widget__settled__column
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **Decisions ride the widget's own proof.** The decide route selects the widget branch from the presented `cwu_` header with **no** session fallback, so a decision from a widget frame can never be recorded against whoever else is signed in on that browser (`src/app/api/lifecycle-views/decide/route.ts:176-194`).
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.

CELL: H1__recommendation-card__site_widget__held
PLAN> The turn carries a **chip-row**: **one chip per skill, each with its own Confirm, Adjust and Skip**, so the reader shapes the run before it runs.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.

CELL: H2__recommendation-card__site_widget__held__dark
PLAN> The turn carries a **chip-row**: **one chip per skill, each with its own Confirm, Adjust and Skip**, so the reader shapes the run before it runs.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.

CELL: H3__recommendation-card__site_widget__held__mid-decision
PLAN> Per skill: **Confirm** takes it as offered; **Adjust** changes it; **Skip** leaves it out.
PLAN> The turn carries a **chip-row**: **one chip per skill, each with its own Confirm, Adjust and Skip**, so the reader shapes the run before it runs.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.

CELL: H4__recommendation-card__site_widget__settled
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **Decisions ride the widget's own proof.** The decide route selects the widget branch from the presented `cwu_` header with **no** session fallback, so a decision from a widget frame can never be recorded against whoever else is signed in on that browser (`src/app/api/lifecycle-views/decide/route.ts:176-194`).

CELL: S3__review-card__chat_thread__pending
PLAN> **It appears** when a run reaches a review gate — in the conversation where the run lives, and on the run page.
PLAN> **You decide** on the card: **Approve** or **Reject** (a note is optional on approve and expected on reject) settles it once and for all.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.

CELL: S3__review-card__chat_thread__pending__dark
PLAN> **It appears** when a run reaches a review gate — in the conversation where the run lives, and on the run page.
PLAN> **You decide** on the card: **Approve** or **Reject** (a note is optional on approve and expected on reject) settles it once and for all.
PLAN> Everyone who looks at that run — in the chat, in the widget, on the run page, on the review page — sees the same card.
PLAN> `LIFECYCLE_CARD_HOSTS` (:390-395) — `chat_thread`, `site_widget`, `run_card`, `page_gate_region`. In this page's words: the chat, the widget, the run page, the review page.

CELL: S4__recommendation-card__page_gate_region__decided
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **No mount on the review page.**
PLAN> **You decide** on the card: **Approve** or **Reject** (a note is optional on approve and expected on reject) settles it once and for all.

CELL: S4__recommendation-card__page_gate_region__decided__dark
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Everyone who looks at that run — in the chat, in the widget, on the run page, on the review page — sees the same card.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> `LIFECYCLE_CARD_HOSTS` (:390-395) — `chat_thread`, `site_widget`, `run_card`, `page_gate_region`. In this page's words: the chat, the widget, the run page, the review page.



## The REWORK proof set — DELIVERED (cinatra#2890)

The four chat cells this lane first shot are WITHDRAWN and their records are
gone from the capture index: they showed an agentic run progress card in the
turn while the recommended skills could still be chosen, and a skills button row
inside the run card after they were decided. Both readings are ruled out by the
plan. What replaces them is ONE real run, photographed in a full browser window,
light and dark, every cell recorder-measured — and the same run is photographed
on the RUN PAGE in both states beside it.

The run-page pair is numbered R5/R6 rather than R1/R2 because R1-R4 in this lane
are already the REVIEW-PAGE cells; the host token in each name (`run_card`) says
which surface it is.

Every `DRAWING-CHECK>` below was written by VIEWING the picture and comparing it
to the plan sentence and the named drawing.

**The R6 pair is a RE-SHOOT.** When this set was first filed, R6 failed on the
one thing it exists to show: the moment the question was decided the
recommendation's rail entry — and with it the whole two-column frame — stopped
being drawn. `64c0b1412` fixes that (`recommendationRailEntry` answers whether the
entry EXISTS separately from who draws the card), and R6 is re-shot on that code,
on its own real run, by `drivers/11-r6-settled-rail-sequence.mjs`. **Only R6 is
re-shot**: S1, S2 and R5 are the cells recorded before, unchanged, with their
records untouched. The R6 entries below are graded from the NEW pixels.

CELL: S1__recommendation-card__chat_thread__held
PLAN> You ask the assistant, in the chat or the widget, to run an agent that has recommended skills.
PLAN> The card appears in the reply: **one chip per skill, each carrying its own Confirm, Adjust and Skip**. There is no heading plate and no single submit for the whole row. An agentic run progress card is not visible while the recommended skills can be selected, because they are being chosen before the agent actually runs.
PLAN> The run is parked and does nothing at all until you act.
DRAWING> design-recommendation-card.png
DRAWING-CHECK> requires: the assistant's reply carries the chip row and NOTHING else that belongs to a started run — one chip per skill with its own Confirm / Adjust / Skip, no heading plate, no row-level submit, and no agentic run progress card anywhere in the turn / shows: the whole chat window; the person's own turn at the top, then the assistant's reply carrying FOUR chips — Blog Writing Skill, Blog Post Matcher Skill, Brand Voice Matcher Skill, Web Research Skill — each with its own Confirm, Adjust and Skip and no other control; no heading plate above them, no submit below them; the only thing under the row is the reply's sentence "The run paused for a decision on the recommended skills"; NO agentic run progress card anywhere in the turn (the record's frame count for `[data-inline-run-card]` reads 0), and the run's representation / produced-outbox / review-gate row counts all read 0 in the database at the instant of the shutter / verdict: PASS

CELL: S1__recommendation-card__chat_thread__held__dark
PLAN> The card appears in the reply: **one chip per skill, each carrying its own Confirm, Adjust and Skip**. There is no heading plate and no single submit for the whole row. An agentic run progress card is not visible while the recommended skills can be selected, because they are being chosen before the agent actually runs.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
DRAWING> design-recommendation-card.png
DRAWING-CHECK> requires: the same window and the same held turn in the dark palette — chip row present, no run progress card / shows: the identical window on the dark ground; the same four chips with the same three controls each, legible against the dark surface; no heading plate, no row-level submit, no run progress card / verdict: PASS

CELL: S2__recommendation-card__chat_thread__decided
PLAN> Per skill: **Confirm** takes it as offered; **Adjust** changes it; **Skip** leaves it out.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
DRAWING> design-recommendation-card.png
DRAWING-CHECK> requires: the settled chips in the same reply, each stating its own outcome with nothing left to press, and the agentic run progress card BELOW them — with no skills button row and nothing selectable inside it / shows: the same conversation, the same reply slot; the row has SETTLED IN PLACE and each chip now states its own outcome — Blog Post Matcher Skill ADJUSTED, Blog Writing Skill CONFIRMED, Web Research Skill CONFIRMED — with no Confirm / Adjust / Skip left on any of them (the record's root-scoped counts for all three `[data-skill-action]` selectors read 0); the Agentic Run Progress card is drawn BELOW the settled row, carrying the run's own in-flight Draft Context gate and its Continue, and NO skills button row inside it (`[data-hitl-skill-picker]` reads 0) / verdict: PASS — with one reading stated rather than glossed: the SKIPPED skill (Brand Voice Matcher) is not drawn in the settled row at all, so the settled row shows what was KEPT rather than every decision taken. That is this branch's settled reading, and the plan sentence ("showing what you chose") admits it; a reader who wants the skip on screen would not find it here.

CELL: S2__recommendation-card__chat_thread__decided__dark
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
DRAWING> design-recommendation-card.png
DRAWING-CHECK> requires: the same settled turn in the dark palette — settled chips above, run progress card below, no skills button row inside it / shows: the identical window on the dark ground; the same three settled chips with their outcome words, the Agentic Run Progress card below them with the Draft Context gate and Continue, and no skills button row inside it / verdict: PASS

CELL: R5__recommendation-card__run_card__held
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> The run is parked and does nothing at all until you act.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the run page for the same run while the recommendation is held — the two-column frame, the step rail naming the run's ordered steps on the left, and the recommendation read in the run detail on the right under that same rail, never as a standalone document, with nothing inline under the rail row and no run progress beside it / shows: the run page for the SAME run id; the two-column frame is drawn (`[data-conformance-id="run-surface"]` with exactly two children); on the LEFT the rail carries `① Recommendation` at the trigger position, the numeral in the filled circle, the title highlighted as the open step; on the RIGHT the four chips stand in the run detail, each with its own Confirm / Adjust / Skip; the chip row is a descendant of the run-detail column and NOT of the rail column and NOT of the rail row (measured: `chipRowInDetailColumn: true`, `chipRowInRailColumn: false`, `chipRowInsideRailRow: false`); there is no "Agentic Run Progress" section anywhere on the screen (heading count 0) / verdict: PASS on the trigger position, the surface placement and the absent progress — with one shortfall stated: the rail here carries ONLY the gate row. `screenDrawsPageRail` returns false whenever `rail.entries` is empty (`instance-screens.tsx:239`), and a run that has not executed has none — so the gate step renders the frame by itself and "ahead of the steps it would authorize" is shown as a position without the steps it precedes.

CELL: R5__recommendation-card__run_card__held__dark
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the same run page and the same held state in the dark palette / shows: the identical two-column framing on the dark ground — `① Recommendation` on the left, the four undecided chips in the run detail on the right, no progress section; the same measured containment (`chipRowInDetailColumn: true`) / verdict: PASS, with the same rail shortfall as the light cell

CELL: R6__recommendation-card__run_card__decided
SECTION> plan (A) §6.2 step 3 · §6.4 step 4 · §6.2's run-page bullet — the three sentences quoted next, in that order. Each PLAN> line stays an exact substring of the plan page.
PLAN> You confirm (the run starts with your selection) or skip (the recommendation is recorded as skipped, nothing is selected, and the run proceeds with its default skill set). The card settles in place and shows what you chose. The agentic run progress card appears once the skills are decided; no skill inside it can be selected.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected. **End state: shaped and started, in the conversation you were already in.**
PLAN> On the run page the same row sits at the **trigger position**, the top entry on the step rail, ahead of the work steps it would authorize.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the drawing's own sentence for a settled gate — "A resolved gate stays on the rail as read-only history" — read on the run page after the decision: the `Recommendation` entry still on the rail, in the place it held while the question was live, drawn in its COMPLETED reading (the check in the circle in place of the numeral, the title unhighlighted because it is no longer the selected step); the run detail beside it showing the run's OWN panel rather than the gate's surface; the settled chips wherever this branch draws them; and nothing selectable inside the card / shows, MEASURED (every value below is a field of this cell's own record in `capture-records-r6.json`): the run page for run `b632737c-a18c-4c3a-acbf-1aa6c60af623` (`finalUrl`) — the run whose skills were decided chip by chip in the chat, which this record does NOT measure and does not claim to: the presses are in `logs/r6-sequence.txt`, the three selection rows they wrote are in `logs/r6-db-readback.txt`, and that log also carries the server's own binding of that run to its typed turn. The two-column frame is drawn AND it is `RunSurfaceRail`'s own: `surfacePresent: true`, `surfaceChildren: 2`, and both instrumented columns count 1 (`run-step-rail-column`, `run-detail-column`) where the withdrawn R6 measured both 0. The rail's ordered rows are `railRowLabels: ["Recommendation", "Step 1"]` — the settled gate entry FIRST, ahead of the run's own work step. `railStepSettled: "true"`, `railStepSelected: "false"`, `railStepText: "Recommendation"`; the indicator's own text is EMPTY and it holds an `svg` (`railStepIndicatorText: ""`, `railStepIndicatorHasCheckGlyph: true`) — a check where a numeral would be. Three chips, all settled, none with any action left: `[data-skill-action="confirm"|"adjust"|"skip"]` all count 0 inside the card root, and each chip's `actions` array is empty. The chip row is a descendant of the run-detail column and NOT of the rail column and NOT of the rail row (`chipRowInDetailColumn: true`, `chipRowInRailColumn: false`, `chipRowInsideRailRow: false`), and one `Agentic Run Progress` heading is on screen. / and READ OFF THE PIXELS (looked at, not measured — these clauses are a person's reading of the image, and they are labelled so nobody mistakes them for record fields): the `Recommendation` title is drawn at the SAME weight as `Step 1` beside it, so the settled row reads as history rather than as the open step; the run detail is the run's own `Agentic Run Progress` card carrying a `failed` pill, and the three settled chips — `Blog Post Matcher Skill ADJUSTED`, `Blog Writing Skill ✓ CONFIRMED`, `Web Research Skill ✓ CONFIRMED` — are drawn INSIDE that card, above the run's own `Error` block and its `Retry` / `Start new run`. / verdict: PASS — with two readings stated rather than glossed. (a) The settled chips sit inside the Agentic Run Progress card rather than above it; the plan sentence puts the settled row and the progress card together without ordering them, so this is where this branch draws them and the picture says so plainly. (b) The SKIPPED skill (Brand Voice Matcher) is not drawn in the settled row at all — three chips for four decisions — the same settled reading S2 records in the chat. One cross-cell comparison is also named as one: "the place it held while the question was live" is R5's own record, which measured `① Recommendation` at the trigger position on the same surface.

CELL: R6__recommendation-card__run_card__decided__dark
SECTION> plan (A) §6.4 step 4 · §6.2's run-page bullet — the two sentences quoted next, in that order.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> On the run page the same row sits at the **trigger position**, the top entry on the step rail, ahead of the work steps it would authorize.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the same decided run page in the dark palette — the settled `Recommendation` entry still on the rail with its check, the run's own panel in the run detail beside it, the settled chips with nothing left to press / shows, MEASURED: the same run, the same shutter contract (1440x1700 at deviceScaleFactor 2, `framing: "window"`), and a record whose `runSurface` block is field-for-field the light cell's — `railRowLabels: ["Recommendation", "Step 1"]`, `railStepSettled: "true"`, `railStepSelected: "false"`, `railStepIndicatorHasCheckGlyph: true`, both instrumented columns at 1, `chipRowInDetailColumn: true`, three chips with empty `actions`, all three `[data-skill-action]` counts 0 inside the card root. `themeClass` carries `dark`. / and READ OFF THE PIXELS: `✓ Recommendation` above `✓ Step 1` on the left, both legible on the dark ground; the `Agentic Run Progress` card on the right with its `failed` pill; the same three chips reading `ADJUSTED` / `CONFIRMED` / `CONFIRMED`; the run's `Error` block and `Retry` / `Start new run` below them / verdict: PASS, with the same two stated readings as the light cell

## What R6 now shows, and the one shortfall that stands

**R6 (both palettes) draws the recommendation's settled rail entry.** The
withdrawn pair did not: on this agent's branch the run panel inside the run
detail hosts the recommendation card once the run has started
(`screenHostsRecommendationCard` is false for the `agentic` panel), and the screen
used to contribute a rail step only where the SCREEN hosts that card — so at the
moment the question was decided the `Recommendation` row stopped being drawn and
`RunSurfaceRail` stopped being rendered with it. `64c0b1412` separates the two
questions: `recommendationRailEntry` answers whether the entry EXISTS and how it
READS, and the screen's own host gate keeps answering only what SURFACE the step
opens (a settled entry opens none — the decided summary it stands for is already
inside the panel). The pictures are where that is read: the entry is on the rail,
first, with its check, and both of `RunSurfaceRail`'s instrumented columns are
present.

**The R5 shortfall stands and is not re-shot.** While the run is still held the
rail carries ONLY the gate row, because a run that has not executed contributes no
step entries of its own — so R5 shows "ahead of the steps it would authorize" as a
position without the steps it precedes. R6 is where that reading completes: on the
decided page the rail reads `Recommendation`, `Step 1`, and the gate entry is
visibly ahead of the work step.

The run's own downstream failure (artifact materialization — the run declared a
blog-post artifact whose `titleFrom` output did not resolve) is NOT a FAIL of this
cell. It happens after every state R6 shows, it is a lane fact rather than a
statement about this branch, and `RUN-READBACK.md` reads it out of the database
beside the rest.
