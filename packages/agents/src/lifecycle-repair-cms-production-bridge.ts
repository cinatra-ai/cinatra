import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-repair-cms-production-bridge (cinatra#2286, epic S10 PR2)
//
// The CMS-GENERIC half of the delivered-repair execution bridge. Under Path 2
// (a repairing producer's own template IS the repair handler — see the design's
// §2), there is no per-package "repair handler" registration to speak of: a
// repairing producer just answers a normal dispatched run, whose LLM-driven
// graph re-edits the target through its own tool call (which, for a CMS
// producer, re-drives the connector's `evaluateStagedContentWrite` capture path
// and stages/holds — it never writes to the remote CMS directly). What core
// supplies here is the CMS-GENERIC glue either side of that run:
//
//   • TASK CONSTRUCTION — given the `DeliveredRepairRequest`
//     (`lifecycle-repair-dispatch-store.ts`), resolve the CMS-snapshot target
//     row the base target is bound to (connector instance, resource type, the
//     CMS resource id) and synthesize a plain-text task the repair run's own
//     graph reads as its instruction. A NO-OP (`{}`) for any base target that
//     is not itself a captured CMS snapshot (e.g. the blog pipeline's own
//     markdown artifacts) — this module never widens what a non-CMS producer's
//     dispatch carries.
//   • COMPLETION ADAPTER — once a dispatched CMS repair run reaches a terminal
//     status, look for the CMS-snapshot capture it produced (keyed on
//     `producerRunId == the repair run's own id`, matched against the base
//     target's resource identity) and submit it as the repair response via
//     `submitRepairResponse`. If the run finished with no matching capture (the
//     agent didn't manage a matching write, or wrote something unrelated) the
//     repair stays `dispatched` — ops-visible, never silently finalized wrong.
//
// ROLE-GENERIC, not WordPress-specific: everything here reads only core's own
// `artifact_produced_outbox` / `cms_snapshot_targets` rows — never a package
// name — so it works unchanged for a future drupal-agent producer (design §4).
//
// INERT today: this bridge only ever sees a repair whose route already
// resolved to `producer_repair`, which — until an extension declares
// `cinatra.lifecycle.repairCapable` AND cinatra's pin advances past that
// declaration — never happens in production (§2's activation-ordering note).
// ---------------------------------------------------------------------------

import { and, asc, desc, eq } from "drizzle-orm";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

import { db } from "./db";
import { agentRuns, artifactProducedOutbox, lifecycleRepair } from "./schema";
import { TERMINAL_RUN_STATUSES, type AgentRunStatus } from "./run-status";
import { readRepair, submitRepairResponse } from "./lifecycle-repair-store";
import {
  readCmsSnapshotTargetByArtifact,
  readCmsSnapshotTargetByArtifactAndRevision,
  type CmsSnapshotTargetRow,
} from "./cms-snapshot-readback-store";
import { repairRunId, readDeliveredRepairRequest } from "./lifecycle-repair-dispatch-store";
import type { DeliveredRepairRequest } from "./lifecycle-repair-dispatch-store";

import { resolveOrgRoleForUser } from "@/lib/auth-session";

/** The CMS-snapshot capture emitter (mirrors `CMS_SNAPSHOT_EMITTER` in
 * `src/lib/artifacts/cms-content-snapshot-capture.ts`). Duplicated as a string
 * literal rather than imported so this agents-package leaf does not pull the
 * host's blob-store-backed capture writer into its module graph — both sides
 * are pinned by that host module's own capture test regressing on the literal. */
const CMS_SNAPSHOT_EMITTER = "object_cms_snapshot_capture";

// ---------------------------------------------------------------------------
// Task construction.
// ---------------------------------------------------------------------------

/**
 * Resolve the CMS-snapshot target row for a delivered repair's BASE target, if
 * its base is itself a captured CMS snapshot. Null for any other producer
 * (e.g. the blog pipeline) — the caller then leaves `inputParams` untouched.
 */
export async function resolveCmsRepairBaseTarget(
  delivered: Pick<DeliveredRepairRequest, "baseTarget">,
): Promise<CmsSnapshotTargetRow | null> {
  return readCmsSnapshotTargetByArtifact(delivered.baseTarget.artifactId);
}

/**
 * Synthesize the repair run's initial task text from the reviewer's structured
 * findings + the CMS resource identity being repaired. Pure. The exact prompt
 * wording is a lane/copy call (design §6, LANE-DECIDABLE) — a repairCapable
 * producer's own prompt is always free to read the structured
 * `lifecycleRepairRequest` directly instead of this string; this is a
 * reasonable default a producer's own PR (e.g. wordpress-agent) can override
 * or ignore.
 */
export function buildCmsRepairTaskText(
  delivered: Pick<DeliveredRepairRequest, "findings">,
  target: CmsSnapshotTargetRow,
): string {
  const findingLines = delivered.findings
    .map((f, i) => `${i + 1}. ${f.message}${f.path ? ` (field: ${f.path})` : ""}`)
    .join("\n");
  const resourceRef = target.resourceId ? ` (resource ${target.resourceId})` : "";
  return [
    `A reviewer requested changes to the ${target.resourceType}${resourceRef} you produced ` +
      `on connector instance ${target.connectorInstance}.`,
    "Apply the following requested changes and save the update:",
    findingLines,
  ].join("\n\n");
}

/**
 * Project the CMS-generic task-construction addition onto a dispatched repair
 * run's `inputParams`. Returns `{}` (no addition) when the delivered repair's
 * base target is not a captured CMS snapshot — byte-identical dispatch for the
 * blog pipeline and any future non-CMS repairing producer.
 */
export async function projectCmsRepairInputParams(
  delivered: DeliveredRepairRequest,
): Promise<Record<string, unknown>> {
  const target = await resolveCmsRepairBaseTarget(delivered);
  if (!target) return {};
  return { task: buildCmsRepairTaskText(delivered, target) };
}

// ---------------------------------------------------------------------------
// Completion adapter.
// ---------------------------------------------------------------------------

/** A minimal read-only projection of `objects` — liveness only (mirrors the
 * identical pattern in `lifecycle-review-orchestration-store.ts`; defined
 * locally so this leaf reads `objects.deleted_at` without depending on the
 * host objects-store drizzle table). A captured CMS-snapshot artifact is
 * immutable (one capture mints a FRESH artifact id — never a new revision in
 * place), so "the base's live current revision" reduces to: still not
 * tombstoned ⇒ its own captured revision; tombstoned/missing ⇒ null. */
const appSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");
const objectsLivenessRef = appSchema.table("objects", {
  id: text("id").primaryKey(),
  orgId: text("org_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

async function resolveCurrentBaseRevisionId(
  orgId: string,
  baseArtifactId: string,
  baseRepresentationRevisionId: string,
): Promise<string | null> {
  const [obj] = await db
    .select({ deletedAt: objectsLivenessRef.deletedAt })
    .from(objectsLivenessRef)
    .where(and(eq(objectsLivenessRef.id, baseArtifactId), eq(objectsLivenessRef.orgId, orgId)))
    .limit(1);
  if (!obj || obj.deletedAt) return null;
  return baseRepresentationRevisionId;
}

/** A produced CMS-snapshot capture matching a repair run's resource identity. */
interface MatchedCmsProduction {
  artifactId: string;
  representationRevisionId: string;
}

/**
 * Look for a CMS-snapshot capture the given repair run produced whose resource
 * identity (connector instance + resource type + resource id) matches the
 * repair's base target. Reads ONLY `artifact_produced_outbox` (already this
 * package's own table) + `readCmsSnapshotTargetByArtifact` — no host import,
 * no package name.
 */
async function findMatchingCmsProduction(
  producerRunId: string,
  baseTarget: Pick<CmsSnapshotTargetRow, "connectorInstance" | "resourceType" | "resourceId">,
): Promise<MatchedCmsProduction | null> {
  const rows = await db
    .select({
      artifactId: artifactProducedOutbox.artifactId,
      representationRevisionId: artifactProducedOutbox.representationRevisionId,
    })
    .from(artifactProducedOutbox)
    .where(
      and(
        eq(artifactProducedOutbox.producerRunId, producerRunId),
        eq(artifactProducedOutbox.emitter, CMS_SNAPSHOT_EMITTER),
      ),
    )
    .orderBy(desc(artifactProducedOutbox.createdAt));

  for (const row of rows) {
    // Scoped by BOTH the artifact id AND this outbox row's own
    // `representationRevisionId` — `readCmsSnapshotTargetByArtifact` alone
    // (artifact-only, `.limit(1)`) is ambiguous whenever one artifact carries
    // more than one `cms_snapshot_targets` row (e.g. a re-capture); matching
    // on the revision too guarantees the target row actually belongs to THIS
    // produced revision, not merely some row that happens to share the
    // artifact id.
    const target = await readCmsSnapshotTargetByArtifactAndRevision(
      row.artifactId,
      row.representationRevisionId,
    );
    if (
      target &&
      target.connectorInstance === baseTarget.connectorInstance &&
      target.resourceType === baseTarget.resourceType &&
      target.resourceId === baseTarget.resourceId
    ) {
      return { artifactId: row.artifactId, representationRevisionId: row.representationRevisionId };
    }
  }
  return null;
}

export interface CmsRepairCompletionSummary {
  scanned: number;
  /** A repair whose landed CMS capture was found and submitted. */
  completed: number;
  /** The repair run has not reached a terminal status yet — re-checked next pass. */
  pending: number;
  /**
   * A terminal run with no matching CMS-snapshot production, a `submitRepairResponse`
   * rejection (stale base, lineage mismatch, ...), or a live-reauthorization that no
   * longer verifies — the repair stays `dispatched`/open rather than silently
   * finalizing wrong; it is visible to ops via the existing `dispatched` status.
   */
  unresolved: number;
  failed: number;
}

/**
 * Complete every DISPATCHED `producer_repair` repair whose base target is a
 * captured CMS snapshot and whose repair run has produced a matching capture.
 * Best-effort + per-row isolated (mirrors `dispatchPendingProducerRepairs`):
 * a single row's failure never blocks the rest, and a row this drain does not
 * own (a non-CMS base target) is left untouched for its own producer's
 * completion path (e.g. the blog pipeline's inline `repairBlogPostDraft`).
 */
export async function completeDispatchedProducerCmsRepairs(opts?: {
  limit?: number;
}): Promise<CmsRepairCompletionSummary> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 25, 200));
  const summary: CmsRepairCompletionSummary = {
    scanned: 0,
    completed: 0,
    pending: 0,
    unresolved: 0,
    failed: 0,
  };

  const pendingIds = await db
    .select({ id: lifecycleRepair.id })
    .from(lifecycleRepair)
    .where(and(eq(lifecycleRepair.status, "dispatched"), eq(lifecycleRepair.route, "producer_repair")))
    .orderBy(asc(lifecycleRepair.createdAt))
    .limit(limit);

  for (const { id } of pendingIds) {
    summary.scanned += 1;
    try {
      const repair = await readRepair(id);
      // Vanished, or moved off `dispatched` under a concurrent pass — a later
      // pass reconciles; never treat a race as a failure.
      if (!repair || repair.status !== "dispatched") continue;

      const baseTarget = await resolveCmsRepairBaseTarget({
        baseTarget: {
          artifactId: repair.baseArtifactId,
          representationRevisionId: repair.baseRepresentationRevisionId,
        },
      });
      if (!baseTarget) {
        // Not a CMS repair — this completer is not the right one for it.
        continue;
      }

      const runId = repairRunId(repair.id);
      const production = await findMatchingCmsProduction(runId, baseTarget);
      if (!production) {
        const [run] = await db
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .limit(1);
        if (!run || TERMINAL_RUN_STATUSES.has(run.status as AgentRunStatus)) {
          // The run finished (or has vanished — a missing repair run can never
          // land a matching write, so treating it as "still running" would
          // leave the repair `pending` forever) but produced no matching
          // write. Leave the repair OPEN (dispatched) rather than silently
          // finalizing wrong — ops sees it via the existing `dispatched`
          // visibility.
          summary.unresolved += 1;
        } else {
          summary.pending += 1;
        }
        continue;
      }

      const delivered = await readDeliveredRepairRequest(runId);
      if (!delivered) {
        summary.unresolved += 1;
        continue;
      }

      // LIVE re-verification (cinatra#2286 S10 PR2, the principal fix) — the
      // SAME originating human `resolveOrgRoleForUser` verified at dispatch
      // time, re-checked NOW rather than trusted from the delivered request.
      // A membership revoked between dispatch and completion refuses the
      // finalize; the repair stays open (never a handler-asserted flag).
      const reauthorized = delivered.originatingRunBy
        ? Boolean(await resolveOrgRoleForUser(repair.orgId, delivered.originatingRunBy))
        : false;
      if (!reauthorized) {
        summary.unresolved += 1;
        continue;
      }

      const currentBaseRevisionId = await resolveCurrentBaseRevisionId(
        repair.orgId,
        repair.baseArtifactId,
        repair.baseRepresentationRevisionId,
      );

      const result = await submitRepairResponse({
        repairId: repair.id,
        currentBaseRevisionId,
        reauthorized: true,
        response: {
          gateId: repair.gateId,
          baseTarget: {
            artifactId: repair.baseArtifactId,
            representationRevisionId: repair.baseRepresentationRevisionId,
          },
          successorTarget: {
            artifactId: production.artifactId,
            representationRevisionId: production.representationRevisionId,
          },
          // The connector's tool call carries no per-finding "which one did I
          // fix" channel; every requested finding is reported applied. This is
          // an annotation, not a security boundary — the downstream read-back
          // verification (cinatra#2043 S5) is what actually validates the
          // produced fields against the scope manifest.
          findingOutcomes: repair.findings.map((f) => ({ findingId: f.id, applied: true })),
          changeSummary: `Producer applied ${repair.findings.length} requested change(s) via the CMS content connector.`,
          producerProvenance: { runId, agentId: null },
        },
      });

      if (result.ok) summary.completed += 1;
      else summary.unresolved += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[lifecycle-repair-cms-production-bridge] completion for repair ${id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return summary;
}
