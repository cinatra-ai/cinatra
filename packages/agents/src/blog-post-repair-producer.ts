import "server-only";

// ---------------------------------------------------------------------------
// blog-post-repair-producer (cinatra#2040, epic #2037 S2)
//
// What is left here is the blog pipeline's REPAIR-CAPABILITY DECLARATION — the
// compiled manifest lifecycle the review orchestration reads to ROUTE a
// `changes_requested` to the producer (vs a human / org route).
//
// The direct-call repair function this module used to export was REMOVED under
// cinatra#2951: it was never reachable through the product — no route, no orchestration step, no assistant action
// called it — and the product decision recorded on cinatra#2951 (2026-09-11)
// names the NEW-RUN road as the intended repair road instead. A requested change on a reviewed artifact
// dispatches a NEW run of the producing agent carrying the request
// (`lifecycle-repair-dispatch-store`, the `producer_repair` delivery); the
// producing agent's own graph does the repairing work on that run and answers
// through `submitRepairResponse`, which pins the successor in a NEW gate (never
// repin under the reviewer) and re-points the held effect onto it.
//
// `BLOG_POST_LIFECYCLE_CONFIG` is that declaration for the blog pipeline.
// ---------------------------------------------------------------------------

import { BLOG_POST_LIFECYCLE } from "./lifecycle-repair-producer-registry";

/** The compiled lifecycle declaration for the blog pipeline — it PRODUCES blog
 * post body artifacts and CAN REPAIR them (the repair loop routes
 * `changes_requested` to this producer, which repairs on a dispatched new run).
 * Seeded onto the blog agent template's `lifecycle_config` (JSON-as-text),
 * trigger-style.
 *
 * cinatra#2047 defect D-1: the declaration now LIVES in the core producer
 * registry (a pure module the boot-time projection can load without a
 * materializer graph) and is re-exported here so the declaration and the
 * pipeline it declares remain one source of truth. The projection is what
 * actually lands it on `agent_templates.lifecycle_config`; before D-1 nothing
 * did, so the route always fell through to `human_escalation`. */
export { BLOG_POST_LIFECYCLE } from "./lifecycle-repair-producer-registry";

/** The JSON-as-text form persisted on `agent_templates.lifecycle_config`. */
export const BLOG_POST_LIFECYCLE_CONFIG = JSON.stringify(BLOG_POST_LIFECYCLE);
