# RED-FIRST

Five tests were written against the reworked contract BEFORE the component was
touched, and all five failed for the stated reason:

| test | failed with |
|---|---|
| NO summary box and NO held-steps block on either page host | the card drew `scheduled-run-chrome` |
| NO status label — the word Armed is drawn on no host | the card drew `schedule-armed-summary` |
| NO Open-the-run link on any host | the card drew `schedule-open-run` |
| the two controls are named Cancel schedule and Run now | expected "Cancel trigger" to contain "Cancel schedule" |
| the confirm dialogs say schedule, not trigger | expected the strip's "Cancel scheduled trigger?" to contain "Cancel this schedule?" |

`Tests  5 failed | 30 skipped (35)`.

After the change the whole file is green: `Tests  35 passed (35)`. Six
pre-existing tests that asserted the removed drawings were updated in the same
commit and are listed in the PR body.

## The mounts pin, red first

One test on this branch asserted a body field the card no longer draws. It was
red at `c555788` for exactly that reason, and green after the list was aligned
with the gate's:

| test | failed with |
|---|---|
| `schedule-card-host-mounts` › it consumes its AUTHORIZED body through the one resolve seam, and reads every phase | `AssertionError: .triggerType: expected '"use client";\n\n// …' to contain '.triggerType'` |

`Tests  1 failed | 8 passed (9)` before, `Tests  9 passed (9)` after.

The card was NOT changed to satisfy it. `.triggerType`, `.gatedSteps` and
`.runId` left the one-card gate's authorized body list when the chrome removal
took away the drawings that read them — the Trigger configuration summary, the
held-steps tree and the "Open the run" link — and this pin had kept demanding
them, which is a test asking for the chrome back. The list is now the gate's,
field for field, which is the only spelling of it that cannot drift again
without the gate drifting first.
