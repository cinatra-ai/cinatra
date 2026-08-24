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
to the plan sentence and the named drawing. Two cells FAIL, and the FAILs are
stated as FAILs.

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
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the run page after the decision — the recommendation's rail entry settled as the rail's own resolved-gate history row (the completed circle in place of the numeral, the title unhighlighted), the run detail returned to what the run page otherwise shows, the settled chips in place, and NO skills button row inside that card / shows: the run page for the same run; the settled chips ARE in place and nothing inside them can be pressed (root-scoped `[data-skill-action]` counts all 0), and the run detail IS restored — the Agentic Run Progress section is on screen with the run's own reading. BUT the recommendation's rail entry is GONE: the left column now carries the run's own `✓ Step 1` and no `Recommendation` row at all (measured: `railStepPresent: false`). The two columns ARE still there — `run-surface` is present with two children — but they are the SCREEN's own columns, not the gate frame's: `RunSurfaceRail` is not what draws them, so its instrumented `run-step-rail-column` / `run-detail-column` read absent. The settled chip row is drawn INSIDE the Agentic Run Progress card rather than above it. / verdict: FAIL on the settled rail entry — the plan's "the same row sits at the trigger position, the top entry on the step rail" and the rework's own settled reading are not what this branch draws once the run leaves `pending_input` on this agent's branch. The cause, read out of `packages/agents/src/instance-screens.tsx`: the screen adds the gate step only where the SCREEN hosts the card (`hasRecommendationStep = recommendationPark !== null && hostsRecommendationCard`, :789), and `screenHostsRecommendationCard` is false on the `agentic` panel branch (:176) — which is the branch a run takes the moment it leaves `pending_input`. From that moment the run panel inside the run detail hosts the card, the gate step is not contributed, and `RunSurfaceRail` is not rendered at all. PASS on the other three halves: settled chips present, nothing selectable inside the card, run detail restored.

CELL: R6__recommendation-card__run_card__decided__dark
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the same decided run page in the dark palette — settled chips, no skills button row inside the card / shows: the identical screen on the dark ground — `✓ Step 1` on the left, the Agentic Run Progress card on the right carrying the three settled chips with their outcome words and nothing pressable among them, and the run's own error reading below them; `railStepPresent: false` here too / verdict: FAIL on the settled rail entry, for the same reason as the light cell; PASS on the settled chips and on the absence of any skills button row inside the card

## What the two FAILs are, in one place

**R6 (both palettes) does not draw the recommendation's settled rail entry.** It
is one defect with one cause, and it is visible in the pictures rather than
inferred: on this agent's branch the run panel inside the run detail hosts the
recommendation card once the run has started (`screenHostsRecommendationCard`
is false for the `agentic` panel), and the screen only contributes a rail step
where the SCREEN hosts that card — so at the moment the question is decided the
`Recommendation` row stops being drawn and `RunSurfaceRail` stops being rendered.
The page still has two columns; they are the screen's own, and the gate's rail
entry is not among them. R5 proves the held half of the same sentence works; R6
shows the settled half does not survive the run starting.

The run's own downstream failure (artifact materialization) is NOT one of these
FAILs. It happens after every state these cells show, it is a lane fact rather
than a statement about this branch, and `RUN-READBACK.md` reads it out of the
database beside the rest.
