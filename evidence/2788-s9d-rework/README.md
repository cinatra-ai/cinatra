# S9d rework — evidence (cinatra#2788, PR #2939)

This round changes nothing about the path the previous round walked. It walks
that path AGAIN, **through the recorder**, so the eight pictures are
measurements and not only pictures:

```
node scripts/audit/lib/chat-hitl-capture-driver.mjs \
  --walk evidence/2788-s9d-rework/capture-walk.json --merge
```

re-shot every cell into its committed path, counted the anchors on the live
page, validated each record at the AUDIT tier before anything was written, and
merged the eight records into `scripts/ci/chat-hitl-capture-index.json` —
**48 records before, 56 after**, every other record untouched and in place. The
ten round-1 records the plan retires were already gone, so the retirement was a
no-op this time and nothing else was deleted.

The maintainer rejected round 1 on four readings. What each one became:

1. **"close ups of the card, but I cannot tell the surrounding"** — every capture
   here is the FULL BROWSER WINDOW at 1440x900, device scale 2 (2880x1800 px).
   The framing is no longer a promise a driver makes in prose: each cell declares
   `"framing": "window"` in the plan, the recorder writes that declaration into
   the record, and the shutter reads it.
2. **"must be a fake and can't be from a real run"** — there is no seeded
   transcript and no hand-minted token in this round. Every timestamp behind the
   pictures is read out of the lane database in `TIMELINE.md`.
3. **the summary box, the held-steps block and the "Armed ·" line** — removed
   from the card on every host, so no host can draw them.
4. **the two control labels** — `Cancel trigger` -> `Cancel schedule`,
   `Release now` -> `Run now`, with `data-action` ids unchanged, and the confirm
   dialogs reworded to say "schedule". The plan page still places these two
   controls on the run page's Trigger tab under their old names; that divergence
   is named as an open deviation in `PLAN-WALK.md` rather than read away.

## Cells

| cell | what | themes | record |
|---|---|---|---|
| C1 | the chat conversation, card before Confirm | light, dark | registered |
| C2 | the chat conversation, same card after Confirm | light, dark | registered |
| C3 | the run page, schedule step open | light, dark | registered |
| C4 | the review page with this run's real output | **DROPPED — see TIMELINE.md** | — |
| C5 | the expired reading, after a real 30 minutes | light, dark | registered |

## The eight pictures, graded

Every picture below was opened and looked at. `shows` is what is in the pixels;
the counts it cites are the record's, taken on that same screen.

### C1 — `captures/C1__chat-before-confirm__light.png` (`sha256 154ef77f…`)
- **requires:** the chat conversation around a card that is not yet confirmed:
  the three option rows editable, and Confirm.
- **shows:** the whole window — left navigation, breadcrumb, the operator's turn,
  the assistant's turn, the card and the composer under it. The card draws
  "When should this run?", the three rows with **Recurring** chosen and owning
  its fields (Repeat every 1 day(s); At 09:00; Timezone UTC), **Estimated run
  duration**, and **Confirm** alone on the floor. No summary box, no status
  label, no Open-the-run link. Record: one card instance, `state=pending`,
  Confirm counted 1 visible inside the card root.
- **verdict:** PASS.

### C1 dark — `captures/C1__chat-before-confirm__dark.png` (`sha256 72a11f87…`)
- **requires:** the same reading in dark.
- **shows:** the same window in the dark theme, same two turns, same three rows
  with Recurring chosen, same Confirm floor. Record: identical counts, same
  thread URL.
- **verdict:** PASS.

### C2 — `captures/C2__chat-after-confirm__light.png` (`sha256 531cb5fe…`)
- **requires:** the SAME card in the SAME place after Confirm: the same rows,
  Save changes, no status label, no summary box, no Open-the-run link.
- **shows:** the same thread, the same card in the same position with the same
  rows and values; the floor now reads **Save changes** and is quiet until a row
  changes. Nothing was added around it: no "Armed ·" line, no configuration
  summary, no held-steps tree, no link to the run. Record: `state=settled`,
  Confirm measured ABSENT (count 0) inside the card root.
- **verdict:** PASS.

### C2 dark — `captures/C2__chat-after-confirm__dark.png` (`sha256 f6e24ae3…`)
- **requires:** the same settled reading in dark.
- **shows:** the settled card in dark, same rows, Save changes on the floor,
  nothing else drawn. Record: same absence measured.
- **verdict:** PASS.

### C3 — `captures/C3__run-page-schedule-step__light.png` (`sha256 1e171e07…`)
- **requires:** the run page's schedule step open: the form and its controls,
  with the run's other chrome visible around it.
