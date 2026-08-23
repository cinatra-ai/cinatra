# PLAN WALK — cinatra#2931 W4, the card includes the artifact's renderer

Every capture this slice owes, against the text that governs it. Two documents
govern here: the engineering wiki pages `PLAN: Agents Lifecycle (B)` §5 and §6,
and `PLAN: Agents Lifecycle (A)` §4 — the screen this slice extends and does not
redraw. Each `PLAN>` line below is copied verbatim from one of those pages. No
line is paraphrased and none is stitched together from two places.

**EVERY CELL BELOW IS `NOT CAPTURED`.** The code leg ran on a tests-only host
with no browser. A capture lane on a UI host fills each `Shows:` and `Verdict:`
by looking at the picture it took — never from the diff, never from the test
results, never from this document.

---

CELL: W1__review-card__chat_thread__pending

The defect's home. A markdown draft under review, in the conversation the run
lives in.

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.
PLAN> - **The target ladder:** build-time renderer, runtime renderer, metadata floor — the renderer decides, never the host. The floor is a display degrade, never a gate block.
PLAN> - **One card, one gate.** The card fills the assistant's turn: the target panel naming what is under review and pinning its exact revision, then the decision floor that governs it — both reproduced unchanged by the move into the conversation.

Shows: NOT CAPTURED
Verdict: NOT CAPTURED

---

CELL: W2__review-card__chat_thread__pending__dark

The same card on the dark ground, opened fresh. No decision is taken.

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.

Shows: NOT CAPTURED
Verdict: NOT CAPTURED

---

CELL: W3__review-card__site_widget__pending

The same draft inside a third-party page, through the embed. The login prompt is
the thing being disproved: there must be none anywhere in the frame.

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.
PLAN> - The "no renderer resolved" face, its field table and its Preview and Download links are gone from the card.

Shows: NOT CAPTURED
Verdict: NOT CAPTURED

---

CELL: W4__review-card__site_widget__pending__dark

The same, dark ground.

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.

Shows: NOT CAPTURED
Verdict: NOT CAPTURED

---

CELL: W5__review-card__run_card__pending

The same draft in the run page's card.

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.

Shows: NOT CAPTURED
Verdict: NOT CAPTURED

---

CELL: W6__review-card__run_card__pending__dark

The same, dark ground.

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.

Shows: NOT CAPTURED
Verdict: NOT CAPTURED

---

CELL: W7__review-card__page_gate_region__pending

The same draft in the review page's gate region, with its live decision floor.

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.
PLAN> - **One card, one gate.** The card fills the assistant's turn: the target panel naming what is under review and pinning its exact revision, then the decision floor that governs it — both reproduced unchanged by the move into the conversation.

Shows: NOT CAPTURED
Verdict: NOT CAPTURED

---

CELL: W8__review-card__page_gate_region__pending__dark

The same, dark ground.

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.

Shows: NOT CAPTURED
Verdict: NOT CAPTURED

---

CELL: W9__artifact-page__detail__markdown

The artifact page for the SAME artifact at the SAME pinned revision, beside the
cards above. This is the whole claim in one pair of pictures: the page and the
card show the same thing.

PLAN> - **The target ladder:** build-time renderer, runtime renderer, metadata floor — the renderer decides, never the host. The floor is a display degrade, never a gate block.

Shows: NOT CAPTURED
Verdict: NOT CAPTURED

---

CELL: W10__review-card__page_gate_region__no-renderer

The negative control. A target nothing renders — no package renderer, no declared
text form. The card still says so, and says nothing else: the field table and the
Preview / Download links are gone even here.

PLAN> - The "no renderer resolved" face, its field table and its Preview and Download links are gone from the card.
PLAN> - The floor gate runs and reports the count of artifact types whose review would land on the fallback; defensive states keep their own readings and never count as fallbacks.

Shows: NOT CAPTURED
Verdict: NOT CAPTURED

---

CELL: W11__review-card__page_gate_region__defensive

A defensive state — a pinned revision that is no longer live — keeps its own
honest reading and is not drawn as a fallback.

PLAN> - The floor gate runs and reports the count of artifact types whose review would land on the fallback; defensive states keep their own readings and never count as fallbacks.
PLAN> - **Review states:** loading, restricted (drawn in full, terminal affordances disabled, reason on screen), no longer open (with a refresh), and absent. **Restricted and absent are never drawn for each other:** a card you may not act on is drawn whole with the reason; a card you may not see has no DOM at all — no panel, no placeholder, no reason.

Shows: NOT CAPTURED
Verdict: NOT CAPTURED
