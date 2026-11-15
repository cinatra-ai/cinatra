# Attribution-record correction — 9de6152d (toolbar search pill)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `9de6152dbe2c4f06d608b62435c7fe02c64227c1`
("fix(ui): mount the toolbar search pill on the skills, connectors and assistants toolbars (#4447)").

## What was wrong
The squash landed with a gate-suite verification record, but its `Assisted-by`
record names only the agent that built the change.
The findings of an independent read-only review by another agent drove the
keyboard focus ring on the toolbar search pill, commit
`a9dd2430da` on the pull request this one was re-cut from (4440), and that
change is part of the squash, so the reviewing agent materially changed the
diff and belongs in the record.

## The corrected truthful record for 9de6152d

The corrected record names the building agent and the reviewing agent.
The change itself is untouched. The commit that adds this file carries the
two corrected Assisted-by lines in its trailer block and `Correction-for: 9de6152dbe2c4f06d608b62435c7fe02c64227c1`.
