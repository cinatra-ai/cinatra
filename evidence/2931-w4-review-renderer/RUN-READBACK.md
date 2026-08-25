# cinatra#2931 W4 — the run behind the pictures, read back from the database

Every picture in `captures/` is of a row in this file. Nothing here was written
by hand: the runs were created by the app's own dispatch (a turn typed into
`/chat`), the artifacts were written by the agent through the shipped
`/api/llm-bridge` step, the gates were minted by the app's own review-orchestration
sweep, and the one decision was a real press of **Approve** in a browser.

## The chain, in order

| When (UTC) | What happened | Where it is recorded |
|---|---|---|
| 09:12:00 | run 1 created from a turn typed into `/chat` | `agent_runs` |
| 09:22:15 | run 1 **failed** — the agent runtime was not up yet | `agent_runs.error` |
| 09:30:25 | run 2 created from a turn typed into `/chat` | `agent_runs` |
| 09:36:08 | run 2's agent wrote a **text/markdown** artifact (3 710 bytes) | `objects` |
| 09:36:28 | the sweep minted run 2's **pending** review gate | `artifact_review_gates` |
| 09:39:18 | run 3 created from a turn typed into `/chat` | `agent_runs` |
| 10:12:41 | run 3's agent wrote a **text/markdown** artifact (6 506 bytes); run 3 completed | `objects`, `agent_runs` |
| 10:12:53 | the sweep minted run 3's **pending** review gate | `artifact_review_gates` |
| 10:42:17 | **Approve** pressed on the review page; gate resolved and the audit row committed | `artifact_review_gates`, `artifact_review_audit` |

## The one row that settles the claim

```
artifact_review_audit
  gate_id        148825cd-b3df-4ca2-a892-6d29e2726c99
  artifact_id    34a5a1e1-24f9-4619-a622-b56c68018091
  revision       d93bad0e-077d-4aaf-9e61-b038af0a23c4
  disposition    approve
  renderer_kind  first-party      <-- the FORM RUNG, recorded as rendered
  renderer_package  (null)
  renderer_digest   (null)
  created_at     2026-08-25 10:42:17.49567+00
```

`first-party` is the value this slice adds. It says the host itself rendered the
declared text form — and it is **not** `floor`, which is what the same review
would have recorded before this slice and what the floor gate counts. The row
also proves the constraint half of the change: before the CHECK was widened this
exact INSERT raised and rolled the whole decision back, so the gate could not
have reached `resolved` at all.

## The raw readback

```
== agent_runs ==
                  id                  |  status   |            title            |          created_at           |        completed_at        
--------------------------------------+-----------+-----------------------------+-------------------------------+----------------------------
 e8ae1418-0379-4f61-b929-01d3a54eabee | failed    | Blog Draft Writer Agent (1) | 2026-08-25 09:12:00.912808+00 | 2026-08-25 09:22:15.819+00
 6d1642ff-b60f-43ed-a7b4-e5962addc00d | failed    | Blog Draft Writer Agent (2) | 2026-08-25 09:30:25.307526+00 | 2026-08-25 09:36:06.921+00
 cb746224-7c97-4686-9149-bec683a0d3f4 | completed | Blog Draft Writer Agent (3) | 2026-08-25 09:39:18.768012+00 | 2026-08-25 10:12:41.978+00
(3 rows)
== artifact objects (pinned targets) ==
                  id                  |                type                 |          created_at           |     mime      | size_bytes |                         title                         | viewer_hint 
--------------------------------------+-------------------------------------+-------------------------------+---------------+------------+-------------------------------------------------------+-------------
 d556377a-9502-4b54-ba84-96efeccdaf7c | @cinatra-ai/blog-post-artifact:post | 2026-08-25 09:36:08.608808+00 | text/markdown | 3710       | Why Small Teams Should Automate Weekly Status Reports | mime
 34a5a1e1-24f9-4619-a622-b56c68018091 | @cinatra-ai/blog-post-artifact:post | 2026-08-25 10:12:41.780621+00 | text/markdown | 6506       | Why Small Teams Should Automate Weekly Status Reports | mime
(2 rows)
== artifact_review_gates ==
                  id                  |                run_id                |  status  | disposition |         resolved_at          |          created_at           |                                                        pinned_targets                                                        
--------------------------------------+--------------------------------------+----------+-------------+------------------------------+-------------------------------+------------------------------------------------------------------------------------------------------------------------------
 dbe6f11c-c115-4608-b2fe-93cd45825c67 | 6d1642ff-b60f-43ed-a7b4-e5962addc00d | pending  |             |                              | 2026-08-25 09:36:28.145255+00 | [{"artifactId": "d556377a-9502-4b54-ba84-96efeccdaf7c", "representationRevisionId": "465f4db3-c750-41a4-a23d-167f5a1a3abd"}]
 148825cd-b3df-4ca2-a892-6d29e2726c99 | cb746224-7c97-4686-9149-bec683a0d3f4 | resolved | approve     | 2026-08-25 10:42:17.49567+00 | 2026-08-25 10:12:53.786039+00 | [{"artifactId": "34a5a1e1-24f9-4619-a622-b56c68018091", "representationRevisionId": "d93bad0e-077d-4aaf-9e61-b038af0a23c4"}]
(2 rows)
== artifact_review_audit ==
                  id                  |               gate_id                |             artifact_id              |      representation_revision_id      | disposition | renderer_kind | renderer_package | renderer_digest |          created_at          
--------------------------------------+--------------------------------------+--------------------------------------+--------------------------------------+-------------+---------------+------------------+-----------------+------------------------------
 f414a4ad-65f6-41fd-b7b8-55f7311ef135 | 148825cd-b3df-4ca2-a892-6d29e2726c99 | 34a5a1e1-24f9-4619-a622-b56c68018091 | d93bad0e-077d-4aaf-9e61-b038af0a23c4 | approve     | first-party   |                  |                 | 2026-08-25 10:42:17.49567+00
(1 row)
== applied migrations (tail) ==
                            name                            |           run_on           
------------------------------------------------------------+----------------------------
 core__0097_artifact-review-audit-first-party-renderer-kind | 2026-08-25 08:10:11.437557
 core__0096_agent-run-created-at-immutable                  | 2026-08-25 08:10:11.436276
 core__0095_run-recommendation-skip-record                  | 2026-08-25 08:10:11.435064
(3 rows)
```

## The provider, and its limits

The drafts were written by the **real** provider. The instance's LLM provider was
configured through the app's own provider form (the setup wizard's MODEL step),
so the app sealed the connection itself; the key was never written to a file on
the capture host, never passed as an argument and never printed. The agent
runtime reached the model through the shipped `/api/llm-bridge` step — its own
log line for the producing step is `Write draft via /api/llm-bridge`.

**Limits, stated rather than glossed.**

* The two `text/markdown` artifacts are what the agent actually wrote. Run 2's
  bytes are the agent's whole JSON envelope (`{"title":…,"excerpt":…,"content":"## …"}`),
  so the card renders that envelope — truthfully, because that is what the
  artifact holds. Run 3's bytes are clean markdown prose, which is why W7/W8/W9
  read as an article and W1/W2/W3 read as an envelope. Neither is this slice's
  doing: the card shows the artifact's real content either way.
* Run 1 and run 2 failed. Run 1 failed because the agent runtime was not running
  yet; run 2 failed after its draft was written, on a second flow start with no
  `idea` input. Run 3 is the clean one, and it is the run W7–W10 photograph.
* The review gates were minted by the sweep **after** the runs had already
  terminated, so no run ever parked at a review moment. That is why W5 is a
  refusal rather than a pass — see README.
