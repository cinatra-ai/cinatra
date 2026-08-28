import "server-only";

// ---------------------------------------------------------------------------
// run-produced-review-hold (cinatra#3007)
//
// THE ORDERING INVARIANT: no run whose produced output opens a review gate
// reaches a terminal status before that review is decided.
//
// A gate the agent's own template DECLARES already obeys it — the executor mints
// the gate and only then moves the run to `pending_approval`
// (execution.ts, the marked-gate branch). A gate opened by what the run PRODUCED
// did not: the artifact write splices a produced-event row into the writer's own
// transaction, and nothing on the execution path waited for that row to be acted
// on. The row was drained by a recurring background job, so the gate was minted
// AFTER the run had already been written `completed` — a terminal status with no
// legal edge out, which no decision can release.
//
// This module is that missing ordering constraint, as three parts:
//
//   resolveProducedReviewHold — the ROW-GROUNDED question, asked of the store and
//     of nothing else: does this run have a produced event still awaiting
//     orchestration, or one linked to a gate nobody has decided? It is the SAME
//     question before the terminal write and after a decision, so park and
//     release can never disagree about what holds a run.
//
//   holdRunForProducedReview — the executor's call, made after materialization
//     and BEFORE either terminal transition. It drains this run's produced events
//     inline (bounded), asks the question, and — when the answer is yes — parks
//     the run in `pending_approval` carrying the terminal write it is withholding.
//
//   releaseHeldRun — the decision's call. The withheld terminal write is
//     performed, with whichever terminal status the decision implies.
//
// WHY THE INLINE DRAIN AND NOT A SECOND DECISION. The review decision for a
// produced event is `orchestrateProducedEvent`: prove the binding, resolve the
// context, plan against the policy lattice, emit the idempotent gate. Re-deriving
// any part of that here would fork the one review core into two implementations
// that must agree forever. So the executor runs the EXISTING drain, scoped to its
// own production, and then reads the rows it wrote. The recurring sweep is
// unchanged and stays the backstop: it still serves produced events from paths
// that are not agent runs, and it still converges a run whose inline drain failed
// (that run is parked, not completed, so the ordering holds while it waits).
//
// WHAT IS DELIBERATELY NOT TOUCHED. A run parked by a template-DECLARED gate
// carries no withheld terminal write, and every entry point here refuses a run
// without one. The declared path keeps minting before it parks, and keeps being
// released by the resume delivery it has always used.
// ---------------------------------------------------------------------------

import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";

import { db } from "./db";
import { agentRuns, artifactProducedOutbox, artifactReviewGates } from "./schema";
import { transitionRunStatus } from "./run-transition";
import { RunTransitionError, type AgentRunStatus } from "./run-status";

/**
 * The unbound-output derivation capture, structurally identical to
 * `./run-terminal-derivation-outbox`'s `DerivationOutboxCapture` and declared
 * here rather than imported.
 *
 * This module is reached by a DYNAMIC import from the executor precisely so it
 * adds no static edge to the four locked dev-perf routes the route-graph ratchet
 * guards, and the same duplication precedent already exists on that hot path
 * (`buildReviewRunBasePath` in execution.ts). The value is carried verbatim and
 * handed straight back to `transitionRunStatus`, which types it for real.
 */
export type WithheldDerivationOutbox = {
  orgId: string;
  templateId: string;
  packageVersion: string | null;
  createdBy: string | null;
  content: string;
  contentIsJson: boolean;
  contentHash: string;
};

/** The status a run waits on a gate in. The declared path enters it before its
 *  own gate's decision; the produced path now enters it before ITS gate's. */
const PARKED_STATUS: AgentRunStatus = "pending_approval";

/** How many of a run's produced events one inline drain will act on. A run's
 *  production is bounded by its declared bindings (single digits in practice);
 *  the cap exists so a pathological production can never turn one run's
 *  completion into an unbounded drain. Anything beyond it stays pending — which
 *  HOLDS the run (`awaiting-orchestration`) and is finished by the sweep. */
