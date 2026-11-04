# Attribution-record correction — a08d5917 (schedule Enabled checkbox)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `a08d5917511e77f57572c69eab65611ff377c631`
("fix(skills): draw the schedule Enabled control as a checkbox (#4355)").

## What was wrong
The squash landed with a gate-suite verification record, but its `Assisted-by`
record names only the two agents that made the pull request's commits.
The findings of an independent read-only review by another agent drove the
changes of one of its commits, `6903c8bae700f4bd69f48aacfb7133387c650908`,
so the reviewing agent materially changed the diff and belongs in the record.

## The corrected truthful record for a08d5917

The corrected record names the two building agents and the reviewing agent.
The change itself is untouched. The commit that adds this file carries the
three corrected Assisted-by lines in its trailer block and `Correction-for: a08d5917511e77f57572c69eab65611ff377c631`.
