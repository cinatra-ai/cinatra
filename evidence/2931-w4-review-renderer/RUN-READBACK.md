# The rows behind the pictures — cinatra#2931 (W4), 2026-08-26

Read back from the instance's own database with `SELECT`s after the pictures were
taken. Values only; **nothing here was written by hand** — the only direct SQL
this round issued was these reads.

## The run

```
cinatra.agent_runs
 id            55c141ee-42b0-4ccb-b3ce-98568a8293b9
 template_id   3ac23e05-c031-43a8-8596-e502ea21bdd2
 status        completed
 created_at    2026-08-26 11:01:21.652782+00
 completed_at  2026-08-26 11:05:46.591+00
 run_by        2660f48b-6a11-423a-afdd-a148139bf86d
 org_id        5063c707-54c8-436b-8519-2d30d5765ca8
```

Created by the app's own dispatch from **one** turn typed into the chat (no
`@`-mention). Its setup and schedule steps were answered through the app's own
controls in the browser, both before the run began working.

## The artifact it produced

```
cinatra.objects
 id           ac090f07-8c76-46ad-9d07-8612216c6ce7
 type         @cinatra-ai/blog-post-artifact:post
 owner_level  organization
 created_at   2026-08-26 11:05:46.401039+00

cinatra.representation
 id (revision)      8c011e7e-903e-446e-84df-b415d8b7a194
 artifact_id        ac090f07-8c76-46ad-9d07-8612216c6ce7
 revision           1
 form               file
 created_by_run_id  55c141ee-42b0-4ccb-b3ce-98568a8293b9
 created_at         2026-08-26 11:05:46.401039+00

cinatra.resource   (the blob the representation points at)
 kind         blob
 mime         text/markdown
 size_bytes   19799

cinatra.artifact_materializations
 run_id 55c141ee-…  extension @cinatra-ai/blog-post-artifact  phase finalized  2026-08-26 11:05:45.582265+00
```

`mime = text/markdown` is what makes this the acceptance's *markdown draft*, and
what the card's text rung resolves on. Unlike the previous round's producer, this
one wrote **prose** into the representation, so the rendered pane holds the
article rather than a JSON envelope.

## The review gate — and the minting order it still records

```
cinatra.artifact_review_gates
 id              07e89419-6da7-412b-9b8f-63a6e9da5d1a
 run_id          55c141ee-42b0-4ccb-b3ce-98568a8293b9
 status          resolved
 disposition     approve
 created_at      2026-08-26 11:06:11.412469+00
 resolved_at     2026-08-26 11:14:31.552523+00
 review_task_id  lifecycle-review:bb5da60c281bebd276728f58c80a2cdd786cd43f5954fb1954cb55128addca4c
 pinned_targets[0] = {"artifactId":"ac090f07-…","representationRevisionId":"8c011e7e-…"}
```

**The gate is minted after the run has terminated** — `11:05:46.591` →
`11:06:11.412`, **24.8 s**. That ordering is unchanged and is not this slice's to
fix. What the merged head changes is what the reader sees during those 24.8 s:
the slot holds the placeholder, and then becomes the review.

## The swap, from the pages themselves

A `MutationObserver` on `data-run-review-slot`, one per page, neither page
reloaded after the turn was typed:

```
chat page      null → working 11:05:47.173Z → review 11:06:19.399Z → card mounted 11:06:20.770Z
run page       null → working 11:05:47.174Z → review 11:06:19.409Z → card mounted 11:06:22.273Z
```

* placeholder held for **32.2 s**, spanning the run's termination and the gate's
  minting;
* the slot flipped **8.0 s** after the gate existed, **32.8 s** after the run
  ended;
* **no third reading** appears between `working` and `review` — a completion
  notice removes the attribute entirely, so it would have been recorded.

Turns typed into the conversation: **1**, at `11:01:02.977Z`. Presses on the
run's own gates: 4 (`11:01:27.355`, `11:01:54.028` and `11:02:37.900` on the
setup card, `11:02:11.250` on the run page's schedule step) — all before the
working window, none after. The pages' own slot reader issued **295** GETs to
`/api/agents/runs/<runId>` across the session: that is the sidecar looking, not
the reader asking.

## The decision

```
cinatra.artifact_review_audit
 gate_id                     07e89419-6da7-412b-9b8f-63a6e9da5d1a
 run_id                      55c141ee-42b0-4ccb-b3ce-98568a8293b9
 review_task_id              lifecycle-review:bb5da60c281bebd276728f58c80a2cdd786cd43f5954fb1954cb55128addca4c
 artifact_id                 ac090f07-8c76-46ad-9d07-8612216c6ce7
 representation_revision_id  8c011e7e-903e-446e-84df-b415d8b7a194
 disposition                 approve
 renderer_kind               first-party
 renderer_package            (null)
 renderer_digest             (null)
 created_at                  2026-08-26 11:14:31.552523+00
```

One audit row, written by the real Approve press at `11:14:30.782Z`.
`renderer_kind = first-party` is the acceptance's *recorded as rendered*, and it
only commits because `core__0097` widened the column's CHECK.

## The usage ledger — the model was real

```
cinatra.usage_events  (created_at > 2026-08-26 10:55Z)
 provider  model               calls  first_at                       last_at
 openai    gpt-5.5-2026-04-23  11     2026-08-26 11:05:44.686462+00  2026-08-26 11:06:59.093986+00
 openai    gpt-5.5             2      2026-08-26 11:01:42.251254+00  2026-08-26 11:11:45.644760+00
```

`CINATRA_TEST_LLM_PROVIDER` was never set on this instance, and the lane
environment carries no provider key: the connection is sealed in the database,
configured through the app's own provider form.

## The widget wire (cell W7)

Recorded by the driver from the browser, present/absent only — never by value.

```
 label              method  path                          cookie   x-cinatra-widget-user-token  x-cinatra-widget-origin
 island-document    GET     /lifecycle/review-island      absent   absent                       (none)
 lifecycle-resolve  POST    /api/lifecycle-views/resolve  absent   present (cwu_)               http://127.0.0.1:8088
 counts: island-document ×6, lifecycle-resolve ×12
```

The browser's cookie jar at the moment the pictures were taken held exactly one
app cookie — `better-auth.session_token`, `domain=localhost`, `SameSite=Lax`,
`httpOnly` — set by the embed's own hosted-PKCE popup, which is a **top-level**
window on the app origin. It did not ride any island or lifecycle request,
because the top-level document is on `127.0.0.1:8088` and that is a different
site. The island is authenticated by the server-minted credential in its own
address.

## The floor gate

```
$ pnpm gate:artifact-review-floor
[artifact-review-floor] 2 of 28 artifact types would land on the metadata floor under review (25 packs scanned; defensive states excluded).
    floor: @cinatra-ai/dashboard-artifact:dashboard [@cinatra-ai/dashboard-artifact] form application/vnd.cinatra.dashboard+json
    floor: @cinatra-ai/drupal:node [@cinatra-ai/drupal-artifacts] form text/html
[artifact-review-floor] OK — no new fallbacks (2 baselined; the baseline may only shrink).
```
