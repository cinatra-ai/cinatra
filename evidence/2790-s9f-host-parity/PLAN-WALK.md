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
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the run card underneath advances.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> `LIFECYCLE_CARD_HOSTS` (:390-395) — `chat_thread`, `site_widget`, `run_card`, `page_gate_region`. In this page's words: the chat, the widget, the run page, the review page.

CELL: R2__recommendation-card__page_gate_region__decided__above-gate
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the run card underneath advances.
PLAN> **No mount on the review page.**
PLAN> **You decide** on the card: **Approve** or **Reject** (a note is optional on approve and expected on reject) settles it once and for all.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.

CELL: R3__recommendation-card__page_gate_region__decided__dark
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the run card underneath advances.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> `LIFECYCLE_CARD_HOSTS` (:390-395) — `chat_thread`, `site_widget`, `run_card`, `page_gate_region`. In this page's words: the chat, the widget, the run page, the review page.

CELL: R4__recommendation-card__page_gate_region__decided__above-gate__dark
PLAN> The same row appears on the run page, ahead of the steps it would authorize, and on the review page, where it is mostly seen in its decided form.
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the run card underneath advances.
PLAN> **No mount on the review page.**
PLAN> **You decide** on the card: **Approve** or **Reject** (a note is optional on approve and expected on reject) settles it once and for all.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.

CELL: W1__recommendation-card__site_widget__held__column
PLAN> The reply says the run started and the card appears in that same reply: **one chip per skill, each carrying its own Confirm, Adjust and Skip**. There is no heading plate and no single submit for the whole row.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.
PLAN> Recommendation and schedule-proposal decisions are not widget-operable at this commit — the recommendation card refuses credential-declaring hosts, and the proposal actions have no UI caller anywhere.

CELL: W2__recommendation-card__site_widget__held__column__dark
PLAN> The reply says the run started and the card appears in that same reply: **one chip per skill, each carrying its own Confirm, Adjust and Skip**. There is no heading plate and no single submit for the whole row.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **The card is withheld from the widget** by the in-code credential guard, because its actions are not broker-aware yet.
PLAN> Recommendation and schedule-proposal decisions are not widget-operable at this commit — the recommendation card refuses credential-declaring hosts, and the proposal actions have no UI caller anywhere.

CELL: W3__recommendation-card__site_widget__settled__column
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the run card underneath advances.
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
PLAN> Once you have decided each one, the run starts with your selection, the card settles in place showing what you chose, and the run card underneath advances.
PLAN> **The row is the whole card** — there is no separate heading plate and no second gate-level submit.
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.
PLAN> **Decisions ride the widget's own proof.** The decide route selects the widget branch from the presented `cwu_` header with **no** session fallback, so a decision from a widget frame can never be recorded against whoever else is signed in on that browser (`src/app/api/lifecycle-views/decide/route.ts:176-194`).
