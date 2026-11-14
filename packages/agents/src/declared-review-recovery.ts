import "server-only";

/**
 * cinatra#4476 — THE UPGRADE RECOVERY of a declared review's paused run that the
 * cinatra#4312 upgrade left with no live resume intent.
 *
 * Two states reach the upgrade from before it, or from the deploy window while the
 * old application still serves:
 *   1. main re-claimed an undelivered intent after each lease with no bound, so it
 *      can be at or above `max_attempts` (or the old worker takes it there after the
 *      migration ran). The first sweep of the new code dead-letters it, and the run
 *      keeps no live intent. Every gate of such a family already holds its own
 *      intent (a decision writes it; main settled no declared leg as changes
 *      requested), so no new row can carry the decision: the row is RE-ARMED;
 *   2. an old writer's attempt on a reopen gate of a later leg's lineage left that
 *      lineage `malformed-lineage` until the chain check read a named reopen gate on
 *      a declared lineage (lifecycle-repair-store `isRecordedVerificationReopen`,
 *      `declaredLineage: "read"`). A close that ran before then carried nothing, so
 *      the family's decision is CARRIED in a new intent on the gate the closing
 *      attempt repairs, as a lineage's close does.
 *
 * The resume sweep runs this before its claim (`sweepArtifactReviewResumeIntents`).
 * It acts only once the upgrade wrote its epoch row (core__0127; a fresh install has
 * none), and only on a pause whose legs were all created before that row, or whose
 * lineage carries an attempt at 2 or later on a verification-reopen gate (the old
 * writer's signature: the new code refuses a note there). For one such pause it
 * writes AT MOST ONCE, EVER: the marker row (run id + base task id) is inserted in
 * the same transaction as the write, and a pause with a marker is never read again,
 * whatever then happens to the intent (delivered, dead-lettered again, or a later
 * pause on the same base task id). core__0127's down keeps the marker table and the
 * epoch row, so this holds across a rollback and a later redeploy as well.
 *
 * The pause is read whole, under the run row's `FOR NO KEY UPDATE` lock (the lock a
 * lineage's close takes; the worker's acknowledgement takes a SHARE lock on it):
 *   - the run is `pending_approval`, and no other declared review of the run is not
 *     older than this one (`laterDeclaredPause`);
 *   - every leg is decided (`declaredReviewFamilyState` reads `complete`);
 *   - no gate of the family (a leg, or a gate one of its lineages repairs or opened
 *     as its successor) holds a LIVE intent: `pending` or `delivering` (the two states
 *     a writer leaves an open intent in), not dead-lettered, and either claimable
 *     (attempts below max) or held under a live lease. A row in any other status is
 *     never live;
 *   - every lineage of a leg settled as changes requested reads closed. An open one
 *     means nothing to do yet; an unreadable one is listed for ops;
 *   - the family is bound to the run's organization: every attempt of a leg's
 *     lineage, every family gate (which must exist) and the run of every intent on a
 *     family gate (which must exist) are in the run's organization. Any other family
 *     is listed for ops (`unbound-family`) before a write, so a lineage that reads
 *     closed through a successor gate of another organization, or an intent of
 *     another organization's run, never gives the write its decision or its gate;
 *   - the family has a decision: the newest intent on a family gate, by created time
 *     then gate id (the order a lineage's close uses). None is listed for ops.
 * Then exactly one road, by the status of that newest decision's row:
 *   - REARM, when it is `pending` or `delivering` (it used its attempts or is
 *     dead-lettered): `rearmExhaustedResumeIntent`, a compare-and-set on its state;
 *   - CARRY, when it is `done`, only when the row PROVES that no worker sent it: a
 *     leg of the family was resolved after the row was marked done (the leg's
 *     `resolved_at` later than the row's `updated_at`, compared in the database).
 *     Every worker since cinatra#3035 sends a declared review's decision only after
 *     it read every leg resolved, and marks the row done after the send, so a sent
 *     row was marked done after every leg's resolution; a row marked done before a
 *     leg was resolved was set aside. A delivered row and a row set aside both read
 *     `done`, and nothing else on the row tells them apart: so a `done` decision
 *     without that proof is listed for ops (`maybe-delivered`), whatever wrote it.
 *     This is what an old application (before cinatra#4312) leaves when it sent a
 *     decision while a lineage was still open: it read no lineage before it sent.
 *     With the proof: a new intent on the first closing gate of a leg's lineage
 *     (legs oldest first) that is the old writer's rest (an attempt at 2 or later on
 *     a verification-reopen gate), holds no intent, and whose attempt was last
 *     written AFTER the decision's row was marked done (both times compared in the
 *     database, in microseconds), on a lineage no successor gate of which was
 *     settled with a disposition other than changes requested, with the decision's
 *     kind and text (`insertRecoveryCarrier`). No such gate is listed for ops
 *     (`no-free-gate`);
 *   - any other status, which no writer leaves (core__0072's check refuses it), is
 *     listed for ops (`unknown-intent-status`), whatever its attempts and dead letter.
 * A write that writes nothing throws inside the transaction, so the marker rolls back
 * with it (`raced`) and the pause is read again when a later cycle comes to its run.
 *
 * Bounded, and every paused run is read again: one pass reads ONE PAGE of the paused
 * runs, at most `recoveryLimit(limit)` of them (20 by default, never more than 50), in
 * run id order after the epoch row's cursor and up to the cycle's high-water mark, from
 * the partial index of the paused runs' ids (`recoveryPageQuery`, core__0127). Passes
 * take their pages in turn under the epoch row's lock (`takeNextPage`). A pass that
 * finds no high-water mark starts a cycle: the mark is the greatest paused run id at
 * that time. A full page whose last run id is not the mark moves the cursor to that
 * id; any other page (not full, or ending at the mark) ends the cycle: the cursor and
 * the mark are set back to null, so the next pass starts a new cycle from the first
 * paused run. The cursor moves whatever the page's runs gave. So a cycle reads each
 * run paused at its start with an id up to its mark once, and it ends after at most
 * (P + A) / limit + 1 passes (integer division), where P is the number of those runs
 * and A the number of runs that pause during the cycle with an id between the cursor
 * and the mark. A run that pauses with an id above the mark, or below the cursor,
 * waits for the next cycle, so runs that keep pausing with higher ids hold back no
 * run below the cursor. The candidate read then reads only that page's runs, by run
 * id, and at most one pause per run (the run's newest declared review); a pause has at
 * most MAX_REVIEW_TARGETS legs, and so at most that many lineage reads. A pause listed
 * for ops, waiting on an open lineage, skipped or failed keeps no marker and is read
 * again when a later cycle comes to its run.
 *
 * A failed pause is returned with its error's name and SQLSTATE code only, never its
 * message: a query error's message carries the query's parameters, and the carrier
 * insert's parameters include the decision's text (`recoveryErrorTag`).
 */

