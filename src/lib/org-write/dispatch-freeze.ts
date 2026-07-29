import "server-only";
import { sql } from "drizzle-orm";
import { rowsOf } from "@cinatra-ai/org-write-kernel";
import { betterAuthDb } from "@/lib/better-auth-db";

/**
 * cinatra#1940 (P3) — the dispatch-freeze leaf module.
 *
 * Layered model (Decision 1 of .claude/scratch/r-1940/DESIGN.md): the kernel
 * is the ENFORCEMENT layer — `run.execute`/`run.complete` are ruled
 * deny/lease-gated for an archived org since #1939 wave 2/3, and #1940 P3
 * converts the two `agent_runs` creation entry points onto that ruling
 * (`createAgentRun` / `createAgentRunPendingInput`, now guarded). Everything
 * in THIS module is a PRE-CHECK — routing/UX only, deliberately fail-OPEN on
 * a read error or an unknown state: a pre-check read failure falls through to
 * the kernel/backstop, it never fabricates a refusal. Duplicating fail-closed
 * reads at every dispatch call site would add new availability failure modes
 * for zero additional security value — the write-time guard is the actual
 * backstop everywhere this module is consulted.
 */

/**
 * Compile-time structural coupling (Decision 7 / codex r0 #19): this const's
 * only purpose is to be IMPORTED by `src/lib/organization-archive.ts`'s
 * activation gate, so no build can evaluate `isArchiveActivationEnabled()`
 * without also containing the dispatch freeze. A module-graph test pins the
 * import edge so a future refactor that drops it fails CI here — independent
 * of the S6 activation runbook.
 */
export const DISPATCH_FREEZE_S3 = true as const;

/**
 * One pooled, advisory (NO lock) read of the organization's `archivedAt`
 * column. Returns `null` on any read error OR a missing organization row —
 * every caller MUST treat `null` as "unknown → proceed to the kernel
 * backstop", never as a refusal. This is deliberately not the enforcement
 * point (see module doc above).
 */
export async function readOrgArchivedAtForDispatch(
  orgId: string,
): Promise<boolean | null> {
  try {
    const result = await betterAuthDb.execute(
      sql`SELECT "archivedAt" FROM public."organization" WHERE id = ${orgId}`,
    );
    const rows = rowsOf(result);
    if (rows.length !== 1) return null;
    const archivedAt = rows[0]?.archivedAt;
    return archivedAt !== null && archivedAt !== undefined;
  } catch (err) {
    console.warn(
      "[dispatch-freeze] readOrgArchivedAtForDispatch read failed (treating as unknown, proceeding to the kernel backstop):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** The five dispatch surfaces this design's acceptance map covers. */
export type DispatchFreezeSurface =
  | "run-creation"
  | "enqueue"
  | "trigger-release"
  | "worker-start"
  | "content-editor";

/**
 * Typed refusal surfaced to a caller when the org is determined archived —
 * by a pre-check in this module, OR by a caller mapping the kernel's
 * `OrgWriteRefusedError("capability-denied")` backstop onto the same typed
 * shape. The message is product-clear (safe to show a user/connector
 * directly, per Decision 1).
 */
export class OrganizationArchivedDispatchError extends Error {
  readonly code = "ORG_ARCHIVED_DISPATCH_REFUSED" as const;
  readonly orgId: string;
  readonly surface: DispatchFreezeSurface;

  constructor(orgId: string, surface: DispatchFreezeSurface) {
    super("This organization is archived — agents cannot start new work.");
    this.name = "OrganizationArchivedDispatchError";
    this.orgId = orgId;
    this.surface = surface;
  }
}
