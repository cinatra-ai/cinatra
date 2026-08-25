# PLAN WALK — cinatra#2972 / PR #2978

The two plan sentences this slice is implemented against, quoted VERBATIM from
`PLAN: Agents Lifecycle (A)` — section 7.2 item 4 and section 7.4 (as designed)
item 6 — and, under each, the cells that show the reading and the verdict from
looking at the pixels.

Every number quoted below is in `capture-records.json` (per cell) or
`readback/timeline.json` (per step); nothing here is asserted that is not
counted or read there.

---

## §7.2, step 4

PLAN> 4. The card stays in the conversation, showing the schedule in the same rows; change them and press **Save changes** to re-arm. **Cancel schedule** (a recurring schedule, after its first fire) is on the run page's schedule step; there is no Run now. You can change the schedule this way for as long as it has not fired; once a one-off has fired it cannot be changed, and a change to a recurring schedule applies to its future runs.

## §7.4 (as designed), step 6

PLAN> 6. From the card in the conversation, or from the schedule step on the run page or the review page: change the rows and press **Save changes** → **End state: re-armed.** From the schedule step of a recurring schedule that has fired once: **Cancel schedule** → **End state: stopped** (the scheduler then non-editable); otherwise it fires on its schedule → **End state: fired.** A one-off can be changed on either surface until it fires and not afterwards; a change to a recurring schedule applies to its future runs.

---

## The walk

### CELL: F1 — a one-off, after it fired, in the conversation
PLAN> once a one-off has fired it cannot be changed

**requires** — the card the person confirmed, in the conversation it was stated
in, after the schedule came due on its own: the same rows, read-only, and no
floor at all — no Save changes, no Cancel schedule, no Run now.
**shows** — `Schedule for later` chosen, `Run at` and `Timezone` greyed and
disabled, `Estimated run duration` closing the card, and nothing below it.
Counted on the card's own root: floor `0`, Save changes `0`, Cancel schedule
`0`, `[data-field="schedule-run-at"][disabled]` `1`; and `0`
`[data-action="release-trigger-now"]` on the whole screen. Gated on
`released_at 2026-08-25T15:58:00.056Z`.
**verdict** — CONFORMS, light and dark.

### CELL: F2 — the same fired one-off, on the run page's Schedule step
PLAN> **Cancel schedule** (a recurring schedule, after its first fire) is on the run page's schedule step; there is no Run now.

**requires** — the Schedule step opened on the run page shows the same form and
nothing else; for a FIRED ONE-OFF it carries no operation at all, and Run now is
gone from the surface.
**shows** — the rail row `1 Schedule` selected on the left and the form to the
RIGHT of it, measured rather than eyeballed:
`detailRightOfRail: {railRight: 561, detailLeft: 585, detailStartsRightOfTheRail: true}`.
No floor, no Save changes, no Cancel schedule, and `0` Run-now controls on the
surface. Measured beside those, and offered as an additional observation rather
than as one of the two sentences above: `0` "Agentic Run Progress" headings on
the screen.
**verdict** — CONFORMS, light and dark.

### CELL: G1 — a recurring schedule, after its first fire, in the conversation
PLAN> The card stays in the conversation, showing the schedule in the same rows; change them and press **Save changes** to re-arm.

**requires** — after a recurring schedule has fired, the card in the conversation
is still the person's to change: the same rows, editable, with Save changes; and
NOT Cancel schedule, which §7.2 puts on the run page.
**shows** — `Recurring` chosen with `Repeat every 1 day(s)`, `At 16 : 05`,
`Timezone UTC`. EVERY row is measured, not just one: interval, frequency, hour,
minute and timezone all counted as `:not([disabled])` = `1` and `[disabled]`
= `0`. Floor `1` with Save changes `1`, Cancel schedule `0`, Run now `0`.
Gated on `last_fired_at 2026-08-25T16:05:00.254Z`.
**verdict** — CONFORMS, light and dark.

### CELL: G2 — the same fired recurring schedule, on the run page
PLAN> From the schedule step of a recurring schedule that has fired once: **Cancel schedule**
PLAN> The run page's prompt window shows below the scheduler.

