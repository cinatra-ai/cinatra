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

## Drupal agent — reading taken 2026-11-24

- **Earlier blocked attempt (history):** a first boot of main `b3417537` reached no repair. The dev Drupal site answered
  every `POST /_mcp_tools` with 403 ("The exposure refused a remote request"). The image's `drupal/mcp_tools`
  1.0.0-beta19 asks for two services that the module's allow-list did not know. cinatra-ai/drupal-module#124 (merged as
  `d2fdc942`) fixed that. So producing run `013afeac-…` failed at `read_node`.
- **Boot:** a fresh development boot of current main `1ee5a303` (the merge of #4776) on a lane host. The bring-up placed
  the site module `cinatra-ai/drupal-module` at `d2fdc942`, and `git rev-parse HEAD` in the lane's
  `dev/drupal-module/cinatra` read the same commit.
  - The development server was ended through the stop road's server-only form, and the next start wired connector
    instance `b1a96e9b-e623-4a0c-b81d-72bcd64404ba` (`✓ wired … (remote-key valid)`).
  - The run's MCP calls were answered 200, and no exposure refusal was logged.
- **Set-up:** the same two `review` bounds as for WordPress, set on `/configuration/artifacts`.
- **Producing run:** `270b2eb4-e115-48f5-8d30-054ab6ef20e5` (source `agent_builder`), started with:
  - `instanceId` = `b1a96e9b-e623-4a0c-b81d-72bcd64404ba`;
  - `nodeId` = `3`;
  - `instructions` = "Rewrite the first paragraph of the body so it is one sentence shorter and keeps the same meaning."

  It read node 3 (audit `drupal_node_get` allowed). It filed page snapshot `4f31b577-…` at revision `34197728-…`, then
  stopped at review gate `50de7a50-77a1-4546-833c-f5de0dd902d3`.
- **Change request:** this findings text was typed into the gate's prompt window:

  "Press Comment (not Regenerate) with these findings: the first paragraph still names the old opening hours; replace
  them with the winter hours and keep that paragraph to two sentences."

  The gate resolved as `changes_requested`, and repair `51e5782e-8317-4f3b-bf05-ab5dc15def6a` opened.
- **Repair run row** `lifecycle-repair-run:51e5782e-8317-4f3b-bf05-ab5dc15def6a`:
  - `source_type` = `lifecycle_repair`;
  - `parent_run_id` = `270b2eb4-e115-48f5-8d30-054ab6ef20e5` (the producing run).

  Its `inputParams` keys and values:
  - `instanceId` = `b1a96e9b-e623-4a0c-b81d-72bcd64404ba`: the producing run's value.
  - `nodeId` = `3`: the producing run's value.
  - `instructions` = "A reviewer requested changes to the work you produced. Apply the following requested
    changes:\n\n1. Press Comment (not Regenerate) with these findings: …": the NEW findings text, under the repair
    lead.
  - `lifecycleRepairRequest` = `{kind: lifecycle_repair_request, repairId: 51e5782e-…, gateId: 50de7a50-…, lineageId:
    50de7a50-…, attempt: 1, baseTarget: {artifactId: 4f31b577-…, representationRevisionId: 34197728-…},
    expectedBaseRevisionId: 34197728-…, findings: [{id: prompt-window, message: <the findings text>}]}`.
- **No refusal for a missing input.** The run started at 20:27:32Z, and its error field stayed empty.
  - It read node 3 at 20:27:38Z (audit `drupal_node_get` allowed).
  - The WayFlow log shows these steps in order: `Read the page`, `Compose the change and the page form`, `File the page
    snapshot`, `Gather the page snapshot's review target`, `Load + edit node` and `Settle the write outcome`.
  - The task ended `completed` at 20:28:56Z.
  - Its review gate `7a308c2f-a597-4ce2-aa96-80e2cad9dc24` was passed with Continue through the decide endpoint. The
    endpoint answered `decided`, and the resume was delivered.
  - The run stays parked at `pending_approval`, awaiting orchestration.
- **The trace reaches the edit step** (`Load + edit node`). This reading did not look at the outcome of the site write.
- The boot was stopped and its booking freed.
