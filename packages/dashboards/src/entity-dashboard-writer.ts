// Stable public subpath (`@cinatra-ai/dashboards/entity-dashboard-writer`) for
// the ENTITY-dashboard create writer and the typed failures it raises.
//
// Like `extension-materialization.ts`, this file performs NO direct table writes
// — it only re-exports from the canonical `mutation-service.ts`, so the
// single-writer invariant (enforced by `__tests__/no-direct-writes.test.ts`)
// stays intact.
//
// WHY IT EXISTS (cinatra#2474 PR5). Concept B's instantiate action must run
// APP-SIDE: its authorization needs the extensions canonical store, the extension
// access policy evaluator and the app's static/runtime extension manifest, none
// of which this dependency-light package may pull. But the row it creates must be
// written by the SAME writer every other entity-dashboard create goes through —
// `createEntityDashboard`, with its owner-axis `canWrite` assertion, its
// reserved-name rule, its org-write kernel guard, its same-TX audit row and its
// twin pairing. This subpath is how the app reaches that writer without reaching
// INTO the mutation service.
//
// It deliberately exposes the writer and NOTHING that could bypass it: no table
// handle, no db accessor, no raw insert.
export {
  createEntityDashboard,
  type CreateEntityDashboardInput,
  // The typed failures a create can raise. Callers map these to their own
  // result vocabulary rather than re-deriving the conditions.
  DashboardNameConflictError,
  DashboardForbiddenError,
  DashboardInvalidEntityError,
  DashboardConfigInvalidError,
} from "./mutation-service";

// The org-write seam's authority refusal (cinatra#1939 S3) — raised BEFORE the
// writer body when the actor carries no minted authority — and the predicate for
// the KERNEL'S own lifecycle refusal. The predicate exists so a caller never has
// to reach the kernel root to classify one: opaque access to that root reaches
// every kernel writer without naming one, which the org-write boundary gate
// refuses. The kernel edge stays inside the seam that already owns it.
export {
  DashboardOrgWriteAuthorityError,
  isOrgWriteRefusal,
} from "./org-write-seam";

// The access resolver, so a caller that has just written a row can report the
// row's real `canWrite` rather than assuming it.
export { resolveDashboardAccess, type DashboardActor } from "./permissions";
