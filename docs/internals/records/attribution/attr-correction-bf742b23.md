# Attribution-record correction — bf742b23 (publish-decision record)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `bf742b23e700990e7d620bd75250d5bde2fb23da`
("feat(agents): record each publish decision").

## What was wrong
The squash landed with a delegated merge authorization, but its `Assisted-by`
record names only the agent that built the change.
The findings of independent read-only reviews by another agent drove fix commits on
the pull request, for example `243041d7` (check the prototype before any trap can
run; pass only own refusals), and those commits are part of the squash, so
the reviewing agent materially changed the diff and belongs in the record.

## The corrected truthful record for bf742b23

The corrected record names the building agent and the reviewing agent.
The change itself is untouched. The commit that adds this file carries the
two corrected Assisted-by lines in its trailer block and `Correction-for: bf742b23e700990e7d620bd75250d5bde2fb23da`.
