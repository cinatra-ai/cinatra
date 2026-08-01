/**
 * The FORCE-DELETE run pre-clean, extracted from `store.ts` (cinatra#1705 AC9).
 *
 * Split out because the file-size ratchet on `store.ts` is a one-way ceiling and
 * this is exactly the vertical slice it asks for: one destructive helper, its
 * long "do not use this" rationale, and the run-id capture the execution-plane
 * teardown depends on. It reaches only `./db` and `./schema`, so nothing here
 * imports `store.ts` and no cycle is possible.
 */

import { eq, desc, sql } from "drizzle-orm";

import { db } from "./db";
import {
  agentForks,
  agentRegistryEntries,
  agentRuns,
  agentTemplateVersions,
  agentVersions,
} from "./schema";

// ---------------------------------------------------------------------------
// Destructive helper used ONLY by extensionRegistry
// .forceDelete(...) to satisfy the RESTRICT FKs that block raw template
// deletes. Removes every row whose FK targets the given template_id across:
//   - agent_runs.template_id
//   - agent_versions.template_id
//   - agent_template_versions.template_id
//   - agent_registry_entries.template_id
//   - agent_forks.forked_template_id
// Returns counts per table for audit/log visibility (caller may discard).
//
// IMPORTANT: this is the ONLY supported way to bypass the RESTRICT FKs added
// by the schema. Provenance is preserved by the
// extension_lifecycle_audit row that forceDelete writes BEFORE calling this
// helper — that audit row's destroyed_row_snapshot + dangling_references
// fields capture what was about to be removed. Direct callers outside the
// force-delete escape hatch will silently destroy run history; do not use
// this helper for any other purpose.
//
// The five deletes are wrapped in a single
// Drizzle transaction so they commit atomically. Without this, a partial
// failure (e.g. lock-timeout on delete #3) would commit deletes #1 and #2
// while leaving #3-#5 intact, and the audit row already written above would
// say "destroyed" — operators would have no signal that destruction was
// partial. There is still a small INSERT race window between this helper
// returning and handler.uninstall (which calls deleteAgentTemplate) —
// a concurrent INSERT into agent_runs referencing the same template_id
// would re-block the template delete with SQLSTATE 23503. That race is
// documented as an admin-only escape-hatch limitation; concurrent traffic
// against a force-delete target is unlikely in practice.
// ---------------------------------------------------------------------------
/**
 * Bound on the run ids a destructive lifecycle step reports back for
 * execution-plane teardown (epic #1705 AC9).
 *
 * WHY A BOUND AT ALL: the teardown drives ONE broker call per id, and in the
 * managed placement each of those is an mTLS RPC. An admin force-deleting a
 * package with half a million historical runs must not turn one lifecycle
 * operation into half a million round trips — that is a worse failure than the
 * residual this cap leaves.
 *
 * WHY THE RESIDUAL IS THE RIGHT ONE: the ids are read MOST RECENT FIRST, and
 * live plane state does not survive long enough to belong to an old run — an
 * open job is idle-reaped, and a retained workspace is reaped by the retention
 * GC. So the ids this cap drops are, by construction, the ones that cannot have
 * a sandbox job or a workspace to collect. What it drops is the tail that was
 * already collected, never the head that still holds something.
 *
 * And the residual is not "nothing happens" in any case: a job bound to a
 * deleted run still fails its next command closed on the liveness probe, and
 * the retention GC still reaps the volume. The cap costs immediacy, not
 * eventual correctness. Truncation is REPORTED, never silent.
 */
export const MAX_REPORTED_TEARDOWN_RUN_IDS = 5_000;

