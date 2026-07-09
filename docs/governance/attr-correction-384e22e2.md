# Attribution-record correction — 384e22e2 (agent_get cross-org read authorization)

Forward correction (the Truthful Attribution protocol) for the verification
record of squash commit `384e22e256d6f2b2f50fd7805d6313bd2809a637`
("fix(agents): enforce cross-org read authorization on the agent_get MCP
handler").

## What landed
384e22e2 adds a cross-org read-authorization gate to the `agent_get` MCP
handler: the handler resolves the caller's active org and platform-admin status
from the server-only, unforgeable actor envelope and denies a cross-org
template read (404-hidden, audited), closing a gap where any authenticated MCP
caller who knew a template id could read any agent template across
organizations. The PR head had all required checks green and a captured
MERGE-SAFE convergence verdict before merge.

## What was wrong
The squash body carried only the `Assisted-by` record and no verification arm.
The truthful-attribution post-merge push arm requires either a human
`Reviewed-by` arm or a machine `Gate-suite` + `Accountable` arm; with neither,
the landed record was invalid ("no verification arm"). The work itself was
attributable, non-high-risk, and gate-suite-green; only the machine arm was
dropped from the merge record.

## The corrected truthful record for 384e22e2
The agent + model that materially changed the diff:

- `Assisted-by: Claude Code (claude-opus-4-8)`

Verification arm (machine): `Gate-suite: cinatra-core@2026.07.3`,
`Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`.

## The correction
This forward, docs-only note records the complete verification record for
384e22e2. Its own squash carries `Correction-for: 384e22e2…` plus the corrected
trailers and a complete machine arm. It is non-high-risk and changes no runtime
code.
