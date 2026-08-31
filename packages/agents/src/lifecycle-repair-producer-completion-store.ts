import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-repair-producer-completion-store (cinatra#3080)
//
// THE OTHER HALF OF THE REGENERATE ROAD — the step the first capture found
// missing on the real surface.
//
// WHAT THE CAPTURE MEASURED. Pressing Regenerate settled the gate as superseded
// and minted a real repair run on the producing template, and then the road
// stopped: no revision was appended, no successor gate opened, and the review
// target was never re-pointed, while the settled panel told the reader "the
// review has moved on from it". The drawing says the opposite happens —
// "Regenerate sends the work back to be made again from the words in the note
// field, settles this gate as superseded, and raises its successor over the new
// revision", and the cards drawing draws that successor as "a fresh review card
// further down the thread" beneath the one marked superseded.
//
// A DISPATCHED REPAIR IS NOT A FINISHED ONE. `dispatchPendingProducerRepairs`
// delivers the typed request and starts the run; what turns that run's work into
// a SUCCESSOR is `submitRepairResponse`, which pins the repaired revision in a
// new gate and re-points the held effect onto it. Exactly one completer existed
// for that step and it owned CMS snapshots alone
// (`completeDispatchedProducerCmsRepairs`), skipping every repair whose base
// target is not a captured CMS resource — which is every blog draft, and every
// other producer core repairs. Those repairs sat `dispatched` forever with their
// production unclaimed, which is precisely the reading the capture photographed.
//
// This drain is the generic completer. It mirrors the CMS one exactly — same
// bounded, per-row-isolated, best-effort shape; same live re-authorization of
// the originating human; same refusal to finalize on nothing — and differs in
// one way only: it claims the production by the REPAIR RUN's own id rather than
// by a resource identity, because a producer that is not writing into a CMS has
// no second identity to match on. What the repair run produced IS the answer to
// the repair, for the same reason the run was minted at all.
//
// THE TWO COMPLETERS NEVER RACE FOR A ROW. A repair whose base target IS a
// captured CMS snapshot is left untouched here: that repair's answer is a
// matching capture, not merely "something this run wrote", and finalizing it on
// the looser rule would pin a successor the CMS completer would then have to
// disagree with. The ownership test is the CMS bridge's own
// (`resolveCmsRepairBaseTarget`), dynamically imported so this module does not
// pull the capture writer's graph into the common drain path.
//
// NOTHING SILENTLY DROPS, and nothing silently finalizes. A repair run still
// working is `pending` and re-checked next pass. A run that reached a terminal
// status having produced nothing this drain can claim leaves the repair OPEN
// (`dispatched`) and counts `unresolved` — ops sees it through the existing
// status — rather than closing a review on work that does not exist.
// ---------------------------------------------------------------------------

import { and, asc, desc, eq, ne } from "drizzle-orm";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

import { db } from "./db";
import { agentRuns, artifactProducedOutbox, lifecycleRepair } from "./schema";
import { TERMINAL_RUN_STATUSES, type AgentRunStatus } from "./run-status";
import { readRepair, submitRepairResponse } from "./lifecycle-repair-store";
import { repairRunId, readDeliveredRepairRequest } from "./lifecycle-repair-dispatch-store";

import { resolveOrgRoleForUser } from "@/lib/auth-session";

/** The CMS-snapshot capture emitter — the one emitter this drain does not claim,
 * because the CMS completer matches it on a resource identity this one cannot
 * see. The literal mirrors `CMS_SNAPSHOT_EMITTER` in the CMS bridge for the same
 * reason that one mirrors the host's: an agents-package leaf must not pull the
 * host's blob-store-backed capture writer into its graph for one string. */
const CMS_SNAPSHOT_EMITTER = "object_cms_snapshot_capture";

/** A minimal read-only projection of `objects` — liveness only, the identical
 * pattern the CMS bridge and the orchestration store already use. */
const appSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");
const objectsLivenessRef = appSchema.table("objects", {
  id: text("id").primaryKey(),
  orgId: text("org_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export interface ProducerRepairCompletionSummary {
  scanned: number;
  /** A repair whose production was found and whose successor gate is now open. */
  completed: number;
  /** The repair run has not finished yet — re-checked on the next pass. */
  pending: number;
  /**
   * A terminal run with no claimable production, a delivered request that can no
   * longer be read, a live re-authorization that no longer verifies, or a
   * `submitRepairResponse` rejection (stale base, lineage mismatch, a successor
   * pin already occupied). The repair stays OPEN rather than finalizing wrong.
   */
  unresolved: number;
  /** A repair this drain does not own — its base target is a CMS snapshot. */
  skipped: number;
  failed: number;
}

/** What the repair run produced, as the successor target. */
interface ClaimedProduction {
  artifactId: string;
  representationRevisionId: string;
}

/**
 * The production this repair run answered with: the LATEST artifact it wrote
 * through the produced-event outbox, excluding the CMS-snapshot emitter this
 * drain does not claim.
 *
 * THE LATEST, not the first. A producing step that wrote more than once has
 * answered with what it ended on; pinning an intermediate write into the
 * successor gate would ask a reviewer to decide on a draft the producer had
 * already moved past.
 */
async function claimProduction(producerRunId: string): Promise<ClaimedProduction | null> {
  const [row] = await db
    .select({
      artifactId: artifactProducedOutbox.artifactId,
      representationRevisionId: artifactProducedOutbox.representationRevisionId,
    })
    .from(artifactProducedOutbox)
    .where(
      and(
        eq(artifactProducedOutbox.producerRunId, producerRunId),
        ne(artifactProducedOutbox.emitter, CMS_SNAPSHOT_EMITTER),
      ),
    )
    .orderBy(desc(artifactProducedOutbox.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The base artifact's live current revision, or `null` when the row is gone or
 * tombstoned — the CAS operand `submitRepairResponse` validates the lineage
 * against, so a base that moved or died under the repair is refused there rather
 * than repaired over.
 *
 * A repaired production mints a FRESH revision beside the base rather than
 * replacing it ("Regenerate appends a revision — it never overwrites or deletes
 * the one under review"), so the base's current revision is still the one the
 * gate pinned for as long as the row lives.
 */
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

/** Is this repair the CMS completer's to finish? */
async function ownedByTheCmsCompleter(baseArtifactId: string): Promise<boolean> {
  try {
    const { resolveCmsRepairBaseTarget } = await import("./lifecycle-repair-cms-production-bridge");
    const target = await resolveCmsRepairBaseTarget({
      baseTarget: { artifactId: baseArtifactId, representationRevisionId: "" },
    });
    return target !== null;
  } catch {
    // A read that cannot answer must not be read as "not a CMS repair": claiming
    // a row this drain may not own is the one mistake that pins a wrong
    // successor. Leave it to the completer that can answer.
    return true;
  }
}

/**
 * Complete every DISPATCHED `producer_repair` repair whose repair run has done
 * its work — opening the successor gate the drawing requires.
 *
 * Best-effort and per-row isolated, exactly like the dispatch drain it follows:
 * one row's failure never blocks the rest, and this function never throws.
 */
export async function completeDispatchedProducerRepairs(opts?: {
  limit?: number;
}): Promise<ProducerRepairCompletionSummary> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 25, 200));
  const summary: ProducerRepairCompletionSummary = {
    scanned: 0,
    completed: 0,
    pending: 0,
    unresolved: 0,
    skipped: 0,
    failed: 0,
  };

  const dispatched = await db
    .select({ id: lifecycleRepair.id })
    .from(lifecycleRepair)
    .where(and(eq(lifecycleRepair.status, "dispatched"), eq(lifecycleRepair.route, "producer_repair")))
    .orderBy(asc(lifecycleRepair.createdAt))
    .limit(limit);

  for (const { id } of dispatched) {
    summary.scanned += 1;
    try {
      const repair = await readRepair(id);
      // Vanished, or moved off `dispatched` under a concurrent pass — a later
      // pass reconciles; never treat a race as a failure.
      if (!repair || repair.status !== "dispatched") continue;

      if (await ownedByTheCmsCompleter(repair.baseArtifactId)) {
        summary.skipped += 1;
        continue;
      }

      const runId = repairRunId(repair.id);
      const production = await claimProduction(runId);
      if (!production) {
        const [run] = await db
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, runId))
          .limit(1);
        // A missing repair run can never land a production, so treating it as
        // "still running" would leave the repair pending forever.
        if (!run || TERMINAL_RUN_STATUSES.has(run.status as AgentRunStatus)) {
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

      // LIVE re-verification (the cinatra#2286 S10 PR2 principal rule, kept): the
      // SAME originating human the dispatch verified, re-checked NOW rather than
      // trusted from the delivered request. A membership revoked between dispatch
      // and completion refuses the finalize and the repair stays open.
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
          // The producing step carries no per-finding "which one did I fix"
          // channel — it was handed the note and made the work again — so every
          // requested finding is reported applied. This is an annotation, not a
          // security boundary: the post-change verification is what measures the
          // produced revision against what the review authorized.
          findingOutcomes: repair.findings.map((f) => ({ findingId: f.id, applied: true })),
          changeSummary: `The producing step ran again from the reviewer's note and answered ${repair.findings.length} requested change(s).`,
          producerProvenance: { runId, agentId: null },
        },
      });

      if (result.ok) summary.completed += 1;
      else summary.unresolved += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[lifecycle-repair-producer-completion-store] completion for repair ${id} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return summary;
}
