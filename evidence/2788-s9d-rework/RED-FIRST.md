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
