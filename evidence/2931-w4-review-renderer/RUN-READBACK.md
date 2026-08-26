# The rows behind the pictures — cinatra#2931 (W4), 2026-08-26

Read back from the instance's own database with `SELECT`s after the pictures were
taken. Values only; nothing here was written by hand.

## The runs

```
cinatra.agent_runs
 id                                    template_id                           status     created_at                     completed_at
 06474965-644f-4ffa-9c6a-c6c1ebde492b  3ac23e05-c031-43a8-8596-e502ea21bdd2  completed  2026-08-26 07:05:52.300826+00  2026-08-26 07:22:02.333+00
 f98093d7-c16d-4f8f-aeea-244ddbc34c04  3ac23e05-c031-43a8-8596-e502ea21bdd2  completed  2026-08-26 07:42:38.934840+00  2026-08-26 07:43:14.199+00
 run_by = 2660f48b-6a11-423a-afdd-a148139bf86d   org_id = 5063c707-54c8-436b-8519-2d30d5765ca8
```

Both runs were created by the app's own dispatch from a turn typed into the chat.
Their setup, schedule and context steps were answered through the app's own
controls in the browser.

## The artifacts

```
cinatra.objects
 id                                    type                                 owner_level   created_at
 4c0cada5-04e4-4d55-a7d5-9df172d5da77  @cinatra-ai/blog-post-artifact:post  organization  2026-08-26 07:22:02.026571+00
 1b5b641c-fe39-49cf-9b3f-52fe55c14c7d  @cinatra-ai/blog-post-artifact:post  organization  2026-08-26 07:43:14.107187+00

cinatra.representation
 id (revision)                         artifact_id                           revision  form  declared_mime   size_bytes  created_by_run_id
 34d8be8d-09f2-45ff-ad2e-bccf7237a130  4c0cada5-04e4-4d55-a7d5-9df172d5da77  1         file  text/markdown   5789        06474965-644f-4ffa-9c6a-c6c1ebde492b
 5681691d-be0c-4323-a1ee-655a3b72429b  1b5b641c-fe39-49cf-9b3f-52fe55c14c7d  1         file  text/markdown   3666        f98093d7-c16d-4f8f-aeea-244ddbc34c04

cinatra.artifact_materializations
 run_id 06474965-…  extension @cinatra-ai/blog-post-artifact  phase finalized  2026-08-26 07:22:01.153063+00
```

`declared_mime = text/markdown` is what makes this the acceptance's *markdown
draft*, and what the card's text rung resolves on.

## The review gates — and the timing defect they record

```
cinatra.artifact_review_gates
 id                                    run_id      status    disposition  created_at                     resolved_at
 28ebc08b-45a2-4210-818e-0f01a6d7e9ef  06474965-…  resolved  approve      2026-08-26 07:22:10.830417+00  2026-08-26 07:58:20.84878+00
 08986b6f-efce-4e4c-bf4d-cdd3d8cb89d5  f98093d7-…  pending                2026-08-26 07:43:19.182733+00
 pinned_targets[0] of 28ebc08b… = {"artifactId":"4c0cada5-…","representationRevisionId":"34d8be8d-…"}
```

**Each gate is minted after its run has already terminated** —
`07:22:02.333` → `07:22:10.830` (8.5 s) and `07:43:14.199` → `07:43:19.183`
(5.0 s). That is why no run parks at a review moment and why the conversation's
slot flips from the progress card to `Run complete` rather than to the review
card. Graded as W0's DEVIATION in `README.md`.

## The decision

```
cinatra.artifact_review_audit
 gate_id                     28ebc08b-45a2-4210-818e-0f01a6d7e9ef
 run_id                      06474965-644f-4ffa-9c6a-c6c1ebde492b
 review_task_id              lifecycle-review:657226db9df0c8fd3517292eb3cae5fdd6eb527d8b1c5d0d8c223785c36ed031
 artifact_id                 4c0cada5-04e4-4d55-a7d5-9df172d5da77
 representation_revision_id  34d8be8d-09f2-45ff-ad2e-bccf7237a130
 disposition                 approve
 renderer_kind               first-party
 renderer_package            (null)
 renderer_digest             (null)
 created_at                  2026-08-26 07:58:20.84878+00
```

One audit row, written by the real Approve press. `renderer_kind = first-party`
is the acceptance's *recorded as rendered*, and it only commits because
`core__0097` widened the column's CHECK.

## The usage ledger — the model was real

```
cinatra.usage_events  (created_at > 2026-08-26 07:00Z)
 provider  model               calls  first_at                       last_at
 openai    gpt-5.5-2026-04-23  22     2026-08-26 07:21:59.999096+00  2026-08-26 07:44:06.712852+00
 openai    gpt-5.5             4      2026-08-26 07:06:07.324464+00  2026-08-26 07:49:52.550769+00
```

`CINATRA_TEST_LLM_PROVIDER` was never set on this instance, and the instance
environment carries no provider key: the connection is sealed in the database,
configured through the app's own provider form.

## The widget wire (cell W7)

Recorded by the driver from the browser, present/absent only — never by value.

```
 label              method  path                            cookie   x-cinatra-widget-user-token  x-cinatra-widget-origin
 island-document    GET     /lifecycle/review-island        absent   absent                       (none)
 lifecycle-resolve  POST    /api/lifecycle-views/resolve    absent   present (cwu_)               http://127.0.0.1:8088
 counts: island-document ×2, lifecycle-resolve ×4
```

The browser's cookie jar at the moment the pictures were taken held exactly one
app cookie — `better-auth.session_token`, `domain=localhost`, `SameSite=Lax`,
`httpOnly` — set by the embed's own hosted-PKCE popup, which is a **top-level**
window on the app origin. It did not ride any island or lifecycle request,
because the top-level document is on `127.0.0.1:8088` and that is a different
site. The island is authenticated by the server-minted credential in its own
address.

The widget instance row and its connect-site were written by the two shipped
writers (`writeConnectorConfigToDatabase`,
`upsertConnectSiteAndMintCredential`), and `deriveFrameBinding` was asserted to
close before anything was driven:

```
deriveFrameBinding -> ok: true, client wordpress, instanceId w2931-local-site,
                      agentSlug wordpress-content-editor, siteOrigin http://127.0.0.1:8088
```

## The floor gate

```
$ pnpm gate:artifact-review-floor        # exit 0
[artifact-review-floor] 2 of 28 artifact types would land on the metadata floor under review (25 packs scanned; defensive states excluded).
    floor: @cinatra-ai/dashboard-artifact:dashboard [@cinatra-ai/dashboard-artifact] form application/vnd.cinatra.dashboard+json
    floor: @cinatra-ai/drupal:node [@cinatra-ai/drupal-artifacts] form text/html
[artifact-review-floor] OK — no new fallbacks (2 baselined; the baseline may only shrink).
```