import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";

import { db } from "./db";
import {
  agentRuns,
  artifactReviewGates,
  artifactReviewResumeOutbox,
  artifactReviewResumeRecovery,
  artifactReviewResumeRecoveryEpoch,
  lifecycleRepair,
} from "./schema";
import { listReviewGatesForRun, rearmExhaustedResumeIntent } from "./artifact-review-gate-store";
import {
  insertRecoveryCarrier,
  isRepairLineageOpen,
  RepairLineageStateError,
  type RepairLineageStateCode,
} from "./lifecycle-repair-store";
import { laterDeclaredPause } from "./declared-review-pause";
import { baseReviewTaskId, declaredReviewFamilyState } from "@/lib/artifacts/artifact-review-target";
import { VERIFICATION_REOPEN_TASK_PREFIX } from "@/lib/lifecycle/lifecycle-orchestration";

/** The epoch row's id (core__0127). */
export const RECOVERY_EPOCH_ID = "cinatra-4476";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

type Pause = { runId: string; baseTaskId: string };

type RecoveryExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What one pass did with one pause. */
export type DeclaredReviewRecoveryOutcome =
  | (Pause & { outcome: "rearmed"; gateId: string })
  | (Pause & { outcome: "carried"; gateId: string; decisionGateId: string })
  | (Pause & {
      outcome: "ops";
      reason: "no-decision" | "no-free-gate" | "unknown-intent-status" | "unbound-family" | "maybe-delivered";
    })
  | (Pause & { outcome: "ops"; reason: "unreadable-lineage"; lineageId: string; code: RepairLineageStateCode })
  | (Pause & {
      outcome: "skipped";
      reason: "not-paused" | "already-recovered" | "later-pause" | "not-decided" | "live-intent" | "open-lineage" | "raced";
      lineageId?: string;
    })
  | (Pause & { outcome: "failed"; errorName: string; errorCode?: string });

