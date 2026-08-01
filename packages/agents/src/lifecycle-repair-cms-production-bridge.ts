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
import {
  attemptRepairedCapture,
  leavesUncapturedSide,
  type CmsRepairedCaptureAttempt,
} from "./cms-repaired-capture-port";

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
  /** The `repaired` picture was pinned against the successor target — the
   * repair pair renders both halves (cinatra#2044 / #2046's visual row). */
  repairedCaptured: number;
  /** The capture failed for a NAMED reason AND that reason was pinned as a
   * degraded record: the successor gate states the gap. */
  repairedCaptureDegraded: number;
  /** No CONFIRMED picture the successor gate can be shown to carry: no port
   * bound, the port threw, a record was pinned without a reason, the capture
   * outran its ceiling (never cancelled, so that class may still land), or the
   * picture is pinned to a target the settled repair row does not name as its
   * successor (a concurrent completion won with a different production write).
   * Counted all the same, because a picture nothing can verify must reach ops.
   * The successor gate may render a causeless one-sided pair — always logged,
   * never silent. */
  repairedCaptureMissing: number;
}

/**
 * REPORT — emitted the instant the capture attempt returns, BEFORE the repair
 * response is submitted (a codex round-3 finding). The counters below are
 * in-memory and are only folded after `submitRepairResponse` COMMITS, so a
 * process death in that window used to lose the only account of a repair that
 * completed durably with no picture — reinstating, in a narrower window,
 * exactly the silence cinatra#2044's negative proof caught. Emitting here means
 * the incident is on the record before anything durable can outlive it.
 *
 * Says nothing about a successor gate CONDITIONALLY, because at this point none
 * exists yet and the response may still be rejected: the subject is the picture.
 * Never throws.
 */
export function reportRepairedCaptureIncident(
  repairId: string,
  attempt: CmsRepairedCaptureAttempt,
): void {
  // Two guards, not one: `leavesUncapturedSide` answers the QUESTION but is not
  // a type predicate (its `false` does not imply `captured` — a recorded degrade
  // answers false too), so the `captured` arm is excluded explicitly to reach
  // the cause fields below.
  if (attempt.outcome === "captured" || !leavesUncapturedSide(attempt)) return;
  // The ceiling class is UNCONFIRMED, not known-missing: a capture that outran
  // its wall-clock ceiling was never cancelled and may still pin the picture. It
  // is still escalated — an unverifiable picture must reach ops — but claiming
  // the gate WILL be one-sided would be a statement this code cannot make (a
  // codex convergence finding).
  const unconfirmed = attempt.outcome === "degraded" && attempt.reason === "capture-timeout";
  const why =
    attempt.outcome === "unavailable"
      ? "no host capture port is bound in this process (boot phase `bind-cms-review-host-seam`)"
      : attempt.outcome === "failed"
        ? `the capture port threw: ${attempt.error}`
        : unconfirmed
          ? "the capture outran its wall-clock ceiling, so nothing was recorded and it may yet land"
          : `the capture degraded (${attempt.reason}) without recording it`;
  // Phrased as a CONDITIONAL about this target, not a prediction about a gate:
  // the response has not been submitted yet (it may still be rejected, leaving
  // no gate at all) and a concurrent completion may win with a different target
  // (leaving a gate this attempt says nothing about). What IS true right now is
  // the statement below (a codex round-4 finding).
  console.error(
    `[lifecycle-repair-cms-production-bridge] no confirmed \`repaired\` picture for repair ${repairId} — ${why}; ` +
      `a successor gate pinned to this target ${unconfirmed ? "may" : "will"} show an uncaptured side.`,
  );
}

/**
 * COUNT — fold one repaired-capture attempt into the drain's counters, once the
 * successor gate actually exists. The loud classes were already reported by
 * `reportRepairedCaptureIncident` before the commit, so this only counts them.
 * Never throws.
 *
 * `pinnedToSuccessor` is the caller's proof that the picture this attempt took
 * is bound to the target the repair row NOW records as its successor.
 * `submitRepairResponse` is IDEMPOTENT: an already-repaired repair returns its
 * EXISTING successor gate without checking the caller's target, so a concurrent
 * completion that won with a different production write would otherwise let this
 * attempt's `ok` be read as confirmation for a gate this picture is not pinned
 * to (a codex round-3 finding). A mismatch is counted as MISSING — not because
 * the gate is known to be one-sided (the winner may well have pinned its own
 * picture), but because nothing here can verify that it is not.
 */