export const INLINE_DRAIN_EVENT_CAP = 200;

// ---------------------------------------------------------------------------
// The withheld terminal write.
// ---------------------------------------------------------------------------

/**
 * The terminal transition the executor did not perform, carried on the parked
 * run so the decision can perform it later, unchanged.
 *
 * It rides as an additive key on the run's own `wayflow_response` step result —
 * the one durable payload the park transition already writes — rather than in a
 * new column, so the fix needs no schema change. `releaseHeldRun` STRIPS it
 * before the terminal write, so a released run's row is byte-identical to the
 * one today's immediate write produces.
 */
export interface WithheldTerminal {
  /** The terminal status the executor had decided on: `completed`, or `failed`
   *  when the materialization-honesty gate had already ruled the run a failure. */
  status: "completed" | "failed";
  /** The failure reason, on the `failed` branch only. */
  error?: string;
  /** The unbound-output derivation capture the terminal write commits with the
   *  status CAS. Carried verbatim: it is derived from the run's final output
   *  text, which the parked payload does not preserve losslessly. */
  derivationOutbox?: WithheldDerivationOutbox;
}

/** The key the withheld terminal write rides under. Present ONLY while a run is
 *  parked on its produced output's review. */
export const WITHHELD_TERMINAL_KEY = "lifecycle_review_withheld_terminal";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Attach the withheld terminal write to the terminal step-results payload,
 * PURELY (the input is not mutated). The marker goes on the FIRST object entry —
 * the single `wayflow_response` / `external_a2a_response` record both executor
 * paths build — so the array's shape, length and element kinds are unchanged and
 * every existing consumer reads it exactly as before.
 */
export function attachWithheldTerminal(
  stepResults: readonly unknown[],
  withheld: WithheldTerminal,
): unknown[] {
  const out = [...stepResults];
  const first = out[0];
  if (isRecord(first)) {
    out[0] = { ...first, [WITHHELD_TERMINAL_KEY]: withheld };
    return out;
  }
  // No record to carry it (an empty payload). Carry it as its own entry rather
  // than dropping it — a withheld terminal write that vanishes is a stranded run.
  out.unshift({ [WITHHELD_TERMINAL_KEY]: withheld });
  return out;
}

/** Read back the withheld terminal write, or null when this run is not parked on
 *  a produced review (a template-declared gate's park carries no marker). */
export function readWithheldTerminal(stepResults: unknown): WithheldTerminal | null {
  if (!Array.isArray(stepResults)) return null;
  for (const entry of stepResults) {
    if (!isRecord(entry)) continue;
    const raw = entry[WITHHELD_TERMINAL_KEY];
    if (!isRecord(raw)) continue;
    const status = raw.status;
    if (status !== "completed" && status !== "failed") continue;
    return {
      status,
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
      ...(isRecord(raw.derivationOutbox)
        ? { derivationOutbox: raw.derivationOutbox as unknown as WithheldDerivationOutbox }
        : {}),
    };
  }
  return null;
}

/**
 * Remove the marker, restoring the payload the executor would have written had it
 * never parked. The inverse of `attachWithheldTerminal`: an entry that existed
 * only to carry the marker is dropped; an entry that carried it alongside real
 * content keeps the content.
 */