class RecoveryRaced extends Error {}

/**
 * The number of paused runs one pass reads (one page): the integer part of `limit`,
 * at most 50 and at least 1. No limit, a limit whose integer part is 0 and a limit that is not a
 * number give the default 20; a negative limit gives 1.
 */
export function recoveryLimit(limit?: number): number {
  return Math.max(1, Math.min(Math.trunc(limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT));
}

const ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * What a failed pause reports of its error: the error's name (its `name` when that
 * is not the generic "Error", else its class name) and the SQLSTATE code of the
 * error or of its cause (a query error wraps the driver's error). Never the message:
 * a query error's message carries the query's parameters.
 */
export function recoveryErrorTag(err: unknown): { errorName: string; errorCode?: string } {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } | null; constructor?: { name?: unknown } } | null | undefined;
  const ownName = e?.name;
  const className = e?.constructor?.name;
  const own = typeof ownName === "string" && ownName !== "Error" ? ownName : undefined;
  const cls = typeof className === "string" ? className : undefined;
  const name = [own, cls, err instanceof Error ? "Error" : typeof err].find((n) => typeof n === "string" && ERROR_NAME.test(n)) ?? "unknown";
  const code = [e?.code, e?.cause?.code].find((c): c is string => typeof c === "string" && SQLSTATE.test(c));
  return code ? { errorName: name, errorCode: code } : { errorName: name };
}

/**
 * The page read: the ids of at most `limit` paused runs, in id order, after `cursor`
 * (from the first paused run when it is null) and up to `highWater` (no bound when it
 * is null). The predicate is the partial index's own
 * (`agent_runs_pending_approval_id_idx`, core__0127), so the read is a range of that
 * index in its order, with no sort.
 */
export function recoveryPageQuery(
  cursor: string | null, limit: number, executor: RecoveryExecutor = db, highWater: string | null = null,
) {
  const where: SQL[] = [sql`${agentRuns.status} = 'pending_approval'`];
  if (cursor !== null) where.push(sql`${agentRuns.id} > ${cursor}`);
  if (highWater !== null) where.push(sql`${agentRuns.id} <= ${highWater}`);
  return executor
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(...where))
    .orderBy(asc(agentRuns.id))
    .limit(limit);
}

/** One pass of the upgrade recovery. Never throws for one pause: a failed pause is
 * returned as `failed` and the next one is read. A failed page or candidate read
 * throws (once the page read committed, the cursor is already past that page). */
export async function recoverStrandedDeclaredReviews(opts?: { limit?: number }): Promise<DeclaredReviewRecoveryOutcome[]> {
  const limit = recoveryLimit(opts?.limit);
  const page = await takeNextPage(limit);
  if (page === null || page.length === 0) return [];
  const outcomes: DeclaredReviewRecoveryOutcome[] = [];
  for (const pause of await readCandidatePauses(page)) {
    try {
      outcomes.push(await recoverPause(pause));
    } catch (err) {
      if (err instanceof RecoveryRaced) outcomes.push({ ...pause, outcome: "skipped", reason: "raced" });
      else outcomes.push({ ...pause, outcome: "failed", ...recoveryErrorTag(err) });
    }
  }
  return outcomes;
}

/**
 * The next page of paused runs, with the cursor and the cycle's high-water mark moved,
 * in one transaction that holds the epoch row `FOR UPDATE`: passes at once take their
 * pages in turn, so no pass reads a page another pass already took in this cycle.
 * With no mark, the pass starts a cycle: the mark is the greatest paused run id now
 * (none: an empty page). A full page whose last run id is not the mark moves the
 * cursor to that id and keeps the mark; any other page ends the cycle (cursor and mark
 * null). Ids are compared only by the database (the page read) and by equality here.
 * Null when there is no epoch row (nothing is read).
 */
