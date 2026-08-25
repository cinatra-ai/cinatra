# PLAN WALK — cinatra#2931 W4, the card includes the artifact's renderer

Every capture this slice took, against the text that governs it. Each `PLAN>`
line is copied **verbatim** from the engineering wiki page
`PLAN: Agents Lifecycle (B)` (§5 and §6). No line is paraphrased and none is
stitched together from two places.

Each `Shows:` was written by **looking at the picture**, and each `Verdict:` is
read off those pixels — never from the diff, never from the test results, never
from this document. Two cells are refusals, and they say so.

---

CELL: W1__review-card__chat_thread__pending

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.
PLAN> - The "no renderer resolved" face, its field table and its Preview and Download links are gone from the card.

Shows: the card in the conversation, headed `Review requested` / `Awaiting your
decision`. The target header names the draft and its `Blog Post Artifact` chip;
the mono line carries the type, `revision 465f4db3-c75…`, `pinned`,
`text/markdown` and the updated time. Beneath it the target renders in the two
columns the host's own markdown renderer draws (`RENDERED` / `RAW SOURCE`) with
the draft's text in both. Above the reviewed work there is **nothing** — no
provenance chip row. Nowhere on the card is there the sentence "No type renderer
resolved", a `type / mime / revision` table, or a Preview or Download link. The
decision floor beneath reads `DECISION RATIONALE`, `Comment`, `Reject`,
`Approve`. Counted on this screen: 1 card root, 1 review target, 0 provenance
regions, 0 floor diagnostics.

Verdict: PASS.

---

CELL: W2__review-card__chat_thread__pending__dark

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.

Shows: the same card, same counts, on a near-black ground (the sampled top-bar
pixel is rgb(2, 6, 24)). The ground was changed by pressing the app's **own**
`Toggle theme` control, not by faking a media query. Nothing in the card's frame
moves between the two grounds.

Verdict: PASS.

---

CELL: W3__review-card__site_widget__pending

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.
PLAN> Inside a third-party application those links were dead ends that demanded a login which never exists there.

Shows: the card inside the embed on a page whose top-level document is served by
another site. `Review requested` / `Awaiting your decision`, the target header
and its pinned mono line, the target **rendered** through the host's own markdown
renderer, `Expand` in the frame footer, then `DECISION RATIONALE`, `Comment`,
`Reject`, `Approve`. There is no provenance chip row, no field table and no
Preview or Download link. **There is no login prompt anywhere in the frame.** The
island document request carried no cookie and no widget token (the driver's own
wire log), and the island's own recorder counted `body=1, empty=0, targets=1`.

Verdict: PASS. This is the cell the plan's sentence about dead-end links is
about, and it is the direct before/after against the same driver's C1 on `main`.

---

CELL: W4__review-card__site_widget__pending__expanded

PLAN> **One fix, all four places the work is shown.** That rung renders on the server, inside the card's own authenticated island, so it behaves the same in a conversation, on the review page, on the run page

Shows: the same third-party card after its island's own `Expand` was pressed —
the identical rendered target at the top of a taller frame, `Collapse` in the
frame footer, the decision floor unchanged.

Verdict: PASS.

---

CELL: W5__review-card__run_card__not-parked

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.

Shows: the run DETAIL page for the run that owns a pending gate. It draws the
run's terminal card and **no review card at all**. Counted on this screen: 0 card
roots, 0 review targets.

Verdict: **REFUSED — not captured as a pass.** The cause is upstream of this
slice: on this instance the review-orchestration sweep minted each gate **after**
its run had already terminated, so no run ever parked at a review moment and the
run detail has no card to draw. Which renderer the card would include is not in
question here — the card is not on that screen to include one. Filed as an open
block on the pull request.

---

CELL: W7__review-card__page_gate_region__pending

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.
PLAN> - The "no renderer resolved" face, its field table and its Preview and Download links are gone from the card.

Shows: the review page's gate region. `Review requested` / `Awaiting your
decision`, the target header `Why Small Teams Should Automate Weekly Status
Reports` with its `Blog Post Artifact` chip and its pinned mono line
(`revision d93bad0e-077…`, `pinned`, `text/markdown`). The target renders as
**prose**: `Weekly status reporting is a coordination problem`, then the
paragraph beneath it, beside the raw markdown in the second column. Nothing is
drawn above the reviewed work. `Expand` in the frame footer, then `DECISION
RATIONALE`, `Comment`, `Reject`, `Approve`, and the prompt window at the foot
reading `Ask Cinatra to suggest edits to the fields above…`. Counted: 1 card
root, 1 review target, 0 provenance regions, 0 floor diagnostics.

Verdict: PASS.

---

CELL: W8__review-card__page_gate_region__pending__dark

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.

Shows: the same gate region, same counts, on the dark ground (sampled corner
pixel rgb(5, 12, 30)), reached through the app's own `Toggle theme` control.

Verdict: PASS.

---

CELL: W9__artifact-page__detail__markdown

PLAN> **The defect is one missing rung on one surface.** The card decides which renderer to include by the same ladder the artifact page uses — the artifact extension's own renderer for its type first — minus the ladder's last rung, the first-party renderer for declared text forms such as markdown and plain text. So the same blog draft that renders on its own page shows "cannot render" under review. The fix restores that rung to the card, and the card then includes what the page includes.

Shows: the artifact's OWN page for the same artifact at the same pinned revision:
the title, `text/markdown · 6506 bytes`, a `Download` control in the page chrome,
and the identical `RENDERED` / `RAW SOURCE` pair with the same prose and the same
raw markdown the card shows in W7.

Verdict: PASS — the card includes what the page includes, read off two pictures
of the same revision.

---

CELL: W10__review-card__page_gate_region__decided

PLAN> - A markdown draft under review is rendered through its text rung on all four hosts — the chat, a third-party application with no login prompt, the run page, the review page — and is recorded as rendered, never as a fallback.

Shows: the same gate after **Approve** was actually pressed in the browser. The
card reads `Approved by Lane Reviewer` / `The gate is resolved and the run has
been released to continue.` The decision controls are gone. The audit row this
press committed reads `renderer_kind = first-party` (see `RUN-READBACK.md`).

Verdict: PASS — "recorded as rendered, never as a fallback" is settled by the
row, not by the screen alone.

---

CELL: W11__review-card__site_widget__refused

PLAN> Defensive states are different and they keep their own honest readings: a deleted or unreadable
PLAN> target, a display mid-upgrade, a runtime failure. Those are protections, not fallbacks.

Shows: the negative control the shipped island driver takes — one character of
the island credential flipped. The island region is blank (the single empty
answer every denial draws) and everything else is identical to W3: the card is
unmoved, no error, no crash, and **no sign-in form inside third-party chrome**.
The island's own recorder counted `body=0, empty=1`.

Verdict: PASS.

---

## The acceptance line this round does NOT answer

PLAN> - The floor gate runs and reports the count of artifact types whose review would land on the fallback; defensive states keep their own readings and never count as fallbacks.

No such gate exists in the tree, on this branch or on `main`, and this round did
not build one. It is named on the pull request as an open acceptance item rather
than left to be discovered.