export async function removeReferencingRunRows(
  templateId: string,
): Promise<{
  agent_runs: number;
  agent_versions: number;
  agent_template_versions: number;
  agent_registry_entries: number;
  agent_forks: number;
  /**
   * The ids of the agent_runs this call DELETED, read inside the same
   * transaction (epic #1705 AC9). The extension data-teardown hook fires AFTER
   * these rows are gone, so a participant that needs to know which runs the
   * package owned cannot look them up itself — it has to be told. Capped at
   * `MAX_REPORTED_TEARDOWN_RUN_IDS`; `runIdsTruncated` says so.
   */
  runIds: string[];
  runIdsTruncated: boolean;
}> {
  // Order matters: child rows (agent_runs, agent_run_messages, etc.) are
  // already FK-cascaded from agent_runs in the schema. We delete the FK
  // sources to agent_templates here. agent_runs deletion will cascade-delete
  // its own children (run_messages, hitl_prompts, run_co_owners, etc.).
  return await db.transaction(async (tx) => {
    // Clean up polymorphic
    // `extension_co_owners` + `extension_access_policy` rows for every
    // agent_run we're about to drop. The polymorphic tables have no FK
    // (one FK can't span multiple kind-specific resource tables), so the
    // app layer must do the cleanup BEFORE the agent_runs delete (after
    // would leave us with no way to find which run IDs to clean up).
    // Best-effort: log + continue on failure rather than abort the whole
    // force-delete.
    const schemaForCleanup = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
    try {
      await tx.execute(sql.raw(
        `DELETE FROM "${schemaForCleanup.replaceAll('"', '""')}"."extension_co_owners"
         WHERE resource_kind = 'agent_run'
           AND resource_id IN (
             SELECT id FROM "${schemaForCleanup.replaceAll('"', '""')}"."agent_runs"
             WHERE template_id = '${templateId.replaceAll("'", "''")}'
           )`,
      ));
      await tx.execute(sql.raw(
        `DELETE FROM "${schemaForCleanup.replaceAll('"', '""')}"."extension_access_policy"
         WHERE resource_kind = 'agent_run'
           AND resource_id IN (
             SELECT id FROM "${schemaForCleanup.replaceAll('"', '""')}"."agent_runs"
             WHERE template_id = '${templateId.replaceAll("'", "''")}'
           )`,
      ));
    } catch (err) {
      console.warn(
        "[agents/store] polymorphic extension_co_owners/policy cleanup for force-delete agent_runs failed:",
        err instanceof Error ? err.message : err,
      );
    }
    // Read the ids BEFORE the delete, inside this same transaction — the
    // execution-plane teardown participant cannot look them up afterwards
    // (cinatra#1705 AC9). One id over the cap tells us truncation happened.
    const doomedRuns = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.templateId, templateId))
      // MOST RECENT FIRST — see MAX_REPORTED_TEARDOWN_RUN_IDS: what the cap
      // drops is the tail whose plane state is already gone.
      .orderBy(desc(agentRuns.createdAt))
      .limit(MAX_REPORTED_TEARDOWN_RUN_IDS + 1);
    const runIdsTruncated = doomedRuns.length > MAX_REPORTED_TEARDOWN_RUN_IDS;
    const runIds = doomedRuns
      .slice(0, MAX_REPORTED_TEARDOWN_RUN_IDS)
      .map((row) => row.id);
    const runsResult = await tx
      .delete(agentRuns)
      .where(eq(agentRuns.templateId, templateId));
    const versionsResult = await tx
      .delete(agentVersions)
      .where(eq(agentVersions.templateId, templateId));
    const templateVersionsResult = await tx
      .delete(agentTemplateVersions)
      .where(eq(agentTemplateVersions.templateId, templateId));
    const registryEntriesResult = await tx
      .delete(agentRegistryEntries)
      .where(eq(agentRegistryEntries.templateId, templateId));
    const forksResult = await tx
      .delete(agentForks)
      .where(eq(agentForks.forkedTemplateId, templateId));
    return {
      agent_runs: runsResult.rowCount ?? 0,
      agent_versions: versionsResult.rowCount ?? 0,
      agent_template_versions: templateVersionsResult.rowCount ?? 0,
      agent_registry_entries: registryEntriesResult.rowCount ?? 0,
      agent_forks: forksResult.rowCount ?? 0,
      runIds,
      runIdsTruncated,
    };
  });
}
