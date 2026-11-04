# Attribution-record correction — afbfca8d (anchor contract card controls)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `afbfca8df54ebbf7316215bd29bd39aa054fe390`
("fix(ci): leave four undrawn card controls out of the anchor contract (#4346)").

## What was wrong
The squash landed with a gate-suite verification record, but its `Assisted-by`
record names only the agent that built the change.
The findings of independent read-only reviews by two other agents drove the
changes of five of its commits, `15fc5658ac18841ec150f2ef69ffa739d80003ad`,
`6ff13aa484ef6752894ca9bc391347a7daf86320`,
`d12d0fec711c783e89ae8fb0e90fb91ccffba74a`,
`d46582e55416b42a615dc8e52411bd463821fd8f` and
`04b4ad9572db014b074ba1d81c8b948b55e1b226`, so both reviewing agents
materially changed the diff and belong in the record.

## The corrected truthful record for afbfca8d

The corrected record names the building agent and the two reviewing agents.
The change itself is untouched. The commit that adds this file carries the
three corrected Assisted-by lines in its trailer block and `Correction-for: afbfca8df54ebbf7316215bd29bd39aa054fe390`.
