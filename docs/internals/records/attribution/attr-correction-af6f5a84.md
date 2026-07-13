# Attribution-record correction — af6f5a84 (sealed bundled/image imports under the unified identity, #795)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `af6f5a84cd8ce8cde8588aaf0c120c0182c6071a`
("feat(extensions): preserve sealed bundled/image imports under the unified
identity (#795)", PR #928), which the post-merge `truthful-attribution-gate`
failed on.

## What landed

af6f5a84 (PR #928) is stage 5 of the unified extension store-identity epic
(closing cinatra#795): sealed bundled/image imports keep their provenance and
digest binding when resolved through the content-addressed store, so
image-baked extensions and runtime installs share one identity model. The work
is in `packages/extensions/src/canonical-types.ts` and
`packages/extensions/src/static-bundle-anchor.ts`, `src/lib/bundled-digests.ts`
and `src/lib/static-bundle-lifecycle.ts`, the digest-recording build helper
`scripts/extensions/record-bundled-digests.mjs`, their `__tests__` suites, the
`Dockerfile` bundled-digest bake step, and the `scripts/ci/prod-boot-e2e.sh`
boot check.

None of these files matches a high-risk glob in `.github/gate-suite.json`
`highRiskPaths` (or the central `cinatra-ai/ci` defaults it extends): the
touched package is `packages/extensions/**`, NOT `packages/sdk-extensions/**`;
the `src/lib/*.ts` files are bare files, not the `**/extension-loader/**`,
`**/trust-gate/**`, `**/signature-gate/**`, or `**/capability-registry/**`
trees; nothing under `.github/**`, `**/migrations/**`, `scripts/release/**`, or
`scripts/publish/**` was touched (`prod-boot-e2e.sh` is neither a `release*.sh`
nor a `publish*.sh`). The gate confirmed this classification at the merged SHA:
its post-merge rejection cited only the malformed arm below, never a
`[high-risk]` demand for a human `Reviewed-by`. So the whole change is
**non-high-risk** and machine-arm eligible.

## What was wrong

The af6f5a84 squash body carried both `Assisted-by` trailers and a `Gate-suite`
trailer, but its `Accountable` line was malformed — `Accountable: groganz`
instead of the canonical `Accountable: Sandro Groganz <sandro@cinatra.ai>
(@groganz)` that `.github/gate-suite.json` `accountable{name,email,github}`
requires. Because the malformed line did not parse as an Accountable trailer,
the gate saw a `Gate-suite` with no Accountable — i.e. no complete verification
arm — and rejected the merge record on main with:

    truthful-attribution [no-record] record invalid: malformed Accountable trailer: "Accountable: groganz"
    truthful-attribution [no-record] record invalid: Gate-suite present without Accountable (gate arm requires both)
    truthful-attribution [no-record] record invalid: no verification arm — need a Reviewed-by (human arm) or a Gate-suite+Accountable (gate arm)

## Root cause: a malformed arm field, not a missing verification

af6f5a84 is non-high-risk (above) and its full `cinatra-core@2026.06.4` gate
suite CONCLUDED SUCCESS on the reviewed, up-to-date PR head
`2395ff61f40187c211698d98409c06ccf787e125` (44 successful check runs plus 6
release-only/nightly skips, including both `requiredContexts` —
`source-leak-gate / source-leak-gate` and the pre-merge
`truthful-attribution-gate / truthful-attribution-gate` — green), and the admin
squash was pinned to exactly that head. So the machine arm — the `Gate-suite`
trailer citing `cinatra-core@2026.06.4` together with the canonical
`Accountable` trailer per `.github/gate-suite.json` — is the correct and
sufficient verification for af6f5a84; the merging maintainer supplied that arm
but mistyped the Accountable field into a short `groganz` form the gate grammar
rejects. This is a field-format defect in an otherwise-correct record, not a
missing or wrong verification.

## The correct record

The verification record af6f5a84 should have carried is:

    Assisted-by: Claude Fable 5 (claude-fable-5)
    Assisted-by: Codex (gpt-5-codex)
    Gate-suite: cinatra-core@2026.06.4
    Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)

— the two authoring agents unchanged, the same `Gate-suite` arm, and the
`Accountable` trailer in its canonical `Name <email> (@github)` form.

## The correction

This forward, docs-only note records that intended record. Its own squash
carries `Correction-for: af6f5a84cd8ce8cde8588aaf0c120c0182c6071a` plus the
machine arm asserted by the accountable maintainer at merge time. It is
non-high-risk and changes no runtime code. One `Correction-for` on the red tip
greens the default branch.
