import "server-only";

/**
 * Centralized sealed-room read filter.
 *
 * Inside a project P, every `*_list` for objects, agent runs, chat
 * threads, and artifact read-throughs returns ONLY rows where
 * `project_id = P`. Ambient mode (no `projectId` filter) = unchanged.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the sealed-room predicate.
 * Every list handler imports `resolveSealedRoomMode` and
 * `assertProjectReadAccess` from here — never re-implements the check
 * inline. Centralization is required so the invariant that Graphiti /
 * semantic-search results are re-filtered cannot be bypassed by a future
 * caller that forgets to apply the project_id clause.
 *
 * Why the SQL `AND project_id = $projectId` clause lives inside the
 * underlying store function (e.g. `listObjectsByFilter`) rather than the
 * MCP handler: the handler is one of MANY possible callers of the store.
 * A future caller that handed in candidate IDs (`id IN (...)`) from a
 * Graphiti / semantic search MUST still be filtered. Pinning the canonical
 * project_id-equality clause to the SQL store path means **both** the
 * SQL WHERE (ambient set) and any `id IN (...)` set are intersected with
 * the project boundary — the re-filter is non-bypassable from the data layer.
 *
 * `projectId` here is a **resource refinement**, never an ownership tier.
 * The 4 OwnerLevels (user / team / organization / workspace) are unchanged;
 * the sealed-room predicate is an orthogonal filter on a nullable refinement
 * column. This module remains the only sealed-room entry point in the list
 * handlers.
 *
 * Each table has an env-driven kill switch defaulted to ON (sealed-room
 * enabled). The OFF path skips the `AND project_id = $projectId` clause
 * and reverts to ambient behavior for that table — an emergency knob for
 * staged rollout, never the default. See `isSealedRoomEnabledFor`.
 */

import type { ActorContext } from "@/lib/authz/actor-context";
import { AuthzError } from "@/lib/authz/errors";

// ---------------------------------------------------------------------------
// Sealed-room mode
// ---------------------------------------------------------------------------

export type SealedRoomMode = "ambient" | "project";

/**
 * Classify a list request as "ambient" (no project filter) or "project"
 * (filter to a single project). Pure — no I/O, no SQL.
 *
 * Callers pass `input.projectId` straight through after `assertProjectReadAccess`
 * succeeds. A null / undefined / blank string projectId is ambient.
 */
export function resolveSealedRoomMode(input: {
  projectId?: string | null;
}): SealedRoomMode {
  const v = input.projectId;
  if (typeof v !== "string") return "ambient";
  return v.trim().length > 0 ? "project" : "ambient";
}

// ---------------------------------------------------------------------------
// assertProjectReadAccess (404-hidden authorization gate)
// ---------------------------------------------------------------------------

/**
 * Gate every project-scoped list at the handler boundary.
 *
 * Throws AuthzError({statusCode:404,reason:"hidden"}) if the actor has no
 * read+ grant on `projectId` AND is NOT a platform admin. 404-hidden
 * (not 403) is deliberate per the AuthzError doctrine
 * (src/lib/authz/errors.ts:18): a project the actor has no grant on must
 * not be revealed to exist. 403 would leak presence; 404-hidden is
 * indistinguishable from "no such project".
 *
 * The check consults `actor.projectGrants` — the canonical axis resolved
 * from owned and accessed project grants, with role by authority.
 * `actor.projectGrants === undefined` means "not resolved"
 * (legacy sync `buildActorContext` callers, see
 * `src/lib/authz/actor-context.ts`); in that case the actor is treated
 * as having NO grants — the helper fails closed.
 *
 * Platform admin bypass: a platform_admin reads across every project
 * without an explicit grant. This mirrors the established admin bypass
 * pattern (e.g. `agent_run_list` skipOrgFilter when admin+no-active-org).
 */
export function assertProjectReadAccess(
  actor: ActorContext | { projectGrants?: ActorContext["projectGrants"]; platformRole?: ActorContext["platformRole"] } | undefined,
  projectId: string,
): void {
  if (!actor) {
    throw new AuthzError({
      statusCode: 404,
      reason: "hidden",
      message: "Project not found",
    });
  }
  if (actor.platformRole === "platform_admin") return;
  const grants = actor.projectGrants;
  if (Array.isArray(grants) && grants.some((g) => g.projectId === projectId)) {
    return;
  }
  throw new AuthzError({
    statusCode: 404,
    reason: "hidden",
    message: "Project not found",
  });
}

// ---------------------------------------------------------------------------
// Per-table feature flags
// ---------------------------------------------------------------------------

/**
 * Table identifier for the per-table sealed-room kill switches.
 * "artifacts" reads through `objects` but is split into its own
 * flag because the artifact list MCP surface is independently togglable
 * (e.g. roll out sealed-room artifacts behind a flag while keeping
 * generic objects on).
 */
export type SealedRoomTable =
  | "objects"
  | "agent_runs"
  | "chat_threads"
  | "artifacts";

/**
 * Env-driven kill switch per sealed-room table. Default TRUE (sealed-room ON).
 * Set the corresponding env var to the literal string `"false"` to
 * disable sealed-room for that table — the SQL `AND project_id = $P`
 * clause is then skipped and listings revert to ambient behavior for
 * that table.
 *
 * Env vars:
 *   CINATRA_SEALED_ROOM_OBJECTS
 *   CINATRA_SEALED_ROOM_AGENT_RUNS
 *   CINATRA_SEALED_ROOM_CHAT_THREADS
 *   CINATRA_SEALED_ROOM_ARTIFACTS
 *
 * Any value other than the literal "false" (case-insensitive) leaves the
 * gate ENABLED. This is asymmetric on purpose — accidentally setting the
 * env to "0", "no", "off", etc. must NOT silently disable a security
 * filter. The only way to turn the gate off is the unambiguous literal
 * "false".
 */
export function isSealedRoomEnabledFor(table: SealedRoomTable): boolean {
  const envName = (() => {
    switch (table) {
      case "objects":
        return "CINATRA_SEALED_ROOM_OBJECTS";
      case "agent_runs":
        return "CINATRA_SEALED_ROOM_AGENT_RUNS";
      case "chat_threads":
        return "CINATRA_SEALED_ROOM_CHAT_THREADS";
      case "artifacts":
        return "CINATRA_SEALED_ROOM_ARTIFACTS";
    }
  })();
  const raw = process.env[envName];
  if (typeof raw === "string" && raw.trim().toLowerCase() === "false") {
    return false;
  }
  return true;
}

/**
 * Convenience: returns the projectId to use as a SQL filter parameter
 * for the given table, OR null when the gate is off / ambient mode.
 *
 * Centralizes the "ambient vs project + flag" decision so each store
 * function has a one-line:
 *
 *   const effectiveProjectId = sealedRoomFilterValue(table, filter.projectId);
 *   if (effectiveProjectId !== null) { ...append AND project_id = $... }
 *
 * The store function never has to import `resolveSealedRoomMode` /
 * `isSealedRoomEnabledFor` directly; it consults this single helper.
 */
export function sealedRoomFilterValue(
  table: SealedRoomTable,
  projectId: string | null | undefined,
): string | null {
  if (!isSealedRoomEnabledFor(table)) return null;
  const mode = resolveSealedRoomMode({ projectId: projectId ?? null });
  if (mode === "ambient") return null;
  // Mode is "project" — projectId is guaranteed a non-blank string by
  // resolveSealedRoomMode's trim+length check.
  return (projectId as string).trim();
}
