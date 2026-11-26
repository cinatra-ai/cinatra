# cinatra#3862 — run readings

This file records the development-instance readings for the second criterion of #3862: a run of each agent files one
page snapshot of the artifact extension's type, and the review opens on it through the generic review.

Both readings were taken on fresh development boots of main `fe912497` (the merge of #4829, which removed the stored
capture pair, its capability and its guard exemption). The lane's public tool address was switched on for each boot,
so the model provider reached the app's `/api/mcp`, and switched off again when the boot ended.

## WordPress agent — reading taken 2026-11-26

- **Boot:** main `fe912497` with the development WordPress site connected. The agent was pinned at
  `@cinatra-ai/wordpress-agent` `b04d467b` and the artifact extension at `@cinatra-ai/website-artifacts` `ef02c3ea`.
  - The development server had started before the WordPress container was up, so the WordPress MCP connector was not
    wired. The server was ended through the stop road's server-only form, and the next start wired connector instance
    `d881ccfe-3024-455e-88d9-1c94b1761b5c`.
- **Set-up done through the product's own screens:**
  - The connector settings allowed the Post editing tools (`ewpa/get-post`, `ewpa/get-page` and `ewpa/update-post`).
  - The organisation's review policy got two `review` bounds set to `required`: `*` / `none` / `agent_produced` and
    `*` / `none` / `intermediate`.
- **Producing run:** `54bf27ea-2307-4aa0-94b0-0a141e395852` (source `agent_builder`), started with:
  - `instanceId` = `d881ccfe-3024-455e-88d9-1c94b1761b5c`;
  - `postId` = `8`;
  - `instructions` = "Rewrite the first paragraph so it is one sentence shorter and keeps the same meaning."

  It read post 8: audit row `wordpress_site_tool_call` allowed, `ewpa/get-post`.
- **One page snapshot of the artifact extension's type.** The run filed exactly one artifact, page snapshot
  `b8f48877-8914-4494-b96e-a9ff9ca39aca` at revision `34263be7-d54e-49fe-80fe-e6160acf21d7`:
  - Its type is `@cinatra-ai/website-artifacts:page-snapshot`, not the retired `@cinatra-ai/objects:cms-preview-capture`.
  - Its `artifact_produced` event names the run as producer, and the run filed no other artifact.
- **Review gates:** the run stopped at `pending_approval`, and its error field stayed empty. Two review gates are
  pending on that snapshot at that revision: gate `b272d159-6c08-4a95-8104-f2142dd8b2f2` (task
  `wayflow-9a8f2d50-aa52-4d63-928b-7e51f56dd630`) and lifecycle-review gate `c9e9496a-7e25-4d79-9f4b-86f294febfde`.
  The run's step rail lists a "Review" entry for each.
- **The review opens on it through the generic review.** The review page of task `wayflow-9a8f2d50-…` opens the run's
  review step. Its review-island frame shows the card "Review requested · Awaiting your decision" for the snapshot
  (CMS page, `@cinatra-ai/website-artifacts:page-snapshot`, revision `34263be7-…`, pinned) with the snapshot's changes
  and Comment / Regenerate / Continue. The card says "The page cannot be shown here. The changes are below." The
  `review-target` anchor counts 1 on the page.
- **No stored capture.** The app log holds no request to `/api/lifecycle-views/capture`.

## Drupal agent — reading taken 2026-11-26

- **Boot:** main `fe912497` with the development Drupal site connected. The agent was pinned at
  `@cinatra-ai/drupal-agent` `a070884f`, and the artifact extension at `@cinatra-ai/website-artifacts` `ef02c3ea`.
  - The first start found the CMS container not yet up, so the connector set-up skipped it. The development server was
    ended through the stop road's server-only form, and the next start wired connector instance
    `3e9d445e-62d7-4bf5-bfe6-f66ec131ecd5`.
- **Set-up done through the product's own screens:** the organisation's review policy got two `review` bounds set to
  `required`: `*` / `none` / `agent_produced` and `*` / `none` / `intermediate`.
- **Producing run:** `680623eb-497c-4c71-8104-5f3d9ed769e4` (source `agent_builder`), started from the agent's own
  setup screen with:
  - `instanceId` = `3e9d445e-62d7-4bf5-bfe6-f66ec131ecd5`;
  - `nodeId` = `3`;
  - `instructions` = "Rewrite the first paragraph of the body so it is one sentence shorter and keeps the same meaning."
- **What the run did:**
  - It read node 3: audit `drupal_node_get` allowed, with the run as its run.
  - It filed ONE page snapshot `b596c185-e04f-4dce-b83b-fa365e02970d` of type
    `@cinatra-ai/website-artifacts:page-snapshot` at revision `615e0b90-6be3-4675-961c-6412bf5b1317`.
  - The instance holds no other page snapshot, and no object of the retired `@cinatra-ai/objects:cms-preview-capture`
    type.
  - It stopped at review gate `6712019d-182f-4845-83ec-69d48bac88c2` (task
    `wayflow-ccafacc4-0353-4c7f-8532-220393b77d9a`), status `pending`. The run stays at `pending_approval`, and its
    error field is empty.
- **The review opens on it through the generic review.** The review page of that task shows the gate "Review
  requested". Its one target is the snapshot "About this demo": the type id, the pinned revision `615e0b90-…` and the
  "CMS page" display of the artifact extension, with the changed excerpt. The decision bar shows Comment, Regenerate
  and Continue. The target is drawn in the review island's frame (anchor `review-target` counted once).
- **No stored capture.** The app log holds no request to `/api/lifecycle-views/capture`.
