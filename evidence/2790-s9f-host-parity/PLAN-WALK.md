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


## The NEW proof set — OWED (cinatra#2890 rework)

The four chat cells this lane first shot are WITHDRAWN, and their records are
deleted from the capture index: they show an agentic run progress card in the
turn while the recommended skills could still be chosen, and a skills button row
inside the run card after they were decided. Both readings are ruled out by the
plan. What replaces them is one real run, photographed in a full browser window,
light and dark, every cell recorder-measured — no record here is hand-written,
and none of these pictures exists yet.

The run-page pair is numbered R5/R6 rather than R1/R2 because R1-R4 in this lane
are already the REVIEW-PAGE cells; the host token in each name says which surface
it is.

CELL: S1__recommendation-card__chat_thread__held
PLAN> You ask the assistant, in the chat or the widget, to run an agent that has recommended skills.
PLAN> The card appears in the reply: **one chip per skill, each carrying its own Confirm, Adjust and Skip**. There is no heading plate and no single submit for the whole row. An agentic run progress card is not visible while the recommended skills can be selected, because they are being chosen before the agent actually runs.
PLAN> The run is parked and does nothing at all until you act.
DRAWING> design-recommendation-card.png
DRAWING-CHECK> requires: the assistant's reply carries the chip row and NOTHING else that belongs to a started run — one chip per skill with its own Confirm / Adjust / Skip, no heading plate, no row-level submit, and no agentic run progress card anywhere in the turn / shows: (capture pending) / verdict: owed (capture pending)

CELL: S1__recommendation-card__chat_thread__held__dark
PLAN> The card appears in the reply: **one chip per skill, each carrying its own Confirm, Adjust and Skip**. There is no heading plate and no single submit for the whole row. An agentic run progress card is not visible while the recommended skills can be selected, because they are being chosen before the agent actually runs.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
DRAWING> design-recommendation-card.png
DRAWING-CHECK> requires: the same window and the same held turn in the dark palette — chip row present, no run progress card / shows: (capture pending) / verdict: owed (capture pending)

CELL: S2__recommendation-card__chat_thread__decided
PLAN> Per skill: **Confirm** takes it as offered; **Adjust** changes it; **Skip** leaves it out.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
DRAWING> design-recommendation-card.png
DRAWING-CHECK> requires: the settled chips in the same reply, each stating its own outcome with nothing left to press, and the agentic run progress card BELOW them — with no skills button row and nothing selectable inside it / shows: (capture pending) / verdict: owed (capture pending)

CELL: S2__recommendation-card__chat_thread__decided__dark
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
DRAWING> design-recommendation-card.png
DRAWING-CHECK> requires: the same settled turn in the dark palette — settled chips above, run progress card below, no skills button row inside it / shows: (capture pending) / verdict: owed (capture pending)

CELL: R5__recommendation-card__run_card__held
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> The run is parked and does nothing at all until you act.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the run page for the same run while the recommendation is held — the two-column frame, the step rail naming the run's ordered steps on the left, and the recommendation read in the run detail on the right under that same rail, never as a standalone document / shows: (capture pending) / verdict: owed (capture pending)

CELL: R5__recommendation-card__run_card__held__dark
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the same run page and the same held state in the dark palette / shows: (capture pending) / verdict: owed (capture pending)

CELL: R6__recommendation-card__run_card__decided
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the run page after the decision — the settled chips in place, the run's own progress in the run detail under the same rail, and NO skills button row inside that card / shows: (capture pending) / verdict: owed (capture pending)

CELL: R6__recommendation-card__run_card__decided__dark
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the agentic run progress card appears; no skill inside it can be selected.
DRAWING> design-run-surface-rail-and-gate.png
DRAWING-CHECK> requires: the same decided run page in the dark palette — settled chips, no skills button row inside the card / shows: (capture pending) / verdict: owed (capture pending)