async function takeNextPage(limit: number): Promise<string[] | null> {
  return db.transaction(async (tx) => {
    const e = artifactReviewResumeRecoveryEpoch;
    const [epoch] = await tx
      .select({ cursor: e.cursorRunId, highWater: e.highWaterRunId })
      .from(e)
      .where(eq(e.id, RECOVERY_EPOCH_ID))
      .limit(1)
      .for("update");
    if (!epoch) return null;
    let highWater = epoch.highWater;
    if (highWater === null) {
      const [top] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(sql`${agentRuns.status} = 'pending_approval'`)
        .orderBy(desc(agentRuns.id))
        .limit(1);
      highWater = top?.id ?? null;
    }
    const page = highWater === null ? [] : (await recoveryPageQuery(epoch.cursor, limit, tx, highWater)).map((r) => r.id);
    const goOn = page.length === limit && page[page.length - 1] !== highWater;
    await tx
      .update(e)
      .set({ cursorRunId: goOn ? page[page.length - 1] : null, highWaterRunId: goOn ? highWater : null })
      .where(eq(e.id, RECOVERY_EPOCH_ID));
    return page;
  });
}

/**
 * The candidate pauses among the page's runs (`runIds`, paused when the page was
 * read; the locked read checks the run again): for each run, its newest declared
 * review (the base task id of its newest `wayflow-` gate, by created time then id),
 * when that pause has no marker, no leg still pending, no leg holding a live intent,
 * and is eligible (every leg created before the epoch, or an old writer's reopen
 * attempt on one of its lineages). Every read here is keyed by one of those run ids.
 * The whole-family checks run under the lock.
 */
async function readCandidatePauses(runIds: readonly string[]): Promise<Pause[]> {
  const g = artifactReviewGates;
  const res = await db.execute(sql`
    WITH epoch AS (
      SELECT upgraded_at FROM ${artifactReviewResumeRecoveryEpoch} WHERE id = ${RECOVERY_EPOCH_ID}
    ), cur AS (
      SELECT DISTINCT ON (g.run_id) g.run_id, split_part(g.review_task_id, '#', 1) AS base
        FROM ${g} AS g
       WHERE g.run_id IN (${sql.join(runIds.map((id) => sql`${id}`), sql`, `)}) AND starts_with(g.review_task_id, 'wayflow-')
       ORDER BY g.run_id, g.created_at DESC, g.id DESC
    )
    SELECT cur.run_id AS run_id, cur.base AS base
      FROM cur CROSS JOIN epoch
     WHERE NOT EXISTS (
             SELECT 1 FROM ${artifactReviewResumeRecovery} AS m
              WHERE m.run_id = cur.run_id AND m.base_review_task_id = cur.base)
       AND NOT EXISTS (
             SELECT 1 FROM ${g} AS p
              WHERE p.run_id = cur.run_id AND split_part(p.review_task_id, '#', 1) = cur.base AND p.status <> 'resolved')
       AND NOT EXISTS (
             SELECT 1 FROM ${g} AS l JOIN ${artifactReviewResumeOutbox} AS o ON o.gate_id = l.id
              WHERE l.run_id = cur.run_id AND split_part(l.review_task_id, '#', 1) = cur.base
                AND o.dead_lettered_at IS NULL AND o.status IN ('pending', 'delivering')
                AND (o.attempts < o.max_attempts OR (o.status = 'delivering' AND o.lease_expires_at > now())))
       AND (
             NOT EXISTS (
               SELECT 1 FROM ${g} AS l
                WHERE l.run_id = cur.run_id AND split_part(l.review_task_id, '#', 1) = cur.base
                  AND l.created_at >= epoch.upgraded_at)
             OR EXISTS (
               SELECT 1 FROM ${lifecycleRepair} AS a
                 JOIN ${g} AS rg ON rg.id = a.gate_id
                 JOIN ${g} AS leg ON leg.id = a.lineage_id
                WHERE leg.run_id = cur.run_id AND split_part(leg.review_task_id, '#', 1) = cur.base
                  AND a.attempt >= 2 AND starts_with(rg.review_task_id, ${VERIFICATION_REOPEN_TASK_PREFIX})))
     ORDER BY cur.run_id
  `);
  return (res.rows as { run_id: string; base: string }[]).map((r) => ({ runId: r.run_id, baseTaskId: r.base }));
}

