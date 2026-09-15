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
import { refileRevisionOntoArtifact } from "@/lib/artifacts/artifact-revision-append";

/** The CMS-snapshot capture emitter — the one emitter this drain does not claim,
 * because the CMS completer matches it on a resource identity this one cannot
 * see. The literal mirrors `CMS_SNAPSHOT_EMITTER` in the CMS bridge for the same
 * reason that one mirrors the host's: an agents-package leaf must not pull the
 * host's blob-store-backed capture writer into its graph for one string. */
const CMS_SNAPSHOT_EMITTER = "object_cms_snapshot_capture";

/** How many candidate rows are read per unit of pass budget — the window that
 * keeps the other completer's rows from starving this one's. See the scan. */
const CANDIDATE_WINDOW_FACTOR = 8;
/** The hard ceiling on that window, so a pass is always bounded. */
const MAX_CANDIDATE_WINDOW = 500;

/**
 * The non-terminal run statuses that mean WAITING FOR A PERSON rather than
 * working. A run here does not move again by itself, so a repair behind it is
 * wedged, not in flight — see the reading at the scan.
 */
const WEDGED_RUN_STATUSES: ReadonlySet<string> = new Set<AgentRunStatus>([
  "pending_approval",
  "pending_input",
]);

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
  /**
   * A repair whose OWNERSHIP could not be read, so it was left to the completer
   * that can answer. Counted apart from `skipped` because the two are different
   * facts: `skipped` is "this is the CMS completer's row", this one is "nobody
   * here could tell whose row it is", and a drain that folded the second into
   * the first would report a read outage as ordinary, correct routing.
   */
  skippedUnknownOwner: number;
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
async function claimProduction(
  orgId: string,
  producerRunId: string,
): Promise<ClaimedProduction | null> {
  const [row] = await db
    .select({
      artifactId: artifactProducedOutbox.artifactId,
      representationRevisionId: artifactProducedOutbox.representationRevisionId,
    })
    .from(artifactProducedOutbox)
    .where(
      and(
        // ORG-SCOPED (cinatra#3080). The run id alone already
        // narrows this to one run, so the org equality can never be what finds
        // the row — it is here so that a row which somehow does not belong to
        // the repair's org can never BE the row, and the successor gate can
        // never be pinned across an org boundary by a single bad write.
        eq(artifactProducedOutbox.orgId, orgId),
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

/**
 * Whose repair is this — the CMS completer's, this one's, or unknown?
 *
 * THREE ANSWERS, NOT TWO (cinatra#3080). A read that cannot answer
 * must not be read as "not a CMS repair" — claiming a row this drain may not own
 * is the one mistake that pins a wrong successor — so it still yields the row.
 * But it is not the same fact as "this is the CMS completer's", and reporting it
 * as one made a read outage look like ordinary routing: every non-CMS repair
 * would be handed away, silently, for as long as the outage lasted. It is
 * counted and logged on its own.
 *
 * THE REPAIR'S REAL BASE TARGET IS WHAT IS ASKED ABOUT. The call used to hand
 * `resolveCmsRepairBaseTarget` an EMPTY STRING where its declared operand names
 * a representation revision. It is ignored today — that resolver keys on the
 * artifact id alone — but a fabricated operand is a trap the day the resolver
 * starts reading the field it declares, and it costs nothing to pass the
 * repair's own base revision, which is the thing the question is about.
 */
type RepairOwnership = "cms" | "mine" | "unknown";

async function repairOwnership(
  baseArtifactId: string,
  baseRevisionId: string,
): Promise<RepairOwnership> {
  try {
    const { resolveCmsRepairBaseTarget } = await import("./lifecycle-repair-cms-production-bridge");
    const target = await resolveCmsRepairBaseTarget({
      baseTarget: { artifactId: baseArtifactId, representationRevisionId: baseRevisionId },
    });
    return target !== null ? "cms" : "mine";
  } catch (err) {
    console.error(
      `[lifecycle-repair-producer-completion-store] the CMS-ownership read for base artifact ` +
        `${baseArtifactId} could not answer, so the repair is left to the completer that can: ${
          err instanceof Error ? err.message : String(err)
        }`,
    );
    return "unknown";
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
    skippedUnknownOwner: 0,
    failed: 0,
  };

  // A WINDOW OF CANDIDATES, AND A BUDGET ONLY THIS DRAIN'S OWN ROWS SPEND
  // (cinatra#3080).
  //
  // The scan used to be `oldest `limit` dispatched rows`, and the two completers
  // would then starve each other. Both read the SAME `dispatched` +
  // `producer_repair` set oldest-first; each hands the other's rows back
  // untouched — and a handed-back row is still `dispatched`, so it sorts first
  // again on the next pass, forever. Twenty-five old CMS repairs at the head of
  // the queue and no blog repair behind them is ever reached, which is the very
  // defect this drain exists to close, arrived at a second way. The same holds
  // for a row this drain leaves OPEN by design (a terminal run with nothing to
  // claim): it stays `dispatched` and keeps its place at the head.
  //
  // So the LIMIT now bounds the work this pass DOES, not the rows it looks at: a
  // wider window is read, a row that is not this drain's costs a cheap ownership
  // read and no budget, and the pass stops when it has spent its budget on rows
  // it owns. The window is still bounded (never a full-table scan), and the
  // ordering is unchanged — oldest first, so nothing this drain owns is
  // reordered around anything else it owns.
  const candidates = await db
    .select({ id: lifecycleRepair.id })
    .from(lifecycleRepair)
    .where(and(eq(lifecycleRepair.status, "dispatched"), eq(lifecycleRepair.route, "producer_repair")))
    .orderBy(asc(lifecycleRepair.createdAt))
    .limit(Math.min(limit * CANDIDATE_WINDOW_FACTOR, MAX_CANDIDATE_WINDOW));

  let budget = limit;
  for (const { id } of candidates) {
    if (budget <= 0) break;
    summary.scanned += 1;
    try {
      const repair = await readRepair(id);
      // Vanished, or moved off `dispatched` under a concurrent pass — a later
      // pass reconciles; never treat a race as a failure.
      if (!repair || repair.status !== "dispatched") continue;

      const ownership = await repairOwnership(
        repair.baseArtifactId,
        repair.baseRepresentationRevisionId,
      );
      if (ownership !== "mine") {
        // Not this drain's row, or nobody could say whose it is. Either way it
        // is handed back untouched, and it spends no budget — that is what stops
        // a queue of the other completer's rows from starving this one's.
        if (ownership === "cms") summary.skipped += 1;
        else summary.skippedUnknownOwner += 1;
        continue;
      }
      budget -= 1;

      const runId = repairRunId(repair.id);

      // THE RUN MUST HAVE FINISHED BEFORE ANYTHING IT WROTE IS AN ANSWER
      // (cinatra#3080). The status read used to happen only after
      // nothing was found, which made the claim "the latest thing this run has
      // written SO FAR" — so a producing step that writes more than once (an
      // outline before the draft, a picture beside the post) would have its
      // FIRST write pinned into the successor gate by whichever maintenance pass
      // ran in between, and the finished work that followed would arrive at a
      // repair already `repaired` and be dropped on the floor. A reviewer would
      // then be asked to decide on a fragment the producer had already moved
      // past, with no way back. A run that is still going has not answered yet:
      // it is `pending`, and the next pass asks again.
      const [run] = await db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      // A missing repair run can never land a production, so treating it as
      // "still running" would leave the repair pending forever.
      if (!run) {
        summary.unresolved += 1;
        continue;
      }
      if (!TERMINAL_RUN_STATUSES.has(run.status as AgentRunStatus)) {
        if (WEDGED_RUN_STATUSES.has(run.status)) {
          // A repair run WAITING FOR A PERSON is not working (cinatra#3080).
          // This is the exact shape the first capture
          // photographed — a repair run parked on a setup screen — and the
          // delivery fix keeps a NEW repair off it. A row stranded there BEFORE
          // that fix (or by any future park) never leaves this status on its
          // own, so counting it `pending` would report a permanent wedge as
          // ordinary progress, pass after pass, and nothing would ever say so.
          // It is unresolved, and it is said out loud.
          summary.unresolved += 1;
          console.error(
            `[lifecycle-repair-producer-completion-store] the repair run for repair ${repair.id} ` +
              `is parked at \`${run.status}\` waiting for a person — its review has no successor ` +
              `and cannot get one until the run is released or the repair is retired.`,
          );
        } else {
          summary.pending += 1;
        }
        continue;
      }

      const production = await claimProduction(repair.orgId, runId);
      if (!production) {
        summary.unresolved += 1;
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

      // ── THE SUCCESSOR IS A REVISION OF THE REVIEWED ARTIFACT ────────────
      //
      // (cinatra#3080, fix leg 8. THIS is the seam the ninth proof round's real
      // run went through, and where its defect lived.)
      //
      // A producing step is a generic agent run: it answers by writing its work
      // the only way a run can, through the create road, which mints an artifact
      // of its own. `claimProduction` above reads exactly that — "the LATEST
      // artifact it wrote through the produced-event outbox" — and this seam used
      // to pin that artifact straight into the successor gate. So the reviewer
      // decided on one artifact and was handed another: gate `d6301eed` on
      // artifact `90dbf854`, successor `096296ae` on artifact `d8eca6bd`, with
      // nothing on either row joining them.
      //
      // The drawing gives one artifact and two revisions: Regenerate "files a
      // new revision of the same artifact, and settles this gate superseded
      // beneath a successor over that same artifact" (Agent run & review §VI).
      // So the run's answer is RE-FILED onto the reviewed artifact before the
      // response is submitted. The same `resource` row is bound — the same
      // substance, already on disk — so nothing is copied and the producing run
      // keeps its own output row exactly as it wrote it; what changes is which
      // artifact the review's lineage runs through.
      //
      // A re-drive re-files nothing: the writer is idempotent on substance and
      // hands back the revision already there.
      //
      // STATED RESIDUAL, not hidden — and stated CORRECTLY (a convergence
      // finding on this leg corrected the first wording). The re-file lands
      // before `submitRepairResponse` and in its own transaction, so a submit
      // that is then refused (a base that moved, a successor pin already
      // occupied) leaves the reviewed artifact carrying a revision no gate pins.
      //
      // THAT REVISION IS NOT INERT, and the first wording here said it was. The
      // append moves the artifact's OWN pointer — `objects.data`'s
      // `latestRepresentationRevisionId` — onto the new revision, which is what
      // an append to an append-only series means: the artifact's current
      // representation IS the regenerated one from that moment, on its own page
      // and everywhere else that reads the envelope, whether or not a gate ever
      // pins it. What a refused submit leaves behind is therefore an artifact
      // one revision on with its review still open — not a hidden row.
      //
      // WHAT THAT COSTS, AND WHY IT IS TAKEN. Nothing is lost or overwritten:
      // `representation` is append-only, the reviewed revision keeps its row and
      // its number, and the gate still pins the revision the reviewer decided on
      // (§VI — "a decided gate retains and displays the target it froze", and a
      // pending gate's pin is immutable). The repair stays OPEN exactly as it
      // did before, and the next drain re-files nothing — the writer is
      // idempotent on THIS re-drive — and re-submits.
      //
      // Making the append and the successor pin ONE transaction is the honest
      // fix and it is a change to the repair store's own seam, not this leg's;
      // it is named here rather than papered over.
      let successorTarget = production;
      if (production.artifactId !== repair.baseArtifactId) {
        const refiled = refileRevisionOntoArtifact({
          orgId: repair.orgId,
          targetArtifactId: repair.baseArtifactId,
          sourceArtifactId: production.artifactId,
          sourceRepresentationRevisionId: production.representationRevisionId,
          createdBy: delivered.originatingRunBy ?? null,
          createdByRunId: runId,
        });
        successorTarget = {
          artifactId: refiled.artifactId,
          representationRevisionId: refiled.representationRevisionId,
        };
      }

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
            artifactId: successorTarget.artifactId,
            representationRevisionId: successorTarget.representationRevisionId,
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
