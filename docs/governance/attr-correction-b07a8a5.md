# Attribution-record correction — b07a8a5 (agents OAS-only install seed)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `b07a8a569b9f143a0351fcd1666c86e19103e970`
("fix(agents): install OAS-only agent packages by seeding from cinatra/oas.json + manifest").

## What landed
b07a8a5 changes the agent install path to seed the `agent_templates` row directly
from `cinatra/oas.json` + `package.json#cinatra`, removing the materialized payload.
It touches seven files under `packages/agents/`, none matching a high-risk glob in
`.github/gate-suite.json` `highRiskPaths` — a non-high-risk change.

## What was wrong
The b07a8a5 squash carried `Assisted-by` only; it omitted the verification arm. The
post-merge `truthful-attribution-gate` rejected it (no verification arm — a record
needs a `Reviewed-by` human arm or a `Gate-suite`+`Accountable` machine arm).

## Root cause: an omitted merge-record arm, not a missing verification
b07a8a5 is non-high-risk and its full gate-suite ran green on the reviewed head
`6859d3a` before merge — so the machine arm (`Gate-suite` + `Accountable`) is the
correct and sufficient verification; it was simply omitted from the squash body.

## The correction
This forward, docs-only note records the verification arm omitted from b07a8a5. Its
own squash carries `Correction-for: b07a8a5…` plus the machine arm
(`Gate-suite: cinatra-core@2026.06.4` and the canonical `Accountable`). It is
non-high-risk and changes no runtime code.
