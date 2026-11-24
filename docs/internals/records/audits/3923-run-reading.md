# cinatra#3923 — run readings

This file records the development-instance readings for the first criterion of #3923: a repair run of the WordPress
agent and a repair run of the Drupal agent each start with the producing run's own start inputs and reach the edit step.

## WordPress agent — reading taken 2026-11-24

- **Boot:** a fresh development boot of main `1fe61a6f` (the merge of #4721) on a lane host. It had the development
  WordPress site connected, and the agent was pinned at `@cinatra-ai/wordpress-agent` `b04d467b`.
- **Set-up done through the product's own screens:**
  - The connector settings allowed the Post editing tools (`ewpa/get-post`, `ewpa/get-page` and `ewpa/update-post`).
  - The organisation's review policy got two `review` bounds set to `required`: `*` / `none` / `agent_produced` and
    `*` / `none` / `intermediate`. Without the bounds, the page snapshot's review is skipped by the core default, and a
    change request has no repair to start.
- **Producing run:** `22fd745d-e02f-4fc8-ac39-5b9104ff954f`, started with:
  - `instanceId` = `aae5cf79-a683-44a5-932d-9272f7ebb33f`;
  - `postId` = `8`;
  - `instructions` = "Rewrite the first paragraph so it is one sentence shorter and keeps the same meaning."

  It filed page snapshot `b5a04735-…` at revision `acbb9f69-…` and stopped at review gate
  `39068cf0-2abc-4d82-b53b-f4433f26c6e1` (task `wayflow-e35e1aff-…`).
- **Change request:** the following findings text was typed into the gate's prompt window:

  "Press Comment (not Regenerate) with these findings: the first paragraph still names the old release date; replace
  it with next spring and keep that paragraph to two sentences."

  - The gate resolved as `changes_requested`.
  - Repair `76c8efd6-9074-4cad-9210-408730bfac60` opened with route `producer_repair`, status `dispatched` and attempt 1.
- **Repair run row** `lifecycle-repair-run:76c8efd6-9074-4cad-9210-408730bfac60`:
  - `source_type` = `lifecycle_repair`;
  - `parent_run_id` = `22fd745d-e02f-4fc8-ac39-5b9104ff954f` (the producing run).

  Its `inputParams` keys and values:
  - `instanceId` = `aae5cf79-a683-44a5-932d-9272f7ebb33f`: the producing run's value.
  - `postId` = `8`: the producing run's value.
  - `instructions` = "A reviewer requested changes to the work you produced. Apply the following requested
    changes:\n\n1. Press Comment (not Regenerate) with these findings: the first paragraph still names the old release
    date; replace it with next spring and keep that paragraph to two sentences."
    - This is the NEW findings text under the product's repair-findings lead.
    - The producing run's original instructions are not kept.
  - `lifecycleRepairRequest` = `{kind: lifecycle_repair_request, repairId: 76c8efd6-…, gateId: 39068cf0-…, lineageId:
    39068cf0-…, attempt: 1, baseTarget: {artifactId: b5a04735-…, representationRevisionId: acbb9f69-…},
    expectedBaseRevisionId: acbb9f69-…, findings: [{id: prompt-window, message: <the findings text>}]}`.
- **No refusal for a missing input.** The run started at 16:15:13Z. Its error field stayed empty, and the app log holds
  no input refusal for it. It took these steps in order:
  - It read post 8: audit row `wordpress_site_tool_call` allowed, `toolName` `ewpa/get-post`, causation = the repair run.
  - It composed the change.
  - It filed a new page snapshot `ff660fdd-…` at revision `a41d32cf-…`, through the verified step `gather_page_review`.
  - It stopped at its own review gate `3ddb86e1-a114-4430-9971-9b88a3e88aaf`.
- **The trace reaches the edit step.** That gate was passed with Continue through the card's decide endpoint. The run
  then went into `edit`, the step after `page_review_gate` in the flow:
  - The run made one model call.
  - It made the edit step's site write call, `wordpress_site_tool_write` at 16:24:51Z.
  - The product refused that write with `outward_effect_requires_recorded_decision`, so the WayFlow task ended `failed`.
  - The repair run stays parked at `pending_approval` (awaiting orchestration).
  - The same refusal ended the edit step of an ordinary, non-repair run of the same agent on the same boot (run
    `9cbeef57-01a4-4aee-8717-7b370b96a2dc`, 16:28:29Z). So it is the outward-effect write policy at the edit step. It is
    not a missing repair input.

## Drupal agent — reading not taken

The Drupal reading was not taken. A fresh development boot of the same main came up with the development Drupal site
(node 3) connected. The run was stopped before the connector instance was wired, because the shared lane host was
needed for other work. The boot was stopped and nothing was recorded for the Drupal agent.