- **shows:** the run page for `@cinatra-ai/planner-agent`, its Setup / Trigger /
  Permissions tabs, and the run-progress panel reading `armed` on the right. In
  the left rail, step **1 Schedule** is open and holds the same form — the three
  rows, Recurring chosen, Estimated run duration — over three controls: **Save
  changes**, **Cancel schedule**, **Run now**. No summary box, no held-steps
  block, no status label inside the step. Record: `host=run_card` on the
  run_detail URL class, one instance, `state=settled`, Confirm absent.
- **verdict:** PASS. One honest blemish, stated rather than cropped out: the
  development build's own status badge ("Rendering …" here, "Compiling …" on the
  C2 dark frame) sits in the bottom-right corner. The record declares
  `"build": "development"`, which is exactly what that badge says.

### C3 dark — `captures/C3__run-page-schedule-step__dark.png` (`sha256 ef638d55…`)
- **requires:** the same step in dark.
- **shows:** the same run, the same open step, the same three controls, in dark.
- **verdict:** PASS.

### C5 — `captures/C5__chat-expired__light.png` (`sha256 1ff764d4…`)
- **requires:** the expired reading: still visible, still editable, Confirm
  offered and nothing else on the floor.
- **shows:** the same conversation the schedule was stated in, reopened after the
  shipped window ran out. The card is still there and reads "This schedule
  expired before it was confirmed. Nothing was scheduled — change it if you like,
  then confirm it again." over the same three editable rows, with **Confirm**
  alone on the floor. Record: `state=pending`, Confirm counted 1 visible inside
  the card root.
- **verdict:** PASS.

### C5 dark — `captures/C5__chat-expired__dark.png` (`sha256 79a3afaf…`)
- **requires:** the same expired reading in dark.
- **shows:** the same expired notice, rows and Confirm floor in dark.
- **verdict:** PASS.

## What the walk needed before it would run, and what was changed

The plan was not touched to make a cell pass. Two things were wrong with the
MACHINERY, and both were fixed where they were wrong:

- **The walk had nowhere to be.** A step navigates with an app-relative path
  (`/chat`) because a committed plan carrying a host and a port is a leak and a
  plan the next lane cannot run — and the driver never read the `WALK_BASE` the
  plan's own note tells the operator to export, so the first `goto` had no
  origin to resolve against. `driveWalk` now takes the base URL from that
  variable and hands it to every context.
- **The second pass could not find the first pass's thread.** The expired cell
  lives in a conversation the PRODUCT addressed, so neither the plan nor the
  operator knows its URL until a browser has been there, and `followContext`
  only reaches across steps inside one invocation. The driver now writes down
  where each context stood (`--contexts-out`), and the later pass supplies that
  URL back as the environment value the plan already names.

One thing was wrong with the PLAN, and it was fixed there:

- **C5's floor was behind the composer.** `scrollIntoViewIfNeeded` does the
  MINIMUM scroll — it parks the element flush against the edge of the scroller,
  and the composer is pinned over that edge. The browser calls such an element
  in view and the recorder counted Confirm visible, correctly, while the picture
  showed a sliver of it. The expired card is taller than the window, so its two
  steps now ask for `"block": "center"` and the driver's `scrollIntoView` honours
  it. Both C5 pictures were re-shot with the floor in the middle of the window.
  Nothing else in the plan changed, and no other cell's framing moved.

## What is still owed on this round

- C4 needs a lane that may hold a model-provider credential. See `TIMELINE.md`.
- The plan page has no amendment for the two control labels on the schedule step.
  `PLAN-WALK.md` names that as an open deviation.

## Owed elsewhere: six cells the Audit relabel left with old pixels

The **do not shoot here — a UI lane owns these** list. cinatra#2945 (merged)
relabelled the audit lane **Core analysis → Audit** everywhere a person can see
it, and six committed captures still show the retired word, so six index records
now describe text the product does not draw. **B1–B4** in
`evidence/2852-before-after/captures` photograph the review card's chip row and
its decision floor, whose heading `review-gate-card.tsx` changed from
`Core analysis · Suggestions` to `Audit · Suggestions`; **G5** and **G6** in
`evidence/2791-s9g-conformance/captures` photograph the audit card itself on the
run page and on the review page, whose heading `verification-summary-card.tsx`
changed from `Core analysis` to `Audit` and whose rail entry in
`run-step-rail.ts` changed with it. The re-shoot is a pixels-only round on a lane
with a browser: reach the same four surfaces the two rounds already reached
(B1 / B2 the page gate region and B3 / B4 a real transcript, on one run with
every suggestion accepted and then one chip dismissed; G5 the run page and G6 the
review page's verification view on an advisory audit), take each capture the way
its round took it, and re-record all six through
`scripts/audit/lib/chat-hitl-capture-driver.mjs` so the six index records are
replaced by measurements of the new pixels rather than edited in place — the
anchors these cells are graded on did not move, only the word on them did, so a
record whose hash still matches the old image is the only thing standing between
the index and the truth. Nothing about these six is fixed by this commit.