export function recordRepairedCaptureOutcome(
  summary: CmsRepairCompletionSummary,
  repairId: string,
  attempt: CmsRepairedCaptureAttempt,
  pinnedToSuccessor: boolean,
): void {
  if (!pinnedToSuccessor) {
    summary.repairedCaptureMissing += 1;
    // Says only what is known: this completion CAPTURED AGAINST a target the
    // settled repair does not name. It must not say a picture "was pinned" —
    // an `unavailable`/`failed` attempt pinned nothing at all (a codex round-4
    // finding) — nor that the gate is one-sided, since the winning completion
    // may well have pinned its own. A second line for an attempt that also
    // failed is deliberate: two independent faults, two facts worth having.
    console.error(
      `[lifecycle-repair-cms-production-bridge] the \`repaired\` capture for repair ${repairId} was taken against a ` +
        `target the settled repair does not name as its successor (a concurrent completion won with a different ` +
        `production write, the repair row moved, or it could not be re-read) — this completion cannot verify that ` +
        `gate has a picture.`,
    );
    return;
  }
  if (attempt.outcome === "captured") {
    summary.repairedCaptured += 1;
    return;
  }
  if (leavesUncapturedSide(attempt)) {
    // Already reported above, pre-commit — counted here, never logged twice.
    summary.repairedCaptureMissing += 1;
    return;
  }
  // Degraded AND recorded: the gate itself carries the named reason.
  summary.repairedCaptureDegraded += 1;
  console.warn(
    `[lifecycle-repair-cms-production-bridge] the \`repaired\` picture for repair ${repairId} degraded: ${
      attempt.outcome === "degraded" ? attempt.reason : "unknown"
    } (the successor gate states the gap).`,
  );
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
    repairedCaptured: 0,
    repairedCaptureDegraded: 0,
    repairedCaptureMissing: 0,
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

      // THE THIRD PICTURE (cinatra#2044 / #2046). Taken BEFORE the response is
      // submitted, because `submitRepairResponse` is what emits the successor
      // gate: capturing first means the repair pair's right-hand side exists the
      // moment a reviewer can first open that gate, instead of a window in which
      // it honestly-but-needlessly reads "never captured". Bounded and
      // non-blocking — whatever it reports, the repair still completes.
      const capture = await attemptRepairedCapture({
        orgId: repair.orgId,
        successorTarget: {
          artifactId: production.artifactId,
          representationRevisionId: production.representationRevisionId,
        },
        baseTarget: {
          artifactId: repair.baseArtifactId,
          representationRevisionId: repair.baseRepresentationRevisionId,
        },
        title: `Repaired ${baseTarget.resourceType}`,
        // The accountable human re-verified live above — never the system
        // dispatcher authority (the PR2 principal fix).
        createdBy: delivered.originatingRunBy ?? null,
        producerRunId: runId,
      });
      // REPORTED BEFORE THE COMMIT. The counters below are in-memory and are
      // folded only after `submitRepairResponse` durably lands; a crash in that
      // window would leave a completed repair — no longer `dispatched`, so never
      // re-drained — with nothing anywhere accounting for its missing picture (a
      // codex round-3 finding). The incident goes on the record first.
      reportRepairedCaptureIncident(repair.id, capture);

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

      if (result.ok) {
        summary.completed += 1;
        // Accounted for ONLY here (a codex convergence finding): these counters
        // and their escalation are statements about the SUCCESSOR GATE, and
        // `submitRepairResponse` is what creates it. A rejection leaves no gate
        // that could be one-sided, so saying anything about one would be false —
        // and how the repair proceeds from there is the repair store's business,
        // not this counter's (a stale/tombstoned lineage moves it to `stale`; the
        // other rejection codes leave it for a later drain, which re-captures and
        // reuses whatever this attempt already pinned, the write being immutable).
        //
        // `ok` alone is NOT proof this attempt's picture belongs to the gate that
        // now exists: `submitRepairResponse` is idempotent and returns an
        // already-repaired repair's EXISTING successor gate without checking this
        // caller's target, so a concurrent completion that won with a different
        // production write would make that `ok` describe a gate this picture is
        // not pinned to (a codex round-3 finding). Re-read the settled row and let
        // the counter speak only for the target the repair itself now names.
        //
        // CONTAINED, because it runs AFTER `summary.completed` was incremented
        // for a repair that has already durably landed: letting it throw would
        // reach the row's `catch` and count the SAME repair as both `completed`
        // and `failed` (a codex round-4 finding). A read that fails simply
        // cannot verify the binding, which is the fail-closed answer already.
        let pinnedToSuccessor = false;
        try {
          const settled = await readRepair(repair.id);
          pinnedToSuccessor =
            settled?.successorArtifactId === production.artifactId &&
            settled?.successorRepresentationRevisionId === production.representationRevisionId;
        } catch (err) {
          console.warn(
            `[lifecycle-repair-cms-production-bridge] could not re-read repair ${repair.id} to verify its successor ` +
              `binding: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        recordRepairedCaptureOutcome(summary, repair.id, capture, pinnedToSuccessor);
      } else summary.unresolved += 1;
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
