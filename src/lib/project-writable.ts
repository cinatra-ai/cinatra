import "server-only";

/**
 * `assertProjectWritable` helper.
 *
 * Single chokepoint for the project-side write-block predicate used by
 * every D1 inheritance write, D2 move target check, and binding mutate
 * entry point. The helper composes three orthogonal checks:
 *
 *   1. Project EXISTS (404-hidden when missing — never reveal the
 *      requested id is a known/unknown row).
 *   2. Project is NOT archived (archived
 *      projects are read-only / move-out-only; every new write rejects).
 *   3. Actor has the requested role tier (`read` < `write` < `admin`)
 *      via `actor.projectGrants` — the canonical project-access axis.
 *
 * The platform_admin role bypasses checks 2 and 3 ONLY when the project
 * exists. Archived rows still reject for non-admins, but admins can
 * still write to an archived project for moderation / incident response
 * (mirrors the kernel admin bypass pattern at `enforce.ts:67`).
 *
 * The helper is fail-closed by default:
 *   - Missing actor              → 404-hidden (treat as no-session).
 *   - Missing/unresolved grants  → 403 forbidden (session-derived actors
 *                                  should never leave grants unresolved;
 *                                  session-derived actor; an undefined
 *                                  `projectGrants` axis means "legacy
 *                                  sync caller without project
 *                                  visibility" — deny rather than
 *                                  silently pass).
 *   - Insufficient role          → 403 forbidden.
 *   - Archived project           → 403 forbidden (NOT 404 — the row
 *                                  exists, the actor knows it exists
 *                                  from their grant; 403 is the correct
 *                                  envelope for "exists but blocked").
 *
 * Move semantics and archive lifecycle writes gate their write paths
 * through this helper: archive writes set `archived_at`; this helper
 * reads it before allowing later writes.
 *
 * Read path (when `mode="read"`): the helper exists as a one-stop gate
 * for callers that need both "exists + not archived + has grant" in a
 * single check. For pure read-list paths use `assertProjectReadAccess`
 * from `@/lib/sealed-room` instead — that helper 404-hides without
 * the existence read (cheaper) and is the canonical entry for the
 * sealed-room contract.
 */

import { AuthzError } from "@/lib/authz/errors";
import type { ActorContext, ProjectGrant, ProjectRole } from "@/lib/authz/actor-context";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { ensurePostgresSchema, postgresSchema, getPostgresConnectionString } from "@/lib/database";

// ---------------------------------------------------------------------------
// Role rank — mirrors the projects MCP handler `PROJECT_ROLE_RANK`
// constant (assertProjectGrantRole). Kept duplicated rather than imported
// because that module is server-only and pulls in heavy MCP wiring; this
// helper must stay a leaf with minimal blast radius.
// ---------------------------------------------------------------------------

const PROJECT_ROLE_RANK: Record<ProjectRole, number> = {
  read: 0,
  write: 1,
  admin: 2,
  owner: 3,
};

const REQUIRED_ROLE_RANK: Record<"read" | "write" | "admin", number> = {
  read: 0,
  write: 1,
  admin: 2,
};

/**
 * Minimum actor shape: ActorContext is overkill for tests that build
 * synthetic actors; we accept any shape that carries `projectGrants` +
 * `platformRole`. The real ActorContext extends this naturally.
 */
type ActorLike = {
  projectGrants?: ProjectGrant[];
  platformRole?: ActorContext["platformRole"];
};

/**
 * Minimum project-row shape the helper reads. Injected via the
 * `readProjectRow` parameter so unit tests can stub the DB read without
 * touching `projects-store-dao` (which pulls in the live pg pool).
 *
 * Returning `null` means "project does not exist" — the helper throws
 * 404-hidden in that case.
 */
export type WritableProjectRow = {
  id: string;
  archivedAt: Date | null;
};

export type ReadProjectRow = (
  projectId: string,
) => Promise<WritableProjectRow | null>;

/**
 * Default row-reader: delegates to `readProjectById` and projects the
 * shape down to `{id, archivedAt}`. Kept as a lazy require so unit
 * tests that mock `@/lib/postgres-sync` / `@/lib/database` don't have
 * to also mock the live pg pool just to import this module.
 */
async function defaultReadProjectRow(
  projectId: string,
): Promise<WritableProjectRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dao = require("@/lib/projects-store-dao") as typeof import("@/lib/projects-store-dao");
  const row = await dao.readProjectById(projectId);
  if (!row) return null;
  // The current ProjectRecord shape (drizzle binding in projects-store.ts)
  // doesn't yet declare archivedAt.
  // Project off a duck-typed read of the underlying row so we don't need
  // to widen the binding here.
  const archivedAt = (row as unknown as { archivedAt?: Date | null }).archivedAt ?? null;
  return { id: row.id, archivedAt };
}

/**
 * Throw an AuthzError when `actor` cannot perform `mode` on `projectId`.
 *
 * Pure with respect to the SUT: every I/O dependency is parameterised
 * via the optional `deps` argument so unit tests can supply a stub
 * row-reader. Production callers omit `deps` to get the default
 * `readProjectById`-backed reader.
 */