export function stripWithheldTerminal(stepResults: unknown): unknown[] {
  if (!Array.isArray(stepResults)) return [];
  const out: unknown[] = [];
  for (const entry of stepResults) {
    if (!isRecord(entry) || !(WITHHELD_TERMINAL_KEY in entry)) {
      out.push(entry);
      continue;
    }
    const rest = { ...entry };
    delete rest[WITHHELD_TERMINAL_KEY];
    if (Object.keys(rest).length > 0) out.push(rest);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The row-grounded question.
// ---------------------------------------------------------------------------

export type ProducedReviewHold =
  /** Nothing this run produced opens a review — the run takes its terminal write
   *  immediately, exactly as before. */
  | { held: false; reason: "no-produced-output" | "no-review" }
  /** A produced event has not been orchestrated yet, so whether a review opens is
   *  still UNKNOWN. Unknown is not "no": the run holds. */
  | { held: true; reason: "awaiting-orchestration"; eventIds: string[] }
  /** A gate this run's output opened is undecided. */
  | { held: true; reason: "gate-undecided"; gateIds: string[] };

/** What the decisions on this run's produced-output gates add up to. */
export type ProducedReviewDecision =
  | { decided: false; hold: ProducedReviewHold }
  | { decided: true; rejected: boolean };

interface LinkedGateRow {
  gateId: string;
  status: string;
  disposition: string | null;
}

/** Every gate this run's PRODUCED output opened, joined through the produced
 *  event's own linkage (`continuation_address`) — never by run id alone, which
 *  would also sweep up a template-declared gate that has nothing to do with what
 *  the run produced. */
async function readLinkedGates(orgId: string, runId: string): Promise<LinkedGateRow[]> {
  const linked = await db
    .select({ gateId: artifactProducedOutbox.continuationAddress })
    .from(artifactProducedOutbox)
    .where(
      and(
        eq(artifactProducedOutbox.orgId, orgId),
        eq(artifactProducedOutbox.producerRunId, runId),
        sql`${artifactProducedOutbox.continuationAddress} IS NOT NULL`,
      ),
    );
  const gateIds = [...new Set(linked.map((r) => r.gateId).filter((id): id is string => !!id))];
  if (gateIds.length === 0) return [];
  const rows = await db
    .select({
      gateId: artifactReviewGates.id,
      status: artifactReviewGates.status,
      disposition: artifactReviewGates.disposition,
    })
    .from(artifactReviewGates)
    .where(and(eq(artifactReviewGates.orgId, orgId), inArray(artifactReviewGates.id, gateIds)));
  return rows;
}

/** The produced events of this run that no orchestration pass has settled yet. */
async function readPendingEventIds(orgId: string, runId: string): Promise<string[]> {
  const rows = await db
    .select({ eventId: artifactProducedOutbox.eventId })
    .from(artifactProducedOutbox)
    .where(
      and(
        eq(artifactProducedOutbox.orgId, orgId),
        eq(artifactProducedOutbox.producerRunId, runId),
        eq(artifactProducedOutbox.status, "pending"),
      ),
    );
  return rows.map((r) => r.eventId);
}

/**
 * Does a review this run's output opened still hold it? Asked of the rows, so the
 * answer is the same whoever asks and whenever: before the terminal write (park
 * if held) and after a decision (release if not).
 */
export async function resolveProducedReviewHold(
  orgId: string,
  runId: string,
): Promise<ProducedReviewHold> {
  const pending = await readPendingEventIds(orgId, runId);
  if (pending.length > 0) {
    return { held: true, reason: "awaiting-orchestration", eventIds: pending };
  }
  const gates = await readLinkedGates(orgId, runId);
  if (gates.length === 0) return { held: false, reason: "no-review" };
  const undecided = gates.filter((g) => g.status !== "resolved").map((g) => g.gateId);
  if (undecided.length > 0) return { held: true, reason: "gate-undecided", gateIds: undecided };
  return { held: false, reason: "no-review" };
}

/**
 * The hold, plus what the decisions say when it has cleared. A REJECT on any gate
 * this run's output opened means the output was refused, so the run's terminal
 * status is `failed` however the execution itself went.
 */
export async function resolveProducedReviewDecision(
  orgId: string,
  runId: string,
): Promise<ProducedReviewDecision> {
  const hold = await resolveProducedReviewHold(orgId, runId);
  if (hold.held) return { decided: false, hold };
  const gates = await readLinkedGates(orgId, runId);
  return { decided: true, rejected: gates.some((g) => g.disposition === "reject") };
}

// ---------------------------------------------------------------------------
// The executor's park.
// ---------------------------------------------------------------------------

/** The bounded inline drain, run UNDER the production lock. Injectable so a test
 *  can DELAY it deterministically (a drain that does nothing leaves the events
 *  pending, which is exactly the race the invariant has to survive) — production
 *  passes nothing. */
export type ProducedReviewDrain = (input: { orgId: string; runId: string }) => Promise<void>;

/**
 * The boot-registered orchestration half, read STRUCTURALLY off the runner slot
 * rather than imported.
 *
 * The store this reaches is deliberately unreachable from the locked dev-perf
 * routes (route-graph ratchet), and the executor that calls into this module
 * sits in every one of them — so the boot phase registers the two entry points
 * and this reads them, exactly as the background-job registry does for the two
 * recurring sweeps. No import, no edge.
 *
 * Null before boot has registered it, and on a deployment that opted the slice
 * out. Both are safe: with no inline drain the run parks on its still-pending
 * production and the recurring sweep finishes the orchestration, so the ordering
 * invariant holds and only the latency differs.
 */
function orchestrationSlot(): {
  drainProducedProductionForRun?: (input: {
    orgId: string;
    runId: string;
    limit?: number;
  }) => Promise<void>;
  withProducedProductionLock?: (
    orgId: string,
    producerRunId: string,
    fn: () => Promise<void>,
  ) => Promise<boolean>;
} | null {
  return (
    (
      globalThis as {
        __cinatraLifecycleReviewRunner?: {
          drainProducedProductionForRun?: (input: {
            orgId: string;
            runId: string;
            limit?: number;
          }) => Promise<void>;
          withProducedProductionLock?: (
            orgId: string,
            producerRunId: string,
            fn: () => Promise<void>,
          ) => Promise<boolean>;
        };
      }
    ).__cinatraLifecycleReviewRunner ?? null
  );
}

export interface HoldRunInput {
  runId: string;
  orgId: string;
  /** The status the executor's own terminal CAS would have been made from. */
  fromStatus: AgentRunStatus;
  /** The terminal step-results payload the executor built. */
  stepResults: readonly unknown[];
  /** The terminal transition being withheld. */
  withheld: WithheldTerminal;
  /** Test seam (see `ProducedReviewDrain`). */
  drain?: ProducedReviewDrain;
}

export type HoldRunOutcome =
  /** The run is parked, or cannot be proven free to finish; either way the caller
   *  must NOT write a terminal status. */
  | {
      held: true;
      reason:
        | "awaiting-orchestration"
        | "gate-undecided"
        | "orchestration-contended"
        | "stale-from-status"
        | "hold-check-failed";
    }
  /** Nothing holds the run; the caller writes its terminal status as before. */
  | { held: false; reason: "no-produced-output" | "no-review" | "review-inactive" };

/**
 * Park the run on its produced output's review, if one opens.
 *
 * TOTAL by contract — it never throws, so the executor's call site needs no
 * recovery path (the same posture `materializeRunArtifacts` holds one branch
 * above it).
 *
 * FAIL-CLOSED, which is the whole point. Every answer this cannot reach honestly
 * resolves toward the run NOT reporting success: a drain that fails leaves the
 * events pending, and pending is a hold; a read that fails cannot prove there is
 * no review, so it holds; a park that fails still returns `held`, so the caller
 * writes no terminal status and the run stays `running` for the lease-expiry
 * finalizer to reconcile. Answering "no review" on a fault is what produced
 * cinatra#3007 in the first place, and no branch here does it.
 *
 * THE ONE EXCEPTION is the fence: when the review slice is switched off the
 * emitters write no produced events at all, so there is no review to wait for and
 * the run keeps today's immediate terminal write.
 */
export async function holdRunForProducedReview(
  input: HoldRunInput,
  authority: OrgWriteAuthority | undefined,
): Promise<HoldRunOutcome> {
  const { runId, orgId } = input;
  // The slice is INERT when the fence is off — no produced events are written, so
  // nothing can open a review, and a run must not park waiting for a drain that
  // is not running either.
  const { isLifecycleReviewOrchestrationActive } = await import(
    "@/lib/lifecycle/lifecycle-activation"
  );
  if (!isLifecycleReviewOrchestrationActive()) {
    return { held: false, reason: "review-inactive" };
  }
  try {
    // The overwhelming majority of runs produce no durable artifact at all. One
    // indexed existence probe (org_id, producer_run_id) keeps them on exactly
    // today's path.
    let produced: { eventId: string } | undefined;
    try {
      [produced] = await db
        .select({ eventId: artifactProducedOutbox.eventId })
        .from(artifactProducedOutbox)
        .where(
          and(
            eq(artifactProducedOutbox.orgId, orgId),
            eq(artifactProducedOutbox.producerRunId, runId),
          ),
        )
        .limit(1);
    } catch (err) {
      // We cannot prove the run produced nothing, so we do not claim it — and we
      // do NOT park it either: a park with no production behind it is invisible
      // to the release drain and would strand. The run keeps its current
      // non-terminal status, which the lease-expiry finalizer reconciles.
      console.error(
        `[produced-review-hold] run=${runId} produced-output probe failed — no terminal write (fail-closed):`,
        err,
      );
      return { held: true, reason: "hold-check-failed" };
    }
    if (!produced) return { held: false, reason: "no-produced-output" };

    // Decide the review moment through the ONE review core, scoped to this run's
    // own production, and both READ the result and TAKE THE PARK without letting
    // go of the production lock: a concurrent orchestration pass can neither mint
    // this run's gate between the read and the park, nor observe a half-parked
    // run.
    const slot = orchestrationSlot();
    const drain: ProducedReviewDrain =
      input.drain ??
      (slot?.drainProducedProductionForRun
        ? (i) =>
            slot.drainProducedProductionForRun!({ ...i, limit: INLINE_DRAIN_EVENT_CAP })
        : async () => {
            console.warn(
              `[produced-review-hold] run=${runId} no orchestration drain is registered — ` +
                `parking on the unorchestrated production for the recurring sweep`,
            );
          });
    const critical = async () => {
      try {
        await drain({ orgId, runId });
      } catch (err) {
        console.error(
          `[produced-review-hold] run=${runId} inline orchestration failed — the run parks on its ` +
            `unorchestrated production rather than reporting success:`,
          err,
        );
      }
      const hold = await resolveProducedReviewHold(orgId, runId);
      outcome = hold.held
        ? await parkRun(input, authority, hold.reason)
        : { held: false, reason: hold.reason };
    };
    let outcome: HoldRunOutcome | null = null;
    // Without the lock the drain and the read are still correct — a sweep racing
    // them can only mint the very gate this read is looking for, and a park is
    // row-grounded either way; the lock removes the window rather than the
    // correctness.
    const locked = slot?.withProducedProductionLock
      ? await slot.withProducedProductionLock(orgId, runId, critical)
      : await critical().then(() => true);

    // Contended: another pass owns this production right now, so its events are
    // mid-orchestration. Unknown is not "no" — the run has a production behind
    // it (the probe proved that), so parking it is both safe and releasable.
    if (!locked) return await parkRun(input, authority, "orchestration-contended");
    // `outcome` is assigned inside the locked callback; TypeScript cannot see it.
    const settled = outcome as HoldRunOutcome | null;
    // The callback threw before assigning (its own errors are caught above, so
    // this is the predicate read failing). Hold without parking, as the probe
    // failure does.
    if (!settled) return { held: true, reason: "hold-check-failed" };
    return settled;
  } catch (err) {
    console.error(
      `[produced-review-hold] run=${runId} hold check failed — no terminal write (fail-closed):`,
      err,
    );
    return { held: true, reason: "hold-check-failed" };
  }
}

/** Write the park: the run enters the status it waits on a gate in, carrying the
 *  terminal transition the executor is withholding. */
async function parkRun(
  input: HoldRunInput,
  authority: OrgWriteAuthority | undefined,
  reason: Extract<HoldRunOutcome, { held: true }>["reason"],
): Promise<HoldRunOutcome> {
  const { runId, orgId, fromStatus } = input;
  const parkedStepResults = attachWithheldTerminal(input.stepResults, input.withheld);
  try {
    // Already parked (a template-declared gate resumed into this production):
    // there is no status edge to take, only the withheld write to record. The
    // update is ORG-SCOPED and PREDICATED on the row still being parked, so it can
    // never stamp a marker onto a row a concurrent stop or release has moved on.
    if (fromStatus === PARKED_STATUS) {
      await db
        .update(agentRuns)
        .set({ stepResults: JSON.stringify(parkedStepResults) })
        .where(
          and(
            eq(agentRuns.id, runId),
            eq(agentRuns.orgId, orgId),
            eq(agentRuns.status, PARKED_STATUS),
          ),
        );
      console.log(
        `[produced-review-hold] run=${runId} stays parked on its produced output's review (${reason})`,
      );
      return { held: true, reason };
    }

    let stale = false;
    await transitionRunStatus(
      runId,
      fromStatus,
      PARKED_STATUS,
      { stepResults: parkedStepResults },
      authority,
    ).catch((err) => {
      // A concurrent stop/cancel already moved the row. The executor's own
      // terminal CAS would be just as stale, so it must still not write one.
      if (err instanceof RunTransitionError && err.code === "stale_from_status") {
        stale = true;
        return;
      }
      throw err;
    });
    if (stale) {
      console.log(
        `[produced-review-hold] run=${runId} left ${fromStatus} concurrently — no terminal write`,
      );
      return { held: true, reason: "stale-from-status" };
    }
    console.log(
      `[produced-review-hold] run=${runId} parked at its review moment (${reason}); the ` +
        `terminal ${input.withheld.status} write waits for the decision`,
    );
    return { held: true, reason };
  } catch (err) {
    // The park itself failed. The run stays where it is and the caller writes NO
    // terminal status — a run left `running` is reconciled by the lease-expiry
    // finalizer, where a run falsely written `completed` never is.
    console.error(`[produced-review-hold] run=${runId} could not be parked:`, err);
    return { held: true, reason: "hold-check-failed" };
  }
}

// ---------------------------------------------------------------------------
// The decision's release.
// ---------------------------------------------------------------------------

export type ReleaseOutcome =
  | { released: true; terminal: "completed" | "failed" }
  | {
      released: false;
      reason: "not-parked" | "not-produced-review-park" | "still-held" | "stale-from-status";
    };

/**
 * Perform the terminal write the run parked instead of making.
 *
 * Idempotent and re-drivable: a run that is no longer parked, or that is parked
 * for another reason, or that is still held, is left exactly as it is. So an
 * at-least-once caller can drive it as often as it likes, and two callers racing
 * settle on one CAS.
 */
export async function releaseHeldRun(
  runId: string,
  authority: OrgWriteAuthority,
): Promise<ReleaseOutcome> {
  const [run] = await db
    .select({ status: agentRuns.status, stepResults: agentRuns.stepResults })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, authority.orgId)))
    .limit(1);
  if (!run || run.status !== PARKED_STATUS) return { released: false, reason: "not-parked" };

  const parsed = parseStepResults(run.stepResults);
  const withheld = readWithheldTerminal(parsed);
  // A park with no withheld terminal write is NOT ours — a template-declared
  // gate's park is released by its own resume delivery, and touching it here
  // would be a second path to the same run's terminal status.
  if (!withheld) return { released: false, reason: "not-produced-review-park" };

  const decision = await resolveProducedReviewDecision(authority.orgId, runId);
  if (!decision.decided) return { released: false, reason: "still-held" };

  const stripped = stripWithheldTerminal(parsed);
  const terminal = decision.rejected ? "failed" : withheld.status;
  const error = decision.rejected
    ? withheld.error ??
      "the review of this run's output was rejected, so the output was not accepted"
    : withheld.error;

  let stale = false;
  await transitionRunStatus(
    runId,
    PARKED_STATUS,
    terminal,
    {
      // ALWAYS written, even when stripping leaves nothing: the marker lives in
      // this column, so omitting the key would leave it on the terminal row
      // instead of clearing it. What lands is exactly the payload the executor
      // would have written outright.
      stepResults: stripped,
      ...(error !== undefined ? { error } : {}),
      ...(terminal === "completed" ? { completedAt: new Date() } : {}),
      // The derivation capture is legal on the terminal-SUCCESS edge only, and a
      // rejected run does not take it.
      ...(terminal === "completed" && withheld.derivationOutbox
        ? { derivationOutbox: withheld.derivationOutbox }
        : {}),
    },
    authority,
  ).catch((err) => {
    if (err instanceof RunTransitionError && err.code === "stale_from_status") {
      stale = true;
      return;
    }
    throw err;
  });
  if (stale) return { released: false, reason: "stale-from-status" };

  // THE REST OF THE TERMINAL TAIL. The executor returned before its own, so this
  // is where the run's end is announced and its terminal sidecars run — otherwise
  // a released run would reach a terminal row while the live panel kept spinning
  // on a run it was never told had ended. Best-effort, in the executor's own
  // order and with the executor's own posture: none of them may destabilize a
  // terminal transition that has already committed.
  await announceRelease(runId, authority.orgId, terminal, error, withheld);

  console.log(
    `[produced-review-hold] run=${runId} released by the review decision → ${terminal}`,
  );
  return { released: true, terminal };
}

