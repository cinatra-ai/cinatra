# Attribution-record correction — d262716a (system-extension deletion protection)

Forward correction (the Truthful Attribution protocol) for the verification record
of squash commit `d262716ab5f9580e07a4c64eec9ffa44cef7fe2b`
("feat(extensions): protect system extensions from deletion — allow update, block
removal" — PR #1155).

## What landed
d262716a adds the kind-agnostic removal choke-point `assertCanRemoveExtension`
(typed `SystemExtensionRemovalError`), gates the three delete-intent server
actions up front, routes a system extension's reinstall through an in-place
update, unifies the dispatcher backstop, fixes the disabled-affordance copy, and
adds the covering tests — 8 files under `packages/extensions/`.

## What was wrong
The d262716a squash carried an `Accountable` trailer missing its email component:

    Accountable: Sandro Groganz (@groganz)

The gate's grammar requires `Accountable: <full-name> <email> (@<login>)`, so the
post-merge `truthful-attribution-gate` failed with `no-record: malformed
Accountable trailer`, which also invalidated the gate arm (`Gate-suite` present
without a valid `Accountable`). The record was otherwise truthful: the named
agent materially produced the diff, the `Gate-suite` pin was correct, and every
required + full-suite check on the PR head had concluded green before merge.

## The corrected truthful record for d262716a
The agent + model that materially changed the diff:

- `Assisted-by: Claude Code (claude-opus-4-8)`

Verification arm (machine): `Gate-suite: cinatra-core@2026.07.3`,
`Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)`.

## The correction
This forward, docs-only note records the corrected verification arm for
d262716a. Its own squash carries `Correction-for: d262716a…` plus the corrected
trailers and a complete machine arm. It is non-high-risk and changes no runtime
code.