/** Read one pause whole under the run row lock, and write for it at most once. */
async function recoverPause(pause: Pause): Promise<DeclaredReviewRecoveryOutcome> {
  const skip = (reason: Extract<DeclaredReviewRecoveryOutcome, { outcome: "skipped" }>["reason"], lineageId?: string) =>
    ({ ...pause, outcome: "skipped" as const, reason, ...(lineageId ? { lineageId } : {}) });
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: agentRuns.status, orgId: agentRuns.orgId })
      .from(agentRuns)
      .where(eq(agentRuns.id, pause.runId))
      .limit(1)
      .for("no key update");
    if (run?.status !== "pending_approval") return skip("not-paused");
    const [marked] = await tx
      .select({ gateId: artifactReviewResumeRecovery.gateId })
      .from(artifactReviewResumeRecovery)
      .where(and(eq(artifactReviewResumeRecovery.runId, pause.runId),
        eq(artifactReviewResumeRecovery.baseReviewTaskId, pause.baseTaskId)))
      .limit(1);
    if (marked) return skip("already-recovered");

    const gates = await listReviewGatesForRun(pause.runId, tx);
    if (laterDeclaredPause(gates, pause.baseTaskId)) return skip("later-pause");
    if (declaredReviewFamilyState({ runId: pause.runId, orgId: run.orgId, reviewTaskId: pause.baseTaskId, gates }) !== "complete") {
      return skip("not-decided");
    }
    const legs = gates.filter((x) => baseReviewTaskId(x.reviewTaskId) === pause.baseTaskId);
    const legIds = legs.map((x) => x.id);
    const familyGates = new Set(legIds);
    const attempts = await tx
      .select({ gateId: lifecycleRepair.gateId, successorGateId: lifecycleRepair.successorGateId, orgId: lifecycleRepair.orgId })
      .from(lifecycleRepair)
      .where(inArray(lifecycleRepair.lineageId, legIds));
    for (const r of attempts) {
      familyGates.add(r.gateId);
      if (r.successorGateId) familyGates.add(r.successorGateId);
    }
    const o = artifactReviewResumeOutbox;
    const intents = await tx
      .select({
        gateId: o.gateId,
        runId: o.runId,
        status: o.status,
        kind: o.kind,
        responseText: o.responseText,
        live: sql<boolean>`(${o.deadLetteredAt} IS NULL AND ${o.status} IN ('pending', 'delivering') AND (${o.attempts} < ${o.maxAttempts} OR (${o.status} = 'delivering' AND ${o.leaseExpiresAt} > now())))`,
      })
      .from(o)
      .where(inArray(o.gateId, [...familyGates]))
      .orderBy(desc(o.createdAt), desc(o.gateId));
    if (intents.some((i) => i.live)) return skip("live-intent");

    // Legs settled as changes requested, oldest first (created time, then id).
    const settled = legs
      .filter((x) => x.disposition === "changes_requested")
      .sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const leg of settled) {
      try {
        if (await isRepairLineageOpen(leg.id, tx)) return skip("open-lineage", leg.id);
      } catch (err) {
        if (!(err instanceof RepairLineageStateError)) throw err;
        return { ...pause, outcome: "ops" as const, reason: "unreadable-lineage" as const, lineageId: leg.id, code: err.code };
      }
    }
    // The family is bound to the run's organization before a lineage that reads closed,
    // or an intent, is taken as family state for a write: every attempt of a leg's
    // lineage, every family gate (which must exist), and the run of every intent on a
    // family gate (which must exist). A lineage's chain check binds its attempts to the
    // root gate's organization (an unbound one is unreadable, above), but a repaired
    // attempt's successor gate only by its id: a successor in another organization would
    // let that lineage read closed and give the family its newest intent.
    const familyGateRows = await tx
      .select({ id: artifactReviewGates.id, orgId: artifactReviewGates.orgId })
      .from(artifactReviewGates)
      .where(inArray(artifactReviewGates.id, [...familyGates]));
    const intentRunIds = [...new Set(intents.map((i) => i.runId))];
    const intentRuns = intentRunIds.length === 0 ? [] : await tx
      .select({ id: agentRuns.id, orgId: agentRuns.orgId })
      .from(agentRuns)
      .where(inArray(agentRuns.id, intentRunIds));
    if (attempts.some((r) => r.orgId !== run.orgId) ||
        familyGateRows.length !== familyGates.size || familyGateRows.some((x) => x.orgId !== run.orgId) ||
        intentRuns.length !== intentRunIds.length || intentRuns.some((r) => r.orgId !== run.orgId)) {
      return { ...pause, outcome: "ops" as const, reason: "unbound-family" as const };
    }
    const decision = intents[0];
    if (!decision) return { ...pause, outcome: "ops" as const, reason: "no-decision" as const };

    const held = new Set(intents.map((i) => i.gateId));
    let road: "rearm" | "carry";
    let gateId: string | undefined;
    let rootTaskId: string | undefined;
    if (decision.status === "pending" || decision.status === "delivering") {
      road = "rearm";
      gateId = decision.gateId;
    } else if (decision.status === "done") {
      road = "carry";
      // Proof that no worker sent this decision: a leg of the family was resolved after
      // its row was marked done (a sent row is marked done after every leg was resolved;
      // the header says why). Without it the row may have been delivered: for ops.
      const proof = await tx.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM ${artifactReviewResumeOutbox} AS d JOIN ${artifactReviewGates} AS leg
            ON leg.id IN (${sql.join(legIds.map((id) => sql`${id}`), sql`, `)})
         WHERE d.gate_id = ${decision.gateId} AND leg.resolved_at > d.updated_at) AS set_aside
      `);
      if ((proof.rows[0] as { set_aside?: boolean } | undefined)?.set_aside !== true) {
        return { ...pause, outcome: "ops" as const, reason: "maybe-delivered" as const };
      }
      for (const leg of settled) {
        const [closing] = await tx
          .select({
            gateId: lifecycleRepair.gateId,
            attempt: lifecycleRepair.attempt,
            gateTaskId: artifactReviewGates.reviewTaskId,
            // Was this attempt last written after the decision's row was marked done?
            // In the database, so the times compare in microseconds.
            closedAfterDecision: sql<boolean>`coalesce(${lifecycleRepair.updatedAt} > (
              SELECT d.updated_at FROM ${artifactReviewResumeOutbox} AS d WHERE d.gate_id = ${decision.gateId}), false)`,
            // Did the lineage read open from its attempt 1 until this attempt? No
            // attempt's successor gate was settled with a disposition other than
            // changes requested (a settled successor with any other one closes the
            // lineage, and only a later reopen opens it again).
            openThroughout: sql<boolean>`NOT EXISTS (
              SELECT 1 FROM ${lifecycleRepair} AS e JOIN ${artifactReviewGates} AS s ON s.id = e.successor_gate_id
               WHERE e.lineage_id = ${leg.id} AND s.status = 'resolved'
                 AND s.disposition IS DISTINCT FROM 'changes_requested')`,
          })
          .from(lifecycleRepair)
          .innerJoin(artifactReviewGates, eq(artifactReviewGates.id, lifecycleRepair.gateId))
          .where(eq(lifecycleRepair.lineageId, leg.id))
          .orderBy(desc(lifecycleRepair.attempt), desc(lifecycleRepair.createdAt))
          .limit(1);
        // Only the old writer's own rest: a closing attempt at 2 or later on a
        // verification-reopen gate (state 2), last written after the decision was
        // marked done, on a lineage that read open from its attempt 1 until then, so
        // the carrier stands for the close that carried nothing. A lineage that closed
        // before the decision was set aside, or read closed in between, had its close
        // while the decision was not yet the family's, or after it.
        if (closing && closing.attempt >= 2 && closing.gateTaskId.startsWith(VERIFICATION_REOPEN_TASK_PREFIX) &&
            closing.closedAfterDecision && closing.openThroughout && !held.has(closing.gateId)) {
          gateId = closing.gateId;
          rootTaskId = leg.reviewTaskId;
          break;
        }
      }
    } else {
      return { ...pause, outcome: "ops" as const, reason: "unknown-intent-status" as const };
    }
    if (!gateId) return { ...pause, outcome: "ops" as const, reason: "no-free-gate" as const };

    const marker = await tx
      .insert(artifactReviewResumeRecovery)
      .values({ runId: pause.runId, baseReviewTaskId: pause.baseTaskId, road, gateId })
      .onConflictDoNothing()
      .returning({ gateId: artifactReviewResumeRecovery.gateId });
    if (marker.length !== 1) return skip("already-recovered");
    const wrote = road === "rearm"
      ? await rearmExhaustedResumeIntent(tx, gateId)
      : await insertRecoveryCarrier(tx, {
          gateId, runId: pause.runId, reviewTaskId: rootTaskId!, kind: decision.kind, responseText: decision.responseText,
        });
    // Rolls the marker back with the transaction.
    if (!wrote) throw new RecoveryRaced(`pause ${pause.runId} ${pause.baseTaskId}: the ${road} wrote nothing`);
    return road === "rearm"
      ? { ...pause, outcome: "rearmed" as const, gateId }
      : { ...pause, outcome: "carried" as const, gateId, decisionGateId: decision.gateId };
  });
}
