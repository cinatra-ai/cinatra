# RED-FIRST

## Round 3 — the reworked composition

Seventeen tests were written against the reworked contract BEFORE any of the
three components was touched, and every one of them failed against the branch
head `2ba505904` for the stated reason.

`packages/agents` — `Tests 14 failed (14)`:

| test | failed with |
|---|---|
| the schedule step's surface — the form is inside the run-detail column and NOT inside the rail column | `expected null not to be null` — nothing was drawn in the run detail; the form was under the rail row |
| the schedule step's surface — no agentic run progress beside it | same: the frame the assertion reads did not exist |
| the schedule step's surface — the run's own detail when another step is selected | same |
| the schedule step's surface — swaps on selection, never both at once | same |
| runHasExecutionRecord (4 cases) | `TypeError: runHasExecutionRecord is not a function` |
| runDetailOpensOnSchedule (4 cases) | `TypeError: runDetailOpensOnSchedule is not a function` |
| the screen hands the rail and the run detail to the step | `expected 'import { notFound, redirect } …' to match /rail=\{railNode\}/` |
| the run's panels are INSIDE the detail slot | `expected -1 to be greater than -1` — there was no detail slot |

The review page — `Tests 3 failed | 1 passed (4)`:

| test | failed with |
|---|---|
| opens on the review card, with the schedule step listed above it | `expected null not to be null` |
| selecting the schedule entry shows the form and not the review card | `expected null not to be null` |
| selecting the review entry brings the card back and takes the form away | `expected null not to be null` |
| a run with NO schedule keeps the rail inert | passed before and after — it is the invariance pin, not a new fact |

After the change all seventeen are green, and so are the suites they sit beside
(`schedule-proposal-card`, `instance-screens-single-step-rail`,
`instance-screens-recommendation-host`, `orchestrator-stepper-single-rail`,
`run-step-rail`, `schedule-card-host-mounts`, the review page's own four files).
Three pins that read the OLD composition out of source were re-aimed in the same
commit and are named in the PR body: the rail placement moved from
`review-run-steps.tsx` to the review page itself, the run screen's rail mount is
now a named node handed to the step, and both placements must pass the step its
two columns.

## Round 2 — the card's chrome (kept for the record)

Five tests were written against the reworked card contract before the component
was touched, and all five failed for the stated reason:

| test | failed with |
|---|---|
| NO summary box and NO held-steps block on either page host | the card drew `scheduled-run-chrome` |
| NO status label — the word Armed is drawn on no host | the card drew `schedule-armed-summary` |
| NO Open-the-run link on any host | the card drew `schedule-open-run` |
| the two controls are named Cancel schedule and Run now | expected "Cancel trigger" to contain "Cancel schedule" |
| the confirm dialogs say schedule, not trigger | expected the strip's "Cancel scheduled trigger?" to contain "Cancel this schedule?" |

`Tests  5 failed | 30 skipped (35)`, then `Tests  35 passed (35)`.

One mounts pin was red at `c555788` for a body field the card no longer draws
(`.triggerType`), and was aligned with the one-card gate's authorized body list
rather than the card being changed to satisfy it.