/**
 * The terminal announcements + sidecars the executor's tail performs after its
 * own terminal transition, run here because the release performed that
 * transition instead: the AG-UI terminal event (so the run panel stops), the
 * unbound-output derivation enqueue (only for a terminal SUCCESS that captured
 * one), and the skill-autosave sidecar — in the executor's own order (enqueue,
 * announce, autosave). Every one is best-effort and swallowed, exactly as at the
 * original call site.
 *
 * Dynamically imported so this module's static graph stays a leaf.
 */
async function announceRelease(
  runId: string,
  orgId: string,
  terminal: "completed" | "failed",
  error: string | undefined,
  withheld: WithheldTerminal,
): Promise<void> {
  // 1. The unbound-output derivation enqueue, first — the executor enqueues before
  //    it announces, and only for a terminal SUCCESS that captured a row.
  if (terminal === "completed" && withheld.derivationOutbox) {
    try {
      const { enqueueBackgroundJob } = await import("@/lib/background-jobs");
      const { BACKGROUND_JOB_NAMES } = await import("@/lib/background-jobs-names");
      await enqueueBackgroundJob(
        BACKGROUND_JOB_NAMES.UNBOUND_OUTPUT_DERIVE,
        { runId, orgId },
        {
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          jobId: `unbound-output-derive__${runId}`,
          inheritActorContext: false,
        },
      );
    } catch (err) {
      console.warn(
        `[produced-review-hold] run=${runId} derive enqueue threw (outbox persisted; sweep backstops):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 2. The terminal AG-UI event, so the run panel stops rather than spinning on a
  //    run it was never told had ended.
  try {
    const { publishAgUiEvent } = await import("@cinatra-ai/agent-ui-protocol/server");
    await Promise.resolve(
      publishAgUiEvent(
        runId,
        (terminal === "completed"
          ? { type: "RUN_FINISHED", threadId: runId, runId, status: "completed", timestamp: Date.now() }
          : {
              type: "RUN_ERROR",
              threadId: runId,
              runId,
              message: error ?? "the run ended without being accepted",
              timestamp: Date.now(),
            }) as never,
      ),
    ).catch(() => undefined);
  } catch (err) {
    console.warn(`[produced-review-hold] run=${runId} terminal AG-UI event failed:`, err);
  }

  // 3. The autosave sidecar, after the announcement, on the success edge only.
  if (terminal !== "completed") return;
  try {
    const { runSkillAutosaveOnRunCompletion } = await import("./skill-autosave");
    await runSkillAutosaveOnRunCompletion(runId).catch((err: unknown) => {
      console.warn(`[skill-autosave] autosave failed, run=${runId}`, err);
    });
  } catch (err) {
    console.warn(`[skill-autosave] autosave unavailable, run=${runId}`, err);
  }
}

function parseStepResults(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** The run a gate belongs to, and that run's org — what a release caller needs to
 *  mint its authority. Null for a gate id that names no row. */
export async function readGateRunOwner(
  gateId: string,
): Promise<{ runId: string; orgId: string } | null> {
  const [row] = await db
    .select({ runId: artifactReviewGates.runId, orgId: artifactReviewGates.orgId })
    .from(artifactReviewGates)
    .where(eq(artifactReviewGates.id, gateId))
    .limit(1);
  return row ?? null;
}

/**
 * The runs whose produced-review hold has ACTUALLY CLEARED — the release drain's
 * candidate set, decided in SQL.
 *
 * Two properties matter, and both are why the predicate lives in the query rather
 * than in a filter after the LIMIT:
 *
 *   NO STARVATION. A bounded pass that selected arbitrary parked runs would keep
 *     returning the same still-undecided parks forever, and a run whose review
 *     expired behind them would never be looked at. Every row this returns is
 *     releasable, so the bound consumes progress instead of re-reading the queue.
 *
 *   NO ZERO-GATE STRAND. A park can clear without any gate ever existing: a drain
 *     that finally classifies the event as opening NO review marks it processed
 *     and links nothing. So the predicate is "no pending event AND no undecided
 *     linked gate" — not "has a resolved gate", which would never see that run.
 *
 * A run parked for any OTHER reason is refused by `releaseHeldRun`'s
 * withheld-terminal marker, which this query deliberately does not try to read.
 */
export async function listReleasableHeldRuns(
  limit = 50,
): Promise<Array<{ runId: string; orgId: string }>> {
  const bounded = Math.max(1, Math.min(limit, 200));
  const rows = await db
    .select({ runId: agentRuns.id, orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, PARKED_STATUS),
        // ...carries a WITHHELD TERMINAL WRITE, so it is one of OUR parks. This
        // has to be in the SQL, before the LIMIT, and not left to
        // `releaseHeldRun`'s refusal: a template-declared park on a run that also
        // has processed produced events matches everything else here, and a
        // stable page of those would occupy every bounded pass forever while a
        // genuinely releasable park behind them was never reached. The text match
        // is a CANDIDATE filter; the authoritative read is still
        // `readWithheldTerminal` on the parsed payload.
        like(agentRuns.stepResults, `%${WITHHELD_TERMINAL_KEY}%`),
        // has a production behind it...
        sql`EXISTS (
          SELECT 1 FROM ${artifactProducedOutbox} o
          WHERE o.producer_run_id = ${agentRuns.id} AND o.org_id = ${agentRuns.orgId}
        )`,
        // ...nothing of it is still awaiting orchestration...
        sql`NOT EXISTS (
          SELECT 1 FROM ${artifactProducedOutbox} o
          WHERE o.producer_run_id = ${agentRuns.id} AND o.org_id = ${agentRuns.orgId}
            AND o.status = 'pending'
        )`,
        // ...and every gate its output opened has been decided.
        sql`NOT EXISTS (
          SELECT 1 FROM ${artifactProducedOutbox} o
          JOIN ${artifactReviewGates} g ON g.id = o.continuation_address
          WHERE o.producer_run_id = ${agentRuns.id} AND o.org_id = ${agentRuns.orgId}
            AND g.status <> 'resolved'
        )`,
      ),
    )
    .orderBy(agentRuns.id)
    .limit(bounded);
  return rows;
}
