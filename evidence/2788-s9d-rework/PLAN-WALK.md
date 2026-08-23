# PLAN-WALK — the current page, quoted verbatim

Every `PLAN>` line below is a verbatim sentence of
`PLAN:-Agents-Lifecycle-(A).md` §7.2 / §7.4 **as the page stands today** — wiki
head `94b8b0b`, whose own last change to this page is `f207d9a` — and each was
grep-verified against that file rather than retyped from memory.

The cell readings under `shows:` are the RECORDER's, not a reader's summary:
every count comes from the record the picture is filed with in
`scripts/ci/chat-hitl-capture-index.json`, written by
`scripts/audit/lib/chat-hitl-capture-driver.mjs --walk`. Where a line reports
something the recorder does not measure — a drawing that is absent from the
card — it says so and names where that absence is pinned instead.

CELL: C1  (light `S9d-C1__schedule-card__chat_thread__pending`, dark `…__dark`)
  requires: the chat conversation around a card that is not yet confirmed: the three option rows editable, and Confirm
  shows:    host=chat_thread on the chat URL class, one card instance, state=pending;
            [data-conversation-list]=1 visible, card root=1 visible,
            [data-action="confirm-schedule-proposal"]=1 visible inside the card root
  verdict:  PASS

CELL: C2  (light `S9d-C2__schedule-card__chat_thread__decided`, dark `…__dark`)
  requires: the SAME card in the SAME place after Confirm: the same rows, Save changes, no status label, no summary box, no Open-the-run link
  shows:    the same thread URL as C1, one card instance, state=settled;
            [data-conversation-list]=1 visible, card root=1 visible,
            [data-action="confirm-schedule-proposal"]=0 — measured ABSENT inside the card root
  verdict:  PASS

CELL: C3  (light `S9d-C3__schedule-card__run_card__decided`, dark `…__dark`)
  requires: the run page's schedule step open: the form and its controls, with the run's other chrome visible around it
  shows:    host=run_card on the run_detail URL class, one card instance, state=settled;
            card root=1 visible, host declared INSIDE the card root,
            [data-action="confirm-schedule-proposal"]=0 — measured ABSENT
  verdict:  PASS

CELL: C5  (light `S9d-C5__schedule-card__chat_thread__pending__expired`, dark `…__dark`)
  requires: the expired reading, reached by letting the shipped 30-minute window actually run out: still visible, still editable, Confirm offered and nothing else on the floor
  shows:    host=chat_thread on the chat URL class, one card instance, state=pending;
            [data-conversation-list]=1 visible, card root=1 visible,
            [data-action="confirm-schedule-proposal"]=1 visible inside the card root
  verdict:  PASS

CELL: C4 — DROPPED and stated. See TIMELINE.md: the schedule is armed and has not
  fired, so the agent has not run and has produced nothing to review. Nothing was
  staged in its place and the walk plan carries no C4 step.

PLAN> No second card is drawn for the confirmed state: the same card, with the same option rows, shows the schedule as it stands — no label, no summary box; to change it you return to the card, change the rows and press **Save changes**, which re-arms the trigger.
    C2 is the same card in the same thread as C1 — same URL, one instance, the
    same option rows — with Save changes where Confirm stood and no second card
    beside it. No label and no summary box are drawn: `schedule-armed-summary`
    and `scheduled-run-chrome` are emitted by no host, which is pinned as an
    absence by the card's own render suite
    (`packages/agents/src/__tests__/schedule-proposal-card.test.tsx`, "NO status
    label — the word Armed is drawn on no host" and its siblings), and is what the
    picture shows. PASS.

PLAN> The option rows are editable as they stand: until you confirm, you change the schedule directly on the card — the rows are never locked behind a separate step. The floor is **Confirm**
    C1 draws the three rows with the chosen one owning its fields, and the floor
    is Confirm alone — the recorder counted it inside the card root. No Adjust
    control exists to be drawn: `data-action="adjust-schedule-proposal"` is
    absent from the owner module. PASS.

PLAN> On the run page and the review page the schedule is a **dedicated step in the step rail on the left, above "1 Review"**: open that step to see the configuration or change it.
    C3 was reached by pressing the rail row itself, not by a URL that means "the
    step is open". The picture shows the numbered rail entry on the left with the
    schedule form under it, the run's tabs and its progress panel around it. This
    run has no review, so there is no "1 Review" row beneath it to photograph;
    the ordering clause is pinned where it can be pinned — the two pages place the
    rail STEP and mount no card of their own
    (`src/lib/lifecycle/__tests__/schedule-card-host-mounts.test.ts`). PASS on
    what this run can show, and the ordering is carried by the mount pin.

PLAN> The schedule step on the run page and the review page shows the same form and nothing else — no summary box, no status label; **Cancel trigger** and **Release now** stay where they are today, on the run page's Trigger tab.
    SATISFIED on the first clause and DEVIATED on the second, and the deviation is
    named rather than worked around. C3 draws the form and nothing else: no
    summary box, no held-steps block, no status label. But the step also draws the
    two controls, under the names **Cancel schedule** and **Run now**, where the
    sentence puts them on the Trigger tab under their old names. This rework was
    asked for exactly that, and the C3 cell lists both as controls the picture
    must show. The plan page carries no amendment for it, so it stands here as an
    open deviation, not as a reading of the plan. Their `data-action` ids are
    unchanged (`cancel-trigger-schedule`, `release-trigger-now`), so moving them
    to the Trigger tab later is a UI move and not a wire change.

PLAN> Nothing exists yet — the card expires on its own after 30 minutes if you do nothing, and an expired card **stays visible**, still editable, with **Confirm** to set the schedule again.
    C5, after a real 30 minutes on the shipped clock (mint 15:32:12, capture
    16:04:46 — see TIMELINE.md): the card is present and its rows are editable,
    the reading says the schedule expired and nothing was scheduled, and Confirm
    is drawn — the recorder counted it visible inside the card root. PASS.

PLAN> **Do nothing for 30 minutes** and the card expires — the expired card **stays visible** and editable, with **Confirm** to set the schedule again. **End state: expired, and you can set the schedule again from the same card.**
    The same cell, read from §7.4's sequence. Nothing touched that proposal
    between its mint and its capture: it lives in its own conversation, and no
    walk step other than the one that stated it and the one that photographed it
    ever opened that thread. PASS.
