# Attribution-record correction — de45a1f4 (connector setup server-action references, twenty-connector#39)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `de45a1f4aaf5f1cfa4692fd58c158c6d74e090f6`
("fix(connectors): publish real server-action references for connector setup
pages (#960)"), which the post-merge `truthful-attribution-gate` failed on.

## What landed

de45a1f4 (PR #960) fixes the deterministic admin-session HTTP 500 on the
twenty-connector setup page (cinatra-ai/twenty-connector#39): the host binder
published lazy-import adapter closures instead of server-action references for
the connector setup-page form actions. The work is a new `"use server"` module
(`src/app/campaigns/connector-setup-actions.ts`), the binder re-point
(`src/lib/register-host-connector-services.ts`), an RSC-layer
server-reference bridge (`src/lib/connector-setup-action-references.server.ts`)
imported by the connector dispatch route
(`src/app/connectors/[vendor]/[slug]/[subroute]/page.tsx`), the publication
regression suite, and the catalog-enumerated connector setup routes in the
render-smoke e2e spec.

None of these files matches a high-risk glob in `.github/gate-suite.json`
`highRiskPaths` (or the central `cinatra-ai/ci` defaults it extends): the
touched `src/lib/*.ts` files are bare files, not the `**/extension-loader/**`,
`**/trust-gate/**`, `**/signature-gate/**`, or `**/capability-registry/**`
trees; `src/app/**` and `tests/e2e/**` match nothing; nothing under
`.github/**`, `**/auth/**`, `**/migrations/**`, or `packages/sdk-extensions/**`
was touched. The gate's post-merge rejection cited only the suite-version
mismatch below, never a `[high-risk]` demand for a human `Reviewed-by`. So the
change is **non-high-risk** and machine-arm eligible.

## What was wrong

The de45a1f4 squash carried a complete, well-formed gate arm — but its
`Gate-suite` trailer cited `cinatra-core@2026.06.5`, copied verbatim from the
then-latest green machine-arm squash on main (`c4b4aa2b`, PR #958). Between
that exemplar and this merge, PR #956 ("ci: bump cinatra-ai/ci gate-engine
pins … + gate-suite pin realign", merged as `8029a5f3`) bumped the committed
suite in `.github/gate-suite.json` to `cinatra-core@2026.07.1`. The gate reads
the suite file AT THE MERGED SHA, where the committed suite is `2026.07.1`, so
it correctly rejected the stale citation on main with:

    truthful-attribution [gate-suite-fabricated] Gate-suite arm fails verification: Gate-suite trailer 'cinatra-core@2026.06.5' != committed suite 'cinatra-core@2026.07.1'

(The first run of the same gate failed earlier with a transient
`[gate-suite-unverifiable]` API-binding error; the deterministic re-run
surfaced the real mismatch above.)

## Root cause: a stale suite citation, not a missing verification

de45a1f4's full gate suite CONCLUDED SUCCESS on the reviewed, up-to-date PR
head `151ad30fb46f9a64ddb0351df01bf3e3b1fd50bf` — 45 successful check runs
plus 6 conditional skips, including both `requiredContexts`
(`source-leak-gate / source-leak-gate` and the pre-merge
`truthful-attribution-gate / truthful-attribution-gate`) — under the NEW
(post-#956) gate-engine pins, and the admin squash was pinned to exactly that
head (`--match-head-commit`). The verification itself is real and sufficient;
only the version literal in the trailer lagged the same-day suite bump.

## The correct record

The verification record de45a1f4 should have carried is:

    Assisted-by: Claude Fable 5 (claude-fable-5)
    Gate-suite: cinatra-core@2026.07.1
    Accountable: Sandro Groganz <sandro@cinatra.ai> (@groganz)

— the authoring agent unchanged, the same gate arm, citing the suite version
committed at the merged SHA.

## The correction

This forward, docs-only note records that intended record. Its own squash
carries `Correction-for: de45a1f4aaf5f1cfa4692fd58c158c6d74e090f6` plus the
machine arm asserted by the accountable maintainer at merge time. It is
non-high-risk and changes no runtime code. One `Correction-for` on the red tip
greens the default branch.
