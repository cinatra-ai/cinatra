# PLAN WALK — cinatra#2970, cell C7

Every `PLAN>` line below is copied character-for-character from
`PLAN: Agents Lifecycle (A)` (the engineering wiki), at the line number given.
Every `CELL:` line names the picture that answers it, and `READING:` is what the
picture and the record beside it actually show — including where they do not
answer the sentence.

## §7.2 step 5 — the schedule step, and what may not be drawn with it

PLAN> (§7.2 step 5, line 667)
PLAN> 5. On the run page and the review page the schedule is a **dedicated step in the step rail on the left, above "1 Review"**: open that step to see the configuration or change it — it opens to the right of the steps, never directly under a step, and no agentic run progress card is shown with it. The schedule is never drawn as a card among the review cards — a trigger decides *when* the agent runs, and a review card exists only after the agent has run and produced something — so the two can never appear together.

CELL: C7 (light), C7 (dark)
READING: the setup run page is one two-column frame — one rail column, one detail
column (`railColumns: 1`, `detailColumns: 1` in capture-records.json). The schedule
step is the OPEN one (`data-run-surface-selected-step="schedule"`) and its form —
"When should this run?", the three option rows, Estimated run duration, Continue —
is drawn in the RIGHT column, never under a rail row. No agentic run progress panel
is on the screen (`agenticRunProgressPanels: 0`), and no lifecycle card is either
(`lifecycleCardHosts: 0`) — the run has not executed, so there is nothing to show.

## §7.4 step 7 — the same clause, in the interaction sequence

PLAN> (§7.4 step 7, line 718)
PLAN> 7. On the run page and the review page the schedule is a dedicated step in the step rail on the left, above **1 Review** — open it to see or change the configuration; it opens to the right of the steps, never directly under a step, and no agentic run progress card is shown with it. It is never a card among the review cards.

CELL: C7 (light), C7 (dark)
READING: as above. The rail carries three rows in order, numbered from one, and the
schedule is the first of them; the step opens to the RIGHT of the rows.

## §6.2 step 2 — no run progress while the recommendation is still open

PLAN> (§6.2 step 2, line 569)
PLAN> 2. The card appears in the reply. An agentic run progress card is not visible while the recommended skills can be selected, because they are being chosen before the agent actually runs.

CELL: C7 (light), C7 (dark)
READING: **the sentence's own state is NOT the state pictured, and the cell does not
claim it.** §6.2 step 2 describes the screen *while the recommended skills can be
selected*; on this run the recommendation step has not been reached at all, so
nothing about it is selectable and no recommendation card is on the screen
(`lifecycleCardHosts: 0`). What C7 does answer is the clause's consequence for the
setup page it IS of: nothing about the run's progress is drawn beside the setup
steps (`agenticRunProgressPanels: 0`) — the run has not started (`status:
pending_trigger`, `started_at: null` in the record's own `dbAt` block). The
recommendation card being drawn without run progress beside it is proved by the
S9f/V-series cells, not here.

## The ruling on this issue (the maintainer, 2026-08-25 — Option A)

RULING> A step the run has not reached cannot be selected. Its row stays on the rail,
RULING> muted; clicking it does nothing; the scheduler stays open; the right column
RULING> never shows an empty step surface.

CELL: C7 (light), C7 (dark), C7-click
READING: rows 2 and 3 carry `data-run-surface-rail-reached="false"`,
`aria-disabled="true"` and a `data-action` that names the state
(`recommendation-step-unavailable`, `review-step-unavailable`) instead of promising
an open; neither carries the native `disabled`, so both keep `tabIndex: 0` and stay
reachable by keyboard. Both were then PRESSED (C7-click). After both presses the
detail column's DOM is byte-identical to before them
(`clickProof.detailIdentical: true`, same SHA-256 digest), the selected step is
still `schedule`, and of the 13 pixels that differ between the two pictures — all of
them inside the product wordmark in the sidebar header — **0 are inside the run
surface**, measured against the run surface's own rectangle as the recorder read it
(`clickProof.pixelDiff`).

## The drawing — design `app-artifact-review.html` §I (the run surface)

DRAWING> A run is one page, read down a rail. ... The surface is a two-column frame:
DRAWING> a step rail down the left names the run's ordered steps, and the run detail
DRAWING> on the right shows the selected step.

CELL: C7 (light), C7 (dark)
READING: the frame conforms — rail left, detail right, the selected step open on the
right. **The rail does NOT name the steps.** Each row draws its numeral and an EMPTY
title (`<span class="text-sm font-medium …"></span>` in the server-rendered HTML;
each row's whole text content is "1", "2", "3"). The drawing's rail names its rows
("Recommendation", "Review", "Send sequence"), and this one does not. The defect and
its cause are in README.md under "What the pictures caught"; it is NOT fixed here.
