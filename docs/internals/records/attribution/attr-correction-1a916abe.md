# Attribution-record correction — 1a916abe (design build lock)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `1a916abe53153e7a94ac4d0d63cbc48db43ff591`
("ci: run the design build under one lock per self-hosted machine (#4393)").

## What was wrong
The squash landed with a maintainer approval on GitHub, but its `Assisted-by`
record names only the agent that built the change.
The findings of an independent read-only review drove the changes of two of its
commits, `4ee41956ce23cc1b615dc73a49bb485260b2c4d9` and
`5be0f969a17b8e7d212d10a1d856e67339e84767`, so the reviewing agent materially
changed the diff and belongs in the record.

## The corrected truthful record for 1a916abe

The corrected record names the building agent and the reviewing agent. The
change itself is untouched. The commit that adds this file carries the two
corrected Assisted-by lines in its trailer block and `Correction-for: 1a916abe53153e7a94ac4d0d63cbc48db43ff591`.
