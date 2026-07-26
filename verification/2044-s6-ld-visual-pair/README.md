# #2044 S6 L-D — the visual before/after pair: live verification

Live proofs for the completed capture pair, taken against a **real WordPress**
running the merged `wordpress-plugin#94` build (region anchors + the
authenticated preview endpoint) and a real, decidable review gate on a
lane-scoped stack (own db `s6ld` on the pg 5634 container, own Redis, app port
3087, review fence **on**, real signup, real connect-registered site with a real
provisioned webhook binding).

Every step drove **production code**: the boot-bound CMS review host seam
(`bindCmsReviewHostSeamRuntime`, read from the same globalThis slot the
connector's capability resolves) inside a real MCP request frame, the real
`emitArtifactReviewGate`, the real running app for every render and decision, and
`wp-cli` for the site-side apply the connector's `updatePostViaMcp` performs.

| # | What it proves | Evidence |
|---|---|---|
| V1 | Gate creation captures **both** roles from ONE signed fetch: `before` (the live page as fetched) and `current` (the proposal composed into that page's own adapter-marked regions). | `screenshots/V1-a-before-live-page.png`, `screenshots/V1-b-current-composed-proposal.png` — the **stored bytes**, decoded back out of the blob store |
| V2 | The review surface shows the pair side by side with the adapter's region outlines, honest captions, and **no request to the captured site**. | `screenshots/V2-review-surface-visual-pair.png` (whole surface), `screenshots/V2-b-pair-detail.png` (the pair) |
| V3 | Approve → apply → the post-apply verification records `verified` **with the visual pair linked**: reviewed vs applied. | `screenshots/V3-a-run-rail-core-analysis-verified.png` (rail), `screenshots/V3-b-verification-view-reviewed-vs-applied.png` |
| V4 | The drift case: a site-plugin rewrite outside the reviewed scope → `drifted`, and the drifted region is outlined **on the applied picture**. | `screenshots/V4-a-run-rail-core-analysis-drifted.png` (rail), `screenshots/V4-b-drift-verification-visual-evidence.png` |
| V5 | Degraded: the site unreachable at gate creation → the gate is still created and decidable, and **both** halves state the named reason in place. | `screenshots/V5-degraded-pair-named-reason.png` |

## Store verification (real Postgres)

V1 — two `objects` rows of type `@cinatra-ai/objects:cms-preview-capture`, one
per role, each with its own `resource` → `artifact_blobs` PNG and the adapter's
region geometry; only the composed one carries composition provenance:

```
before  | captured |            null                              | 98 183 B  | 4 regions
current | captured | {"substitutedRegions":["title","content","excerpt"],
                      "unmatchedFields":["status"]}                | 130 977 B | 4 regions
```

V2 — measured on the real page load:

```
capturePairPresent     : true          pairKind: "review"
sides                  : left:before, right:current
imgs                   : 2  (1280x1271, 1280x1429; both served from the host's
                             version-pinned /api/artifacts/.../preview route)
regionHighlights       : 8  (4 per side, all adapter-marked)
requestsToCapturedSite : []            <-- the no-live-fetch contract, live
```

V3 — `artifact_verification_records`: `outcome=verified`, scope
`["title","content","excerpt"]`; captures now `before | current | applied`.

V4 — `outcome=drifted`, `field_diff=[{field:"excerpt", before:"The original
excerpt of the second post.", after:"… [Sponsored: try AcmeSaaS free for 30
days!]"}]`, scope `["title"]`; the surface reports
`drifted regions: ["excerpt"]` and the applied caption reads *"1 region changed
outside the reviewed scope"*.

V5 — both capture rows `status=degraded, degradedReason=preview-unreachable`,
**no** representation row; the gate is `pending` and the decision bar is live.

## A defect this walk found

The first V1 attempt degraded `invalid-post-id` for every capture: the connector's
pointer carries the **site-scoped** external id `<instanceId>:<postId>`
(`cmsExternalId`), which the L-B addressing policy accepted only as a bare
decimal. `parsePostId` now accepts both closed grammars — nothing else — so a
real staged CMS write can actually be captured. Without it, #2044's acceptance
was unreachable on the real connector path.
