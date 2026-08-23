# PLAN-WALK — the current page, quoted verbatim

Every `PLAN>` line below is a verbatim quote from
`PLAN:-Agents-Lifecycle-(A).md` §7.2 / §7.4 at wiki commit `f207d9a`, and each
was grep-verified against that file rather than retyped from memory. The
amendment that governs this rework is `a756351` (2026-08-23).

CELL: C1
  requires: the chat conversation around a card that is not yet confirmed: the three option rows editable, and Confirm
  shows:    card=pending on host=chat_thread, one instance (1); rows=True, confirm=True, save=False
            removed-four: summary-box=False, held-steps=False, status-label=False, open-the-run=False
  verdict:  PASS

CELL: C2
  requires: the SAME card in the SAME place after Confirm: the same rows, Save changes, no status label, no summary box, no Open-the-run link
  shows:    card=settled on host=chat_thread, one instance (1); rows=True, confirm=False, save=True
            removed-four: summary-box=False, held-steps=False, status-label=False, open-the-run=False
  verdict:  PASS

CELL: C3
  requires: the run page's schedule step open: the form and its controls, with the run's other chrome visible around it
  shows:    card=settled on host=run_card, one instance (1); rows=True, confirm=None, save=True
            removed-four: summary-box=False, held-steps=False, status-label=False, open-the-run=False
  verdict:  PASS

CELL: C5
  requires: the expired reading, reached by letting the shipped 30-minute window actually run out: still visible, still editable, Confirm offered
  shows:    card=pending on host=chat_thread, one instance (1); rows=True, confirm=True, save=None
            removed-four: summary-box=False, held-steps=None, status-label=False, open-the-run=False
  verdict:  PASS

PLAN> the same card, with the same option rows, shows the schedule as it stands — no label, no summary box
    C2 draws the same rows it drew at C1 with Save changes in place of Confirm, and
    draws no "Armed ·" line and no summary box. PASS.

PLAN> The schedule step on the run page and the review page shows the same form and nothing else — no summary box, no status label
    C3 draws the form and its controls only. `scheduled-run-chrome` and
    `schedule-gated-steps` are absent from the DOM on both page hosts, and the words
    "Trigger configuration" and "Steps held until trigger fires" appear nowhere in
    the card. PASS on the summary box and the status label.

PLAN> **Cancel trigger** and **Release now** stay where they are today, on the run page's Trigger tab.
    NOT SATISFIED, and named here rather than worked around. This rework KEEPS the
    two controls on the schedule step and RENAMES them (Cancel schedule, Run now),
    because the rework instruction asks for exactly that ("rename the two controls
    wherever this card/step draws them … keep data-action ids", and the C3 cell
    lists both as controls the picture must show). The plan clause and the rework
    instruction cannot both hold. The controls' ids are unchanged, so moving them to
    the Trigger tab later is a UI move, not a wire change. THIS NEEDS A RULING.

PLAN> an expired card **stays visible**, still editable, with **Confirm** to set the schedule again
    C5, after a real 30 minutes: the card is present, the rows are editable, Confirm
    is drawn, and the reading says the schedule expired and nothing was scheduled.
    PASS.
