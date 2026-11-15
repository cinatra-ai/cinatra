# Attribution-record correction — 3c7d9119 (publishing-step declaration)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `3c7d91195be0873b12a5afb2118d91d890feda89`
("feat(agents): declare the publishing step and persist it on the template (#4449)").

## What was wrong
The squash landed with a delegated merge authorization, but its `Assisted-by`
record names only the agent that built the change.
The findings of independent read-only reviews by another agent drove fix commits on
the pull request, for example `4f3ec6ba` (check depth only for a declaration;
name no pack value in errors), and those commits are part of the squash, so
the reviewing agent materially changed the diff and belongs in the record.

## The corrected truthful record for 3c7d9119

The corrected record names the building agent and the reviewing agent.
The change itself is untouched. The commit that adds this file carries the
two corrected Assisted-by lines in its trailer block and `Correction-for: 3c7d91195be0873b12a5afb2118d91d890feda89`.