**requires** — the Schedule row is REACHABLE after a recurring fire; the step
opens to the right of the steps; the form is editable with Save changes AND
Cancel schedule; the prompt window sits below the scheduler; no Run now.
**shows** — `railStepReachable: true`, `railStepSelected: "true"`, the card in
the detail column with `detailStartsRightOfTheRail: true`; all five recurring
rows enabled; Save changes `1` AND Cancel schedule `1`; Run now `0`. "Below
the scheduler" is GEOMETRY, not document order:
`promptWindowGeometry: {cardBottom: 715, promptTop: 715, promptIsBelowTheCard: true}`,
with the window also inside `run-detail-column` and after the card in document
order.
**verdict** — CONFORMS, light and dark.

### CELL: K1 — a row changed on a schedule that had already fired, saved
PLAN> a change to a recurring schedule applies to its future runs

**requires** — the rows of a fired recurring schedule can be changed and saved,
and the change lands on the schedule rather than on the fire that already
happened.
**shows** — the minute moved from `05` to `15` on the card's own rows and Save
changes pressed; the trigger row re-armed from `5 16 * * *` to `15 16 * * *`
at `16:06:24.744Z` while `last_fired_at` kept its first-fire stamp
(`16:05:00.254Z`). Shot BEFORE the next tick.
**verdict** — CONFORMS, light and dark.

### CELL: K2 — and the NEXT real tick honoured it
PLAN> a change to a recurring schedule applies to its future runs

**requires** — the saved change is not cosmetic: the next fire happens at the
saved time and produces a run.
**shows** — the rows read `At 16 : 15`; the database has the first fire at
`16:05:00.254Z` and the SECOND at `16:15:00.217Z`, at the minute that was
saved, and the release job's own line names the run it cloned for it
(`recurring tick — created new run 309be637… from e3d3661f…`). A real clock, no
shifting, no hand-written stamp.
**verdict** — CONFORMS, light and dark.

### CELL: J1 — after Cancel schedule, on the run page
PLAN> **Cancel schedule** → **End state: stopped** (the scheduler then non-editable)

**requires** — Cancel schedule stops the recurring schedule and the scheduler is
then non-editable; it never deletes the schedule and never pauses the run.
**shows** — all five recurring rows counted as `[disabled]` = `1` and
`:not([disabled])` = `0`, and no floor at all — Save changes `0`, Cancel
schedule `0`, Run now `0`. In the database: `stopped_at 16:16:09.197Z`,
`enabled false`, the trigger row STILL holding its scheduler id, and the run's
own status still `armed`. And the stop was pressed while the schedule's own next
due instant (`16:25:00Z`, re-armed for the purpose) was still ahead; the round
waited past it and read back `last_fired_at` unchanged at `16:15:00.217Z` with
the release job's clone lines still exactly two.
**verdict** — CONFORMS, light and dark.

### CELL: J2 — the same stop, read in the conversation
PLAN> the scheduler then non-editable

**requires** — a stopped recurring schedule reads the same way on the
conversation host: the rows read-only, no floor.
**shows** — every recurring row `[disabled]`, no Save changes, no Cancel
schedule, no Run now.
**verdict** — CONFORMS, light and dark.

### CELL: S9d-C3 — the canonical cell this slice makes stale, re-shot
PLAN> there is no Run now

**requires** — the run page's Schedule step for a schedule that is CONFIGURED
AND HAS NOT RUN. `scripts/ci/chat-hitl-capture-index.json` already carries this
cell; the picture behind it was taken before this branch and shows **Run now**,
which this slice removes, and no prompt window, which this slice adds.
**shows** — the same reading re-shot on this branch: rows editable, `Save
changes` alone on the floor (Cancel schedule is a RECURRING schedule's control
after its first fire, and this is a one-off that has not fired), `0` Run-now
controls anywhere on the surface, and the prompt window painted below the
scheduler. The trigger row has `released_at NULL`, so the cell is the
not-yet-run reading it claims.
**verdict** — CONFORMS, light and dark. The index record is spliced to this
picture; every other record in that file is byte-identical.
