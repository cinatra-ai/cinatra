# Attribution-record correction — 7152b8cc (/connectors default filter)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `7152b8cc9d892893402ea1cef14a7d9cb36732d5`
("fix(connectors): always default the filter to Connected (drop localStorage
persistence)" — PR #1159).

## What landed
7152b8cc removes the localStorage persistence of the /connectors filter so a
fresh load always lands on the Connected view. The PR head had all 15 required
checks green and a captured MERGE-SAFE convergence verdict before merge.

## What was wrong
The squash was merged via the REST merge endpoint with an empty
`commit_message` parameter (the prepared body file was missing after an aborted
earlier attempt — an operator tooling error, caught immediately post-merge).
The squash therefore carries a title only: no `Closes` line, no `Assisted-by`
record, and no verification arm — failing the truthful-attribution requirement
outright. The work itself was attributable and verified; only the record was
dropped.

## The corrected truthful record for 7152b8cc
The agent + model that materially changed the diff:

- `Assisted-by: Claude Code (claude-opus-4-8)`

Verification arm (machine): `Gate-suite: cinatra-core@2026.07.3`,
`Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`.

## The correction
This forward, docs-only note records the complete verification record for
7152b8cc. Its own squash carries `Correction-for: 7152b8cc…` plus the corrected
trailers and a complete machine arm. It is non-high-risk and changes no runtime
code.
