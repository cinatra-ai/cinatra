# Attribution-record correction — 452443e (marketplace [scope] breadcrumb non-clickable, #797)

Forward correction (the Truthful Attribution protocol §5) for the verification
record of squash commit `452443e186e312a40b01d43e51dd2f7fecc916c9`
("fix(breadcrumb): render marketplace vendor/scope crumb as non-clickable label
(#797)", PR #857), which the post-merge `truthful-attribution-gate` failed on.

## What landed

452443e (PR #857) fixes the marketplace breadcrumb 404 (#797): the vendor/scope
segment (e.g. `cinatra-ai` on `/configuration/marketplace/cinatra-ai/openai-connector`)
rendered as a link to `/configuration/marketplace/[scope]`, a routing container
with no `page.tsx`, so clicking it 404'd. The change adds a marketplace-scope
branch to `isPagelessContainerCrumb()` in `src/lib/breadcrumb-trail.ts` marking
the depth-3 `[scope]` crumb non-navigable, with a deny-list
(`MARKETPLACE_STATIC_ROUTES`: `submissions`, `vendor-applications`) so the
static sibling routes that do have pages stay clickable, plus unit tests in
`src/lib/__tests__/breadcrumb-trail.test.ts`.

Neither file matches a high-risk glob in `.github/gate-suite.json`
`highRiskPaths`: `src/lib/breadcrumb-trail.ts` is a bare file under `src/lib/`
(not `src/lib/auth*`, not `**/session*`, none of the loader/trust/registry
trees), and the test file likewise matches nothing. So the whole change is
**non-high-risk**.

## What was wrong

The 452443e squash carried `Assisted-by` only; it omitted the verification arm.
The post-merge `truthful-attribution-gate` rejected it with `[no-record] record
invalid: no verification arm — need a Reviewed-by (human arm) or a
Gate-suite+Accountable (gate arm)`.

## Root cause: an omitted merge-record arm, not a missing verification

452443e is non-high-risk and its full gate-suite ran green on the reviewed head
`73e8a988a4919c98f0e214cf21528fa4a3e5935d` before merge — every required
context, including `source-leak-gate`, `skills-drift-gate`, the pre-merge
`truthful-attribution-gate`, the full `Typecheck and unit tests` job (the
breadcrumb-trail suite runs there), and the in-image `build` job, all concluded
success. So the machine arm — the `Gate-suite` trailer citing
`cinatra-core@2026.06.4` together with the canonical `Accountable` trailer per
`.github/gate-suite.json` — is the correct and sufficient verification; the
merging lane omitted it from the squash body (the lane's own rules bar it from
asserting verification trailers, so the arm must be supplied at merge time by
the accountable maintainer).

## The correction

This forward, docs-only note records the verification arm omitted from 452443e.
Its own squash carries `Correction-for: 452443e186e312a40b01d43e51dd2f7fecc916c9`
plus the machine arm asserted by the accountable maintainer at merge time. It is
non-high-risk and changes no runtime code. One `Correction-for` on the red tip
greens the default branch.
