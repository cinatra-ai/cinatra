# Attribution-record correction — 39c65b8 (unified extension data root + V2 store, #791)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `39c65b8481633c678b0d14240c79332484194789`
("feat(extensions): unified data-root config + content-addressed V2 store (#791)",
PR #865), which the post-merge `truthful-attribution-gate` failed on.

## What landed

39c65b8 (PR #865) is stage 1 of the unified extension runtime-store epic
(cinatra#790, closing cinatra#791): the `CINATRA_EXTENSION_DATA_ROOT`
env > DB metadata > `/data/extensions` data-root config, the content-addressed
`<root>/<kind>/<slug>/<digest>/` V2 store layout + sidecar/tarball/`current`
primitives, the materializer cutover (manifest identity binding, caller-authoritative
`expectedKind`, post-gates digest reuse, `<root>/.staging` staging), host-side V2
discovery for the boot loader / targeted activation / read model / artifact rescan /
install resolution, and the best-effort boot rematerialization sweep. All work is in
`src/lib/**`, `packages/objects/src/integration/**`, and `src/lib/__tests__/**`.

None of these files matches a high-risk glob in `.github/gate-suite.json`
`highRiskPaths`: nothing under `packages/sdk-extensions/**`, `migrations/**`, or
`.github/**` was touched (the `DEFAULT_PACKAGE_STORE_PATH` constant deliberately
stays in the SDK until nothing imports it); `src/lib/extension-*.ts` are bare
files, not the `**/extension-loader/**` / `**/trust-gate/**` trees. So the whole
change is **non-high-risk** and machine-arm eligible.

## What was wrong

The 39c65b8 squash body carried `Assisted-by` trailers only; it omitted the
verification arm entirely, so the post-merge gate rejected it with
`[no-record] record invalid: no verification arm`. The omission was procedural,
not evidentiary: the merging lane's operating brief forbids the agent from
asserting any verification trailer itself, so the squash landed without one.

## The correct record

The full `cinatra-core@2026.06.4` gate suite ran and CONCLUDED SUCCESS on the
reviewed, up-to-date PR head `999f4d4f40089b6ba0687c9068c08b92942f6909`
(44 successful check runs, including both `requiredContexts` —
`source-leak-gate / source-leak-gate` and
`truthful-attribution-gate / truthful-attribution-gate` — with only the
release-only/nightly jobs skipped), and the admin squash was pinned to exactly
that head via `--match-head-commit`. The change is non-high-risk (above), so the
machine arm is the correct and sufficient verification for 39c65b8; it was
simply omitted from the squash body.

This correction commit's own merge record carries that machine arm (asserted at
merge by the accountable maintainer, per `.github/gate-suite.json`), bound to
`39c65b84…` via its `Correction-for:` trailer. This note records the evidence;
the merge record is the correction.