export async function assertProjectWritable(
  actor: ActorLike | undefined,
  projectId: string,
  mode: "read" | "write" | "admin",
  deps?: { readProjectRow?: ReadProjectRow },
): Promise<void> {
  // ----- step 0: actor envelope (mirror assertProjectReadAccess shape)
  if (!actor) {
    throw new AuthzError({
      statusCode: 404,
      reason: "hidden",
      message: "Project not found",
    });
  }

  // ----- step 1: existence (404-hide if missing)
  const read = deps?.readProjectRow ?? defaultReadProjectRow;
  const row = await read(projectId);
  if (!row) {
    throw new AuthzError({
      statusCode: 404,
      reason: "hidden",
      message: "Project not found",
    });
  }

  // ----- step 2: archived gate
  // platform_admin bypass: admins may still touch archived projects for
  // moderation / incident response (mirrors `enforce.ts:67`).
  const isPlatformAdmin = actor.platformRole === "platform_admin";
  if (row.archivedAt !== null && !isPlatformAdmin) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `Project is archived; new writes rejected (${projectId})`,
    });
  }

  // ----- step 3: role gate
  // platform_admin bypass for the role check too.
  if (isPlatformAdmin) return;

  const grants: ProjectGrant[] = Array.isArray(actor.projectGrants)
    ? actor.projectGrants
    : [];
  const grant = grants.find((g) => g.projectId === projectId);
  if (!grant) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `No project_access for ${projectId}`,
    });
  }
  const have = PROJECT_ROLE_RANK[grant.effectiveRole];
  const need = REQUIRED_ROLE_RANK[mode];
  if (have < need) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `Requires ${mode}; have ${grant.effectiveRole}`,
    });
  }
}

/**
 * Synchronous archive gate for sync writers.
 *
 * The canonical write paths inside an agent run's projectContext frame
 * (`upsertObjectAndEnqueue`, `upsertObject`, artifact-creation's
 * semantic-artifact INSERT) are all SYNCHRONOUS — they bridge through
 * the postgres-sync worker so the host-app's async hooks (the
 * mcpRequestContextStorage frame, the agentic-run's projectContext) are
 * preserved across the write. We cannot `await` an async row read in
 * those paths without breaking the frame propagation.
 *
 * `assertProjectWritableSync` reads `projects.archived_at` via the
 * postgres-sync worker (the same channel the writer uses) and rejects
 * when the target project is archived. It DOES NOT check the role gate
 * — write-time inheritance is gated upstream by the
 * handler's `enforceResourceAccess`, which already verified the actor
 * holds object.update / object.write. The archive check is the new
 * archive check: even a permitted writer is blocked when the target
 * project is archived.
 *
 * Implementation note: the sync writer paths (upsertObjectAndEnqueue,
 * artifact-creation) are ALREADY inside a synchronous context. Adding
 * one more sync postgres-sync call adds one round trip. That's
 * acceptable — write-time archive check is rare (only fires when a
 * project frame is active AND the project happens to be archived,
 * which is a misuse) and the SELECT is partial-indexed.
 */
export function assertProjectWritableSync(projectId: string): void {
  ensurePostgresSchema();
  const schema = postgresSchema.replaceAll('"', '""');
  const [result] = runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [
      {
        text: `SELECT id, archived_at FROM "${schema}"."projects" WHERE id = $1 LIMIT 1`,
        values: [projectId],
      },
    ],
  });
  const row = result?.rows?.[0] as
    | { id?: unknown; archived_at?: Date | null }
    | undefined;
  if (!row || typeof row.id !== "string") {
    // Frame referenced an unknown project — fail-closed. Belt-and-braces
    // typeof guard so a sibling mock that returns a non-project row
    // shape (e.g. an object row, which has `id` but no `archived_at`)
    // doesn't pass through as "project exists, active" — that would
    // silently DISABLE the gate in tests that share a mock with both
    // the project read and a sibling row read.
    throw new AuthzError({
      statusCode: 404,
      reason: "hidden",
      message: `Project not found: ${projectId}`,
    });
  }
  // Treat both null and undefined as "active" — production reads
  // return null for the column; legacy callers may not project it.
  const archivedAt = row.archived_at ?? null;
  if (archivedAt !== null) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `Project is archived; new writes rejected (${projectId})`,
    });
  }
}

/**
 * Synchronous variant for hot-path call sites that need to gate inside
 * a transaction we've already opened (e.g. the move SQL composes
 * SELECT FOR UPDATE + UPDATE in one runPostgresQueriesSync transaction
 * — we can't await an async row read between those queries).
 *
 * Caller supplies the project row directly (already fetched as part of
 * the tx). The helper still performs the archived + role checks.
 */
export function assertProjectWritableForRow(
  actor: ActorLike | undefined,
  row: WritableProjectRow,
  mode: "read" | "write" | "admin",
): void {
  if (!actor) {
    throw new AuthzError({
      statusCode: 404,
      reason: "hidden",
      message: "Project not found",
    });
  }
  const isPlatformAdmin = actor.platformRole === "platform_admin";
  if (row.archivedAt !== null && !isPlatformAdmin) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `Project is archived; new writes rejected (${row.id})`,
    });
  }
  if (isPlatformAdmin) return;
  const grants: ProjectGrant[] = Array.isArray(actor.projectGrants)
    ? actor.projectGrants
    : [];
  const grant = grants.find((g) => g.projectId === row.id);
  if (!grant) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `No project_access for ${row.id}`,
    });
  }
  const have = PROJECT_ROLE_RANK[grant.effectiveRole];
  const need = REQUIRED_ROLE_RANK[mode];
  if (have < need) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `Requires ${mode}; have ${grant.effectiveRole}`,
    });
  }
}
