# PLAN WALK — cinatra#2904, the settled gate on the review page

Every capture on this branch, against the text that governs it. One document
governs here: the engineering wiki page `PLAN: Agents Lifecycle`, sections 4.2
("How it should look"), 4.4 ("Interactions, in sequence") and 9. Each `PLAN>`
line below is copied verbatim from that page. No line is paraphrased, and none is
stitched together from two places.

---

CELL: P1__review-card__page_gate_region__pending

The control, and the "before" of the whole round. A gate this lane produced
through the shipped path, drawn PENDING on the review page's gate region with its
live decision floor and the prompt window at the foot.

PLAN> - **Review states:** loading, restricted (drawn in full, terminal affordances disabled, reason on screen), no longer open (with a refresh), and absent.

Shows: the one card under `data-lifecycle-card-host="page_gate_region"` — the
"Review requested" header with its "Awaiting your decision" pill, the pinned
target ("Pricing page revision note", the Floor treatment with its metadata read),
the "Decision rationale (optional on approve, expected on reject)" field, and the
Comment / Reject / Approve floor. The run-step rail sits to its left and the
"Ask Cinatra to suggest edits to the fields above…" prompt window at the foot.
`[data-conformance-id="review-gate-settled"]` and `[data-review-outcome]` were
each measured **0** times inside the card root.

Verdict: **PASS**, and it is the reference the decided cells are read against:
the pending composition did not move.

---

CELL: P2__review-card__page_gate_region__decided

**The reading under test.** The same gate class, approved by a real press of the
card's own Approve control in the browser, and then RELOADED so the review page's
own server loader ran again on a gate it found RESOLVED.

PLAN> Everyone looking at that run, in any channel, sees the same settled card, and reopening the conversation later shows it again.
PLAN> In the target state the settled card names the outcome and the decider itself, and the Refresh button disappears with the ambiguity that required it.
PLAN> - **Approve** → the buttons are replaced in place by *"Approved. The gate is resolved and the run has been released to continue."* **End state: approved — the run carries on.**

Shows: one card root on `page_gate_region`, its state attribute reading
`settled`, and inside it the settled panel — the green double-check over
**Approved by Dana Reviewer** and the line "The gate is resolved and the run has
been released to continue." No decision bar, no Refresh, no blocked panel, and no
prompt window at the foot. The decider is the person who actually pressed:
`artifact_review_gates.resolved_by` on this row is that account, and the lane's
own read-back names it.

Verdict: **PASS**. Against `origin/main@269ceb194` this same URL renders the grey
"This review is no longer open" panel and no card DOM at all — the loader returns
`{kind:"blocked", reason:"no-longer-pending"}` before `ReviewGateCard` is mounted.

---

CELL: P3__review-card__page_gate_region__decided__dark

The same approved gate, opened fresh in a new browser context on the dark ground.
No decision is taken here — the gate was already resolved by the press in P2.

PLAN> Everyone looking at that run, in any channel, sees the same settled card, and reopening the conversation later shows it again.

Shows: the identical reading on the dark ground — the same panel, the same
outcome word and decider, the same sentence, the tint of the success token
resolving to the dark palette. The record carries the class the document actually
resolved (`… dark`), so the cell name is not the only thing claiming this is dark.

Verdict: **PASS**.

---

CELL: P4__review-card__page_gate_region__decided__rejected

A SECOND real gate, on its own run, REJECTED by a real press of the card's own
Reject control, then reloaded.

PLAN> - **Reject** → *"Rejected. The gate is resolved and the reviewed work has been turned back."* The rejected version is kept as history, never deleted. **End state: rejected.**
PLAN> **The design's rule stands as ratified:** *every card appears in every one of the four channels* (design §IX, "Yes" in all sixteen cells) — same card, same states, same data, and the same actions its reader is authorized to take.

Shows: the same settled panel taking the destructive treatment — the ringed ×
over **Rejected by Dana Reviewer** and "The gate is resolved and the reviewed work
has been turned back." `data-review-outcome="rejected"` inside the pinned root;
no decision bar, no Refresh.

Verdict: **PASS**. The outcome word is read off the recorded disposition
(`reject` on this gate row), never guessed: a disposition this build cannot map
attaches no outcome and the card falls back to the generic panel.

---

CELL: P5__review-card__page_gate_region__decided__rejected__dark

The rejected gate on the dark ground, opened fresh.

PLAN> Everyone looking at that run, in any channel, sees the same settled card, and reopening the conversation later shows it again.

Shows: the identical rejected reading on the dark ground, document class `dark`,
and a different image hash from the light cell.

Verdict: **PASS**.

---

CELL: P6__review-page-blocked__unavailable

**The negative control.** The same run, a review task id no gate was ever emitted
for. The loader answers `unavailable`, and the page keeps the generic blocked
panel — which is the reading the plan gives a card that cannot say what happened.

PLAN> - **If you may not see the run, no card is drawn at all** — no panel, no placeholder, no reason.
PLAN> What holds a card back is the **reader**, not the channel: may view and act → the card whole with live actions; may view, not act → the card whole with those actions disabled and the reason on screen; may not read the target → no card at all.

Shows: the grey panel — the ringed ×, "This review is no longer open", "The gate
was already decided or the run moved on." and **Refresh** — and no card anywhere.
Measured on the screen: `[data-lifecycle-card="artifact_review_gate"]` **0**,
`[data-lifecycle-card-host="page_gate_region"]` **0**,
`[data-conformance-id="review-gate-settled"]` **0**, `[data-review-outcome]` **0**,
`[data-conformance-id="review-gate-blocked"]` **1**,
`[data-action="refresh-gate -> live-gate"]` **1**.

Verdict: **PASS**, and it is the half of this change that had to NOT move: an
unavailable gate must never become settled-card DOM.

---

CELL: P7__review-page-blocked__unavailable__dark

The same negative control on the dark ground.

PLAN> - **If you may not see the run, no card is drawn at all** — no panel, no placeholder, no reason.

Shows: the identical blocked panel on the dark ground, with the same six counts,
and still no card DOM.

Verdict: **PASS**.

---

## What is NOT walked here, and why

- **The other three channels.** The settled card in the chat transcript, the run
  card and the widget are not re-photographed on this branch and are not claimed:
  they already draw the settled reading (cinatra#2855, evidence/2855-settled-outcome
  A3–A5) and nothing in this change touches them. What this branch changes is the
  one host that could not reach the card at all.
- **A resolved gate whose outcome cannot be read.** The plan's own "no longer
  open" reading still stands for it, and the card already falls back to it — but
  no honest lane state produces it here: every gate this lane resolved carries a
  disposition the build maps. It is exercised where it can be driven truthfully,
  in `packages/agents/src/__tests__/review-gate-card.envelope-parity.test.tsx`
  (`*/settled`, the outcome-less entry) rather than staged on a screen.
- **A reader with no run access.** Unchanged by this branch, and covered by the
  page suite (`__tests__/page.settled-gate.test.tsx`) and by the loader's own
  real-store integration test, which now also asserts it for a RESOLVED gate.
