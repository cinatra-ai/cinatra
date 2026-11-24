import "server-only";

// ---------------------------------------------------------------------------
// lifecycle-repair-dispatch-store (cinatra#2047 defect D-1, epic #2037 S2)
//
// The DELIVERY half of the repair loop — the step D-1 found missing in product.
//
// S2 (#2040) shipped `recordChangesRequested` (close the review attempt, open a
// durable repair, ROUTE it) and `submitRepairResponse` (the producer's typed
// response → successor gate + verification trigger). Between those two the plan
// specifies: "typed request … delivered per continuation mode — resume for
// checkpointed flows, a NEW DISPATCHED REPAIR RUN for completed ones". Nothing
// implemented that delivery: `markRepairDispatched` had zero production callers,
// so even a correctly-routed `producer_repair` sat at `status='requested'`
// forever and no producer was ever told to repair.
//
// This drain is that delivery:
//
//   • an ASYNC-EFFECTS-GATED `producer_repair` repair gets a DETERMINISTIC repair
//     run (`lifecycle-repair-run:<repairId>`) on the PRODUCING template, whose
//     `input_params` carry the typed `ChangesRequestedRequest` — that row IS the
//     delivered request; the producing agent's own graph reads it on that run and
//     answers through `submitRepairResponse`, which pins the successor gate and
//     fires the post-change verification. There is no direct-call repair entry
//     point: the NEW-RUN road IS the repair road (cinatra#2951, the product
//     decision recorded there on 2026-09-11);
//   • the repair is then CAS'd `requested` → `dispatched` (idempotent);
//   • a repair whose producing run/template cannot be resolved — i.e. there is no
//     producer to deliver to — is ESCALATED rather than left silently pending
//     ("nothing silently drops", S2 AC);
//   • a CHECKPOINTED repair is likewise ESCALATED, with its reason recorded. The
//     plan's checkpointed half is a RESUME of the parked producing run at its
//     continuation address, not a new run (S2: "resume for checkpointed flows, a
//     new dispatched repair run for completed ones"); that resume is not shipped
//     here, and delivering a checkpointed repair through the new-run mechanism
//     would be the WRONG mechanism silently applied. Fail-closed to a human
//     instead (Codex round, finding E).
//
// SCOPE, stated plainly: this drain DELIVERS the request and makes the hand-off
// durable + idempotent; the producing agent's own graph does the repairing work,
// exactly like any other agent run. The `requested → dispatched` move is
// therefore "the producer has been told AND set running", not merely "told"; a
// producer that never answers leaves a `dispatched` repair and a PENDING base
// produced-event — both ops-visible, neither silently dropped.
//
// The repair run is minted through `createAgentRun` — the single OBO-ceiling
// primitive (#1035) — as a CHILD DISPATCH under the producing run, threading the
// producing run's PERSISTED ceiling chain as the compose operand. The child's own
// ceiling is server-derived inside the primitive; a provably-disjoint composition
// throws and the delivery fails closed with nothing written.
//
// cinatra#2286 S10 PR2 — THE EXECUTION BRIDGE + THE PRINCIPAL FIX. Before this
// slice `createAgentRun` minted the row `queued` and NOTHING enqueued its BullMQ
// execution job — a delivered repair sat forever un-run (dead code path; no
// producer had ever declared `repairCapable`, so it was never reached in
// production). This slice:
//   • actually ENQUEUES the repair run (`enqueueAgentRun`, `jobId: runId` for
//     BullMQ-level dedup across a re-drain) so a `dispatched` repair genuinely
//     runs, dispatched exactly like any other agent run;
//   • puts the reviewer's findings into the input the producer declares for
//     them (cinatra#4424: `cinatra.lifecycle.repairFindingsInput`, projected by
//     `projectRepairFindingsInput`, `@/lib/lifecycle/lifecycle-policy`), for
//     every base whatever its kind; a producer that declares nothing gets its
//     own inputs plus the typed request;
//   • THE SECURITY FIX: the dispatched run's ActorContext is the ORIGINATING
//     producing run's own `runBy`, re-verified LIVE at dispatch time via
//     `resolveOrgRoleForUser` (never trusted from whatever the producing run
//     carried at produce time, and never deferred to the write). Without this,
//     `enqueueAgentRun`'s worker frame would carry NO actor for a runBy-less
//     producing run, and `buildActorContextFromRun` degrades a runBy-less run to
//     an `InternalWorker` principal with empty project grants — a
//     system-authority principal masquerading as a content-write actor. A
//     producing run with no human `runBy`, or whose `runBy` no longer resolves a
//     live org membership, is ESCALATED to human review instead — the SAME
//     `escalateRepair` path the checkpointed/no-producer guardrails already use,
//     never dispatched "and hoped".
//
// No schema change: the run id is derived from the repair id (the same technique
// `orphanRepairRunId` already uses for the successor gate's run slot), and the
// escalation reason rides `change_summary` behind an explicit sentinel, mirroring
// `ORPHAN_RECOVERY_CHANGE_SUMMARY` in the recovery store.
//
// SWITCHED with the rest of the loop: the only production caller is the S1
// gate-maintenance drain, which is seeded by DEFAULT (the #2047 ruling) and
// skipped only when `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=off`.
// ---------------------------------------------------------------------------

import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";

import { agentBuilderPool, db } from "./db";
import { agentRuns, agentTemplates, artifactReviewGates, lifecycleRepair } from "./schema";
import { advanceAgentRun, clearRunLifecycleMomentOrThrow, launchAgentRun } from "./lifecycle-coordinator";
import { carryDeclaredReviewDecision, markRepairDispatched } from "./lifecycle-repair-store";
import { RunTransitionError, TERMINAL_RUN_STATUSES, type AgentRunStatus } from "./run-status";
import { stopRunRespectingPauseClaim } from "./run-resume-under-claim";

import type { OboCeilingChain } from "@cinatra-ai/mcp-server/obo-ceiling";

import type { ChangesRequestedRequest, RepairFinding } from "@/lib/lifecycle/lifecycle-repair";
import {
  parseLifecycleConfigText,
  projectRepairFindingsInput,
  type CompiledManifestLifecycle,
} from "@/lib/lifecycle/lifecycle-policy";
import {
  DISPATCH_ESCALATION_PREFIX,
  hasRegenerateIntent,
  planSegmentDispatch,
  recordedRegenerateInput,
  REGENERATE_RUN_NOT_DECLARED_FORM,
} from "./regenerate-segment";
import { regenerateStepRoadDispatches } from "./regenerate-step-road";
// cinatra#1940 P3 (Decision 2): the creation perimeter is now guarded — this
// repair-delivery drain has no session, so it mints the SYSTEM
// `agent-run-dispatch` authority (a caller the design's caller matrix did not
// enumerate; found while grounding P3 against live source).
import { mintLifecycleRepairDispatchAuthority } from "@/lib/org-write/agent-run-authority-mint";
// cinatra#2286 S10 PR2 — the execution bridge + the principal fix. The
// SYSTEM dispatch authority above only ever covers minting the run ROW
// (`run.execute`/`run.complete`); it structurally cannot authorize the
// content-write the dispatched repair run will attempt through its own tool
// call. That authorization must trace to an accountable HUMAN, never to a
// generic worker identity — so this drain now (a) re-verifies LIVE, at
// dispatch time, that the ORIGINATING producing run's `runBy` is still a real
// member of the repair's org, and (b) threads that verified human as the
// dispatched run's ActorContext, so `withActorContext` carries a real
// `HumanUser` principal through to the connector's own write-authority check
// — never the `InternalWorker`-with-empty-grants fallback
// `buildActorContextFromRun` degrades to for a runBy-less run.
import { resolveOrgRoleForUser } from "@/lib/auth-session";
import { buildActorContextFromRun } from "@/lib/authz/build-actor-context-from-run";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";

/** The prefix of the deterministic run a dispatched repair is delivered on. */
export const REPAIR_RUN_PREFIX = "lifecycle-repair-run:";

/** The deterministic repair-run id for a repair. Deterministic so a re-drain
 * re-derives the SAME run (insert-on-conflict-do-nothing ⇒ idempotent delivery). */
export function repairRunId(repairId: string): string {
  return `${REPAIR_RUN_PREFIX}${repairId}`;
}

/** The repair a repair-run id belongs to, or null when the id is not one. */
export function repairIdFromRunId(runId: string | null | undefined): string | null {
  if (!runId || !runId.startsWith(REPAIR_RUN_PREFIX)) return null;
  const id = runId.slice(REPAIR_RUN_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** The sentinel a repair escalated by the DISPATCH pass carries on
 * `change_summary` (there is no dedicated reason column, and inventing one would
 * need a migration; the recovery store sets the same precedent).
 *
 * The sentinel is NOT self-describing — read it only through
 * `dispatchEscalationReason`, which requires `status === 'escalated'` first, so a
 * genuine change summary that happens to start with the same characters can never
 * be misread as an escalation reason (Codex round, finding C). */
// The sentinel itself lives in `./regenerate-segment` (the run start's
// escalation writes it without loading this store: route-graph ratchet).
export { DISPATCH_ESCALATION_PREFIX };

/** The recorded escalation reason for a repair, or null. Discriminates on STATUS
 * first — never on the prefix alone. */
export function dispatchEscalationReason(repair: {
  status: string;
  changeSummary: string | null;
}): string | null {
  if (repair.status !== "escalated") return null;
  const summary = repair.changeSummary ?? "";
  return summary.startsWith(DISPATCH_ESCALATION_PREFIX)
    ? summary.slice(DISPATCH_ESCALATION_PREFIX.length)
    : null;
}

/** The typed repair request delivered on the repair run's `input_params`. */
export interface DeliveredRepairRequest {
  kind: "lifecycle_repair_request";
  repairId: string;
  gateId: string;
  lineageId: string;
  attempt: number;
  baseTarget: { artifactId: string; representationRevisionId: string };
  expectedBaseRevisionId: string;
  findings: RepairFinding[];
  continuationMode: string;
  continuationAddress: string | null;
  /**
   * The ORIGINATING producing run's `runBy` (cinatra#2286 S10 PR2, the
   * principal fix) — the human this repair's authority traces to, re-verified
   * live at dispatch time (`resolveOrgRoleForUser`) and threaded as the
   * dispatched repair run's ActorContext. `null` only when the producing run
   * itself had no human runBy, in which case the repair is ESCALATED rather
   * than dispatched (see `dispatchPendingProducerRepairs`) — a `null` here on
   * an actually-dispatched request is therefore unreachable in practice, but
   * the field stays nullable so a pre-fix delivered row (read by
   * `readDeliveredRepairRequest` after a rolling deploy) still parses.
   */
  originatingRunBy: string | null;
}

/** Known bound: the pass takes the OLDEST `limit` pending repairs. A row whose
 * delivery keeps throwing stays `requested` and re-occupies one of those slots on
 * every pass, so `limit` simultaneously-failing rows would starve newer ones.
 * Bounding retries durably needs an attempt column (a migration), so the bound is
 * recorded here rather than silently assumed away. */
export interface RepairDispatchSummary {
  scanned: number;
  dispatched: number;
  escalated: number;
  /** Rows a concurrent drain had already moved off `requested`. */
  raced: number;
  failed: number;
}

/**
 * Deliver every pending `producer_repair` repair to its producer.
 *
 * Idempotent + concurrency-safe: the run insert is `ON CONFLICT DO NOTHING` on the
 * deterministic id, and the status move is a CAS from `requested` (the loser of a
 * race counts as `raced` and writes nothing). A Regenerate is delivered under one
 * claim of its repair (`withRepairDispatchClaim`); a claim held by another drain
 * counts as `raced`. Never throws — a per-row failure is counted and the row stays
 * `requested` for the next pass.
 */
export async function dispatchPendingProducerRepairs(opts?: {
  limit?: number;
}): Promise<RepairDispatchSummary> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 25, 200));
  const summary: RepairDispatchSummary = {
    scanned: 0,
    dispatched: 0,
    escalated: 0,
    raced: 0,
    failed: 0,
  };

  // cinatra#4245: a repair that ended no pause (no generation) is not selected
  // while its gate's run carries a committed end mark; a later pass takes it once
  // the repair that ended the pause has stopped the run. The rows are selected
  // once: a repair selected here was committed either before the declared
  // record's sibling read (which then refuses to end the pause while it is
  // requested) or after the end mark (and is held here), because both records
  // lock the run row (lifecycle-repair-store). A repair selected here before
  // the end mark and launched while a declared record is open stays `requested`
  // until that record ends: its move to `dispatched` takes the run row FOR SHARE
  // (markRepairDispatched), so the declared record's sibling read sees it and
  // refuses. A repair moved off `requested` before the end mark is outside that
  // refusal: a dispatched one started its run before the end mark existed, and
  // an escalated one started no run.
  const runAtEndedPause = sql`EXISTS (
    SELECT 1 FROM ${artifactReviewGates} g
    JOIN ${agentRuns} r ON r.id = g.run_id AND r.org_id = g.org_id
    WHERE g.id = ${lifecycleRepair.gateId}
      AND r.status = 'pending_approval' AND r.pause_claim_phase = 'changes_requested'
  )`;
  const deliverable = and(
    eq(lifecycleRepair.status, "requested"),
    eq(lifecycleRepair.route, "producer_repair"),
    or(isNotNull(lifecycleRepair.pausedRunGeneration), sql`NOT ${runAtEndedPause}`),
  );
  const pending = await db
    .select()
    .from(lifecycleRepair)
    .where(deliverable)
    .orderBy(asc(lifecycleRepair.createdAt))
    .limit(limit);

  for (const selected of pending) {
    summary.scanned += 1;
    try {
      // cinatra#4264 B1b: every decision on a Regenerate repair is taken under
      // ONE claim of that repair (`withRepairDispatchClaim`), so two drains never
      // act on the same Regenerate at once: only the claim holder creates,
      // enqueues, stops, marks or escalates. The row is read again under the
      // claim, so a drain that selected it before another drain moved it acts
      // on what it is now. A claim held elsewhere skips the row this pass. An
      // ordinary repair (NULL intent) is delivered as before, with no claim.
      let outcome: RepairDispatchOutcome;
      if (hasRegenerateIntent(selected.regenerateNodeId)) {
        const claimed = await withRepairDispatchClaim(selected.id, async (): Promise<RepairDispatchOutcome> => {
          const [row] = await db
            .select()
            .from(lifecycleRepair)
            .where(and(eq(lifecycleRepair.id, selected.id), deliverable))
            .limit(1);
          return row ? deliverRepair(row) : "raced";
        });
        outcome = claimed === REPAIR_CLAIM_HELD_ELSEWHERE ? "raced" : claimed;
      } else {
        outcome = await deliverRepair(selected);
      }
      summary[outcome] += 1;
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[lifecycle-repair-dispatch] repair ${selected.id} dispatch failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return summary;
}

/** What one delivery did with its repair: the summary counter it adds to. */
type RepairDispatchOutcome = "dispatched" | "escalated" | "raced";

/** Sentinel: another drain holds this repair's claim this pass. */
const REPAIR_CLAIM_HELD_ELSEWHERE = Symbol("repair-claim-held-elsewhere");

/**
 * Run `fn` under a CLUSTER-WIDE postgres advisory lock keyed on the repair,
 * the same road the review orchestration takes per production
 * (`withProductionLock`, lifecycle-review-orchestration-store): the lock is
 * held on a DEDICATED pooled client and released in `finally`; the work's own
 * reads and writes go through the shared `db` pool, so the lock is a pure
 * mutex, not tied to the data path. A process that dies while it holds the
 * lock loses its session, and with it the lock. Returns the sentinel when
 * another drain holds the lock (`pg_try_advisory_lock`: never waits).
 */
async function withRepairDispatchClaim<T>(
  repairId: string,
  fn: () => Promise<T>,
): Promise<T | typeof REPAIR_CLAIM_HELD_ELSEWHERE> {
  const lockKey = `lifecycle-repair-dispatch::${repairId}`;
  const client = await agentBuilderPool.connect();
  try {
    const acquired = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [lockKey],
    );
    if (!acquired.rows[0]?.locked) return REPAIR_CLAIM_HELD_ELSEWHERE;
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]);
    }
  } finally {
    client.release();
  }
}

/**
 * Deliver ONE selected repair: the body of the drain for a row. A Regenerate
 * comes here only under its claim (`withRepairDispatchClaim`). A failure
 * throws: the caller counts it and the row stays `requested`.
 */
async function deliverRepair(row: typeof lifecycleRepair.$inferSelect): Promise<RepairDispatchOutcome> {
  // cinatra#4245: a change request that ended a run's pause (its repair row
  // keeps the generation the end mark holds) stops that run FIRST, before
  // any other branch and before any repair run starts. A failure throws: the
  // row stays `requested` and the next pass tries again.
  if (typeof row.pausedRunGeneration === "number") {
    const stop = await stopRunAtEndedPause(row.gateId, row.orgId, row.pausedRunGeneration);
    if (stop === "not-paused") {
      const escalated = await escalateRepairBeforeRunRead(
        row,
        "the run whose pause this change request ended was no longer at that pause, so no repair run is started",
      );
      return escalated ? "escalated" : "raced";
    }
  }
  if (row.continuationMode === "checkpointed") {
    // The checkpointed half of the delivery contract is a RESUME, not a new
    // run. Escalate rather than apply the wrong mechanism.
    const escalated = await escalateRepair(
      row.id,
      "checkpointed repair delivery is a resume of the parked producing run, which this drain does not implement",
    );
    return escalated ? "escalated" : "raced";
  }

  if (hasRegenerateIntent(row.regenerateNodeId) && !regenerateStepRoadDispatches()) {
    // cinatra#3080: a Regenerate (its repair names `regenerate_node_id`)
    // reruns the declared step with the Note in that step's `noteInput`
    // (cinatra#4264's step road, the segment plan below). This drain never
    // runs a Regenerate as an ordinary repair: with the step road on, every
    // Regenerate intent goes to `planSegmentDispatch`, which plans the
    // segment run or refuses it (the repair is then escalated with the
    // plan's reason). Only when the step road is off
    // (`regenerateStepRoadDispatches`, the switch the canonical operation
    // reads too) is a row that names one escalated to a person here, never
    // left `requested` with nothing to take it.
    const escalated = await escalateRepair(
      row.id,
      "a Regenerate reruns one declared step, which this drain does not implement",
    );
    return escalated ? "escalated" : "raced";
  }

  const producer = await resolveProducingTemplate(row.producerRunId, row.orgId);
  if (!producer) {
    // No producing run/template to deliver to. Escalate rather than leaving the
    // repair pending forever — the S2 AC's "nothing silently drops".
    const escalated = await escalateRepairBeforeRunRead(
      row,
      "no resolvable producing run/template to dispatch the repair to",
    );
    return escalated ? "escalated" : "raced";
  }

  // cinatra#2286 S10 PR2 — THE PRINCIPAL FIX. The re-staged write a
  // dispatched repair run's own tool call makes must trace to an
  // accountable HUMAN, never to the system dispatch authority above (which
  // mints only `run.execute`/`run.complete`, never a content-write
  // capability) and never to `buildActorContextFromRun`'s runBy-less
  // `InternalWorker` fallback (empty project grants, but still a
  // principal a looser or future connector policy could honor). So:
  //   - no human runBy on the ORIGINATING producing run at all → refuse,
  //     escalate to human review;
  //   - a runBy that no longer resolves a LIVE org membership (revoked /
  //     removed since the run was produced) → refuse, escalate — re-verified
  //     NOW, never trusted from whatever the producing run carried at
  //     produce time.
  // Nothing here is dispatched "and hoped" — the gate runs BEFORE the
  // repair run is even minted.
  const originatingRunByCandidate = producer.originatingRunBy;
  if (!originatingRunByCandidate) {
    const escalated = await escalateRepairBeforeRunRead(
      row,
      "the originating producing run carries no human runBy — dispatching a repair with no verified principal is refused",
    );
    return escalated ? "escalated" : "raced";
  }
  const originatingRole = await resolveOrgRoleForUser(row.orgId, originatingRunByCandidate);
  if (!originatingRole) {
    const escalated = await escalateRepairBeforeRunRead(
      row,
      "the originating producing run's runBy is no longer a verified member of this organization",
    );
    return escalated ? "escalated" : "raced";
  }
  // Narrowed + stable for the rest of this iteration (never re-read off
  // `producer` again, so no ambiguity across the `await`s below).
  const originatingRunBy: string = originatingRunByCandidate;

  const request: DeliveredRepairRequest = {
    kind: "lifecycle_repair_request",
    repairId: row.id,
    gateId: row.gateId,
    lineageId: row.lineageId,
    attempt: row.attempt,
    baseTarget: {
      artifactId: row.baseArtifactId,
      representationRevisionId: row.baseRepresentationRevisionId,
    },
    expectedBaseRevisionId: row.expectedBaseRevisionId,
    findings: (row.findings as RepairFinding[]) ?? [],
    continuationMode: row.continuationMode,
    continuationAddress: row.continuationAddress ?? null,
    originatingRunBy,
  };

  const runId = repairRunId(row.id);

  // The reviewer's findings go into the input the producer DECLARES for
  // them (cinatra#4424): one generic text built from the findings alone,
  // for every base, whatever its kind. A producer that declares no
  // findings input gets its own inputs plus the typed request, byte for
  // byte; the drain reads no base row and adds no input for it.
  //
  // The drain applies the declaration it reads here only to a run it
  // creates. A run that already exists (a re-drain after a crash between creation and enqueue)
  // is enqueued with the inputs it was created with, and any run can wait
  // in the queue while the template is re-imported: the worker's run start
  // (`bindRepairFindingsInputAtStart`, `./execution.ts`) re-derives the
  // findings input from the template it executes.
  const findingsInputParams: Record<string, unknown> =
    projectRepairFindingsInput(producer.lifecycle, request.findings) ?? {};

  // cinatra#4264 B1b — a REGENERATE (the repair names `regenerate_node_id`)
  // reruns one step and its filing node of the run that filed the reviewed
  // revision. Its run's parent is THAT run (the provenance run, which the
  // context inheritance reads), and its inputs are the note, under the
  // flow's start output that feeds the step's note input, and the typed
  // request only: the other inputs come from that run's step snapshots at
  // the run start. A provenance that cannot be proven, another filing step,
  // or no single start output feeding the note escalates the repair;
  // nothing is dispatched. NULL intent: the ordinary repair below,
  // unchanged. A strict NULL check: a blank intent is planned, refused
  // and escalated, never dispatched as an ordinary repair.
  //
  // The deterministic run is read FIRST. A repair with no run is planned,
  // and its run is created from the plan; a plan that refuses escalates the
  // repair and nothing is dispatched.
  //
  // A run that already exists (an earlier pass created it, and maybe
  // enqueued it, then stopped before the repair was marked dispatched; the
  // worker may have started or even finished it since) is judged by its own
  // stored record only, as the completer judges it
  // (`recordedRegenerateInput`: the record its dispatch wrote, and the
  // repair's own findings). The plan is never rebuilt for it: the template
  // and the installed flow can be reinstalled after the run was made, and a
  // run already validated at its start is never stopped, nor a completed
  // run's output discarded, because they changed. A run with a valid record
  // is carried to the mark: no second create, and the same derived job id,
  // so no second job. A run with no record, or one the record does not
  // describe (one made in the earlier form, with the findings text and the
  // full findings request, by an older build before a crash or during a
  // rolling deployment), stops and escalates (`escalateRepairBeforeRunRead`).
  // It is refused rather than re-planned: the earlier pass may already have
  // enqueued its job, so a worker can start the run at any moment, and
  // rewriting its inputs would race that start. The stop is a
  // compare-and-set, nothing new is created or enqueued, so nothing is
  // dispatched twice; the worker's run start fails such a run on its own as
  // well (`resolveRegenerateSegment`). The checks above this read that
  // escalate a Regenerate stop an existing run first too, so an escalated
  // Regenerate never leaves a live run or job behind it.
  //
  // A Regenerate whose existing run already failed or was stopped is
  // escalated here, never enqueued or marked dispatched: a pass that stopped
  // the run and died before its escalation leaves a stopped run and a
  // `requested` repair, and the check that stopped it may pass on this pass.
  // A run that already COMPLETED (the worker finished it before an earlier
  // pass marked the repair dispatched) with a valid record is marked
  // dispatched with no second job, so the completer takes its output as the
  // successor; one with no valid record is escalated (nothing to stop).
  const [already] = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      inputParams: agentRuns.inputParams,
      parentRunId: agentRuns.parentRunId,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (
    already &&
    hasRegenerateIntent(row.regenerateNodeId) &&
    TERMINAL_RUN_STATUSES.has(already.status as AgentRunStatus) &&
    already.status !== "completed"
  ) {
    const escalated = await escalateRepair(
      row.id,
      `the Regenerate's repair run is already ${already.status}, so it is not started again`,
    );
    return escalated ? "escalated" : "raced";
  }
  let segmentParentRunId: string | null = null;
  let segmentInputParams: Record<string, unknown> | null = null;
  if (hasRegenerateIntent(row.regenerateNodeId) && already) {
    const recorded = recordedRegenerateInput({
      regenerateNodeId: row.regenerateNodeId ?? "",
      findings: row.findings,
      inputParams: already.inputParams,
    });
    // A completed run has nothing left to stop.
    const completed = already.status === "completed";
    if (!recorded) {
      const escalated = completed
        ? await escalateRepair(row.id, REGENERATE_RUN_NOT_DECLARED_FORM)
        : await escalateRepairBeforeRunRead(
            row,
            "the Regenerate's repair run was made with other inputs than the reviewer's words in the step's declared input, so it is stopped and not sent",
          );
      return escalated ? "escalated" : "raced";
    }
    if (completed) {
      // The recorded run already finished: the same compare-and-set as
      // below, and no job, because the run is not started again.
      const moved = await markRepairDispatched(row.id);
      return moved ? "dispatched" : "raced";
    }
  } else if (hasRegenerateIntent(row.regenerateNodeId)) {
    const segment = await planSegmentDispatch({
      repair: {
        id: row.id,
        orgId: row.orgId,
        regenerateNodeId: row.regenerateNodeId ?? null,
        baseArtifactId: row.baseArtifactId,
        baseRepresentationRevisionId: row.baseRepresentationRevisionId,
      },
      templateId: producer.templateId,
      packageName: producer.packageName,
      lifecycleConfig: producer.lifecycleConfigText,
      // The plan routes the recorded words of the review field the step
      // being regenerated takes (a picture step's prompt, every other
      // step's Note) to its declared input, never a findings text; the
      // request travels without its findings.
      findings: request.findings,
      request: request as unknown as Record<string, unknown>,
    });
    if (segment.kind === "refused") {
      // No run exists, so nothing is left to stop.
      const escalated = await escalateRepair(row.id, segment.reason);
      return escalated ? "escalated" : "raced";
    }
    segmentParentRunId = segment.parentRunId;
    segmentInputParams = segment.inputParams;
  }

  if (!already) {
    try {
      // cinatra#1940 P3 (Decision 2): the guarded creation perimeter needs
      // an authority — this drain has no session, so mint the system
      // dispatcher authority scoped to the repair's org.
      const dispatchAuthority = mintLifecycleRepairDispatchAuthority(row.orgId);
      // Routed through the coordinator (cinatra#2928). A repair run is
      // HEADLESS — the drain starts it, not a person — so no moment applies
      // at its start and the row is created `queued` exactly as before. The
      // enqueue stays here because it carries this drain's own derived job
      // id and actor context.
      await launchAgentRun({
        producer: "lifecycle_repair",
        frame: null,
        authority: dispatchAuthority,
        dispatch: {
          kind: "caller_dispatches",
          why: "the drain enqueues with its own colon-sanitized job id and the originating human's actor context",
        },
        create: {
          kind: "full",
          input: {
          id: runId,
          templateId: producer.templateId,
          orgId: row.orgId,
          inputParams: segmentInputParams ?? {
            ...producer.originatingInputParams,
            ...findingsInputParams,
            lifecycleRepairRequest: request,
          },
          sourceType: "lifecycle_repair",
          // Attribution: the repair run is the ORIGINATING human's, never
          // the system dispatcher's — mirrors the ActorContext threaded to
          // the enqueue below (cinatra#2286 S10 PR2, the principal fix).
          runBy: originatingRunBy,
          // CHILD DISPATCH (#1035): the repair run runs under the producing
          // run. Its own ceiling is server-derived inside the primitive; the
          // parent's PERSISTED chain is the compose operand only, never copied.
          // cinatra#4264 B1b: a Regenerate's parent is the provenance run.
          parentRunId: segmentParentRunId ?? row.producerRunId ?? null,
          parentOboCeiling: producer.parentOboCeiling,
          // A re-drain re-derives the same key, so an at-least-once delivery
          // converges on the SAME repair run.
          idempotencyKey: `lifecycle-repair:${row.id}`,
          },
        },
      });
    } catch (err) {
      // A concurrent drain won the insert — the delivery is already durable.
      if ((err as { code?: string } | null)?.code !== "23505") throw err;
    }
  }

  // cinatra#2286 S10 PR2 — actually EXECUTE the repair run. Before this,
  // `createAgentRun` above only minted the row `queued`; nothing enqueued
  // the BullMQ execution job, so a delivered repair sat forever un-run.
  // The ActorContext is the LIVE-VERIFIED originating human resolved above
  // — never the system dispatch authority, never left to
  // `buildActorContextFromRun`'s runBy-less fallback (this run always
  // carries a runBy, so that fallback is never reached for it). The
  // BullMQ-level dedup key is DERIVED from `runId` (so a re-drain — a
  // crash between mint and enqueue — is safe to re-call) but with its `:`
  // stripped: `runId` carries the `lifecycle-repair-run:` prefix, and
  // BullMQ's custom-jobId validation rejects any id containing exactly one
  // `:` ("Custom Id cannot contain :" — reserved for its own 3-part
  // repeatable-job ids). Same sanitization `skills-store.ts` already
  // applies to its own colon-bearing jobIds.
  const actorContext = await buildActorContextFromRun({
    id: runId,
    runBy: originatingRunBy,
    orgId: row.orgId,
  });
  await enqueueAgentRun(
    { runId },
    { jobId: runId.replace(/:/g, "_"), actorContext },
  );

  const moved = await markRepairDispatched(row.id);
  return moved ? "dispatched" : "raced";
}

/**
 * Stop the run whose pause a change request ended (cinatra#4245, spec 3.6). The
 * run is the gate's own run (the change request bound its compare-and-set to
 * it). The stop is the coordinator's release `pending_approval → stopped` under
 * the end mark at `generation` (status seam rule 5), so it can never stop a
 * later pause: no claimer can take a pause that carries the end mark, and only
 * a status change clears it. There is no waiting state.
 *
 * `stopped` — the stop won, or the run reads `stopped` after a lost
 * compare-and-set (a concurrent drain, or a stop of its own: converged); the
 * moment and card are then cleared STRICTLY (spec-rev1 MF6), so a failed clear
 * throws and the next pass retries it. `not-paused` — the run left the pause
 * some other way (the caller escalates). Any other error throws.
 */
async function stopRunAtEndedPause(
  gateId: string,
  orgId: string,
  generation: number,
): Promise<"stopped" | "not-paused"> {
  const [gate] = await db
    .select({ runId: artifactReviewGates.runId })
    .from(artifactReviewGates)
    .where(and(eq(artifactReviewGates.id, gateId), eq(artifactReviewGates.orgId, orgId)))
    .limit(1);
  if (!gate) return "not-paused";
  const authority = mintLifecycleRepairDispatchAuthority(orgId);
  try {
    await advanceAgentRun({
      run: { id: gate.runId, orgId, status: "pending_approval" },
      release: {
        reason: "changes_requested",
        from: "pending_approval",
        to: "stopped",
        pauseEndMark: { generation },
        dispatch: {
          kind: "caller_dispatches",
          why: "the stop dispatches nothing; this drain starts the separate repair run itself",
        },
        onLostRace: "throw",
      },
      authority,
    });
  } catch (err) {
    if (!(err instanceof RunTransitionError) || err.code !== "stale_from_status") throw err;
    const [now] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, gate.runId), eq(agentRuns.orgId, orgId)))
      .limit(1);
    if (now?.status !== "stopped") return "not-paused";
  }
  await clearRunLifecycleMomentOrThrow(gate.runId, authority);
  return "stopped";
}

/** Resolve the producing run's template (the agent that must repair). */
async function resolveProducingTemplate(producerRunId: string | null, orgId: string): Promise<{
  templateId: string;
  packageName: string | null;
  /** The producing run's PERSISTED OBO ceiling chain — the compose operand for
   * the child repair run (server-read, never caller input). */
  parentOboCeiling: OboCeilingChain | null;
  /**
   * The ORIGINATING producing run's `runBy` (cinatra#2286 S10 PR2, the
   * principal fix) — read off the SAME already-open run row (a one-line
   * addition, no second query). `null` when the producing run itself had no
   * human runBy (a system/A2A/scheduled write with no delegating human), in
   * which case the caller refuses to dispatch rather than falling through to
   * a system-authority principal.
   */
  originatingRunBy: string | null;
  /** Recorded producer inputs are data, never launch authority. */
  originatingInputParams: Record<string, unknown>;
  /** The producing template's compiled lifecycle declaration
   * (`agent_templates.lifecycle_config`), read fail-soft; null when absent. */
  lifecycle: CompiledManifestLifecycle | null;
  /** The same column as stored (cinatra#4264 B1b reads its `regenerate` list). */
  lifecycleConfigText: string | null;
} | null> {
  if (!producerRunId) return null;
  const [run] = await db
    .select({
      templateId: agentRuns.templateId,
      oboCeiling: agentRuns.oboCeiling,
      runBy: agentRuns.runBy,
      inputParams: agentRuns.inputParams,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, producerRunId), eq(agentRuns.orgId, orgId)))
    .limit(1);
  if (!run?.templateId) return null;
  const [tmpl] = await db
    .select({
      id: agentTemplates.id,
      packageName: agentTemplates.packageName,
      lifecycleConfig: agentTemplates.lifecycleConfig,
    })
    .from(agentTemplates)
    .where(eq(agentTemplates.id, run.templateId))
    .limit(1);
  if (!tmpl) return null;
  let parentOboCeiling: OboCeilingChain | null = null;
  if (run.oboCeiling) {
    try {
      parentOboCeiling = JSON.parse(run.oboCeiling) as OboCeilingChain;
    } catch {
      parentOboCeiling = null;
    }
  }
  let originatingInputParams: Record<string, unknown> = {};
  if (run.inputParams) {
    try {
      const parsed: unknown = JSON.parse(run.inputParams);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        originatingInputParams = parsed as Record<string, unknown>;
      }
    } catch {
      // Unreadable historical inputs cannot become launch authority or fields.
    }
  }
  return {
    templateId: tmpl.id,
    packageName: tmpl.packageName ?? null,
    parentOboCeiling,
    originatingRunBy: run.runBy ?? null,
    originatingInputParams,
    lifecycle: parseLifecycleConfigText(tmpl.lifecycleConfig ?? null),
    lifecycleConfigText: tmpl.lifecycleConfig ?? null,
  };
}

/**
 * cinatra#4264 B1b: escalate a repair from a check that comes BEFORE the read
 * of its deterministic run (an ended pause no longer held, no producer, no
 * human runBy, a revoked originating member).
 *
 * Such a check can meet a RETRY: an earlier pass created the run (and maybe
 * enqueued it) and then stopped before the repair was marked dispatched, and
 * what the check reads changed between the two passes. For a Regenerate, the
 * existing run is stopped FIRST, then the repair is escalated: it is never
 * enqueued for a member who no longer qualifies, never left queued with no
 * job, and a job already taken by a worker sees a run that is no longer
 * `queued`. A run that cannot be stopped throws, so the repair stays
 * `requested` and the next pass tries again; a crash between the stop and the
 * escalation leaves a stopped run, which the next pass finds terminal and
 * escalates (the run read in `deliverRepair`), whatever this check reads then.
 * The stop and the escalation are taken under the repair's claim
 * (`withRepairDispatchClaim`), so no other drain is delivering the same
 * repair between them: the run stopped here is never one another drain is
 * about to mark dispatched.
 *
 * The checks that do not come here cannot meet an existing run: a
 * checkpointed delivery (`continuation_mode` is written only when the repair
 * row is inserted, so every pass escalates it before any create), the step
 * road switch (a constant of the code), and a refused plan (planned only when
 * the run read just before it found no run).
 *
 * An ordinary repair (NULL intent) is escalated as before.
 */
async function escalateRepairBeforeRunRead(
  row: { id: string; orgId: string; regenerateNodeId?: string | null },
  reason: string,
): Promise<boolean> {
  if (hasRegenerateIntent(row.regenerateNodeId)) {
    await stopExistingRepairRun(repairRunId(row.id), row.orgId);
  }
  return escalateRepair(row.id, reason);
}

/**
 * Stop the repair run with this id when it exists and is not terminal, through
 * `agent_run_stop`'s own compare-and-set (`stopRunRespectingPauseClaim`, the
 * writer's guarded caller), under the system dispatch authority this drain
 * mints (its `run.complete` covers a terminal edge), then the strict moment
 * clear (as `stopRunAtEndedPause`). A lost compare-and-set reads the run again
 * and tries from its live status, at most 3 attempts. A run that is gone or
 * terminal on a read needs no stop; every other run left unstopped throws, as
 * does any other failure.
 */
async function stopExistingRepairRun(runId: string, orgId: string): Promise<void> {
  const authority = mintLifecycleRepairDispatchAuthority(orgId);
  let gone = false;
  const readRun = async () => {
    const [run] = await db
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)))
      .limit(1);
    gone = !run;
    return run;
  };
  const run = await readRun();
  if (!run || TERMINAL_RUN_STATUSES.has(run.status as AgentRunStatus)) return;
  const notStopped = await stopRunRespectingPauseClaim({
    runId,
    fromStatus: run.status as AgentRunStatus,
    authority,
    readRun,
  });
  if (notStopped === null) {
    await clearRunLifecycleMomentOrThrow(runId, authority);
    return;
  }
  if (gone || !("error" in notStopped)) return;
  throw new Error(`the repair run ${runId} was not stopped: ${String(notStopped.error)}`);
}

// cinatra#4264: the escalation of a Regenerate repair whose run is not in the
// declared-input form, and its reason, live in `./regenerate-segment` so the
// worker's run start reaches them without this store (route-graph ratchet).
// Re-exported here for the completer and the drain.
export { REGENERATE_RUN_NOT_DECLARED_FORM };
export { escalateRegenerateRepairOfUndeclaredRun } from "./regenerate-segment";

/** CAS a `requested` repair to `escalated`, recording WHY on `change_summary`
 * behind the dispatch sentinel. Returns false when the row moved under us.
 * cinatra#4312 — an escalated lineage has no successor to decide, so the same
 * commit carries a declared review's latest decision (carryDeclaredReviewDecision).
 * A `dispatched` Regenerate repair is taken only by
 * `escalateRegenerateRepairOfUndeclaredRun` (`./regenerate-segment`). */
async function escalateRepair(repairId: string, reason: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(lifecycleRepair)
      .set({
        status: "escalated",
        changeSummary: `${DISPATCH_ESCALATION_PREFIX}${reason}`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(lifecycleRepair.id, repairId), eq(lifecycleRepair.status, "requested")))
      .returning({ lineageId: lifecycleRepair.lineageId });
    if (rows.length !== 1) return false;
    await carryDeclaredReviewDecision(tx, rows[0].lineageId);
    return true;
  });
}

/** The delivered request on a repair run, or null when the run is not a repair
 * run / carries no request. The producer reads this to learn what to repair. */
export async function readDeliveredRepairRequest(
  runId: string,
): Promise<DeliveredRepairRequest | null> {
  const repairId = repairIdFromRunId(runId);
  if (!repairId) return null;
  const [run] = await db
    .select({ inputParams: agentRuns.inputParams })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run?.inputParams) return null;
  try {
    const parsed = JSON.parse(run.inputParams) as { lifecycleRepairRequest?: DeliveredRepairRequest };
    const req = parsed?.lifecycleRepairRequest;
    return req && req.kind === "lifecycle_repair_request" ? req : null;
  } catch {
    return null;
  }
}

/** Re-build the S2 `ChangesRequestedRequest` shape from a delivered request —
 * the producer's typed view of what the reviewer asked for. */
export function toChangesRequestedRequest(
  delivered: DeliveredRepairRequest,
): Omit<ChangesRequestedRequest, "decisionId" | "idempotencyKey"> {
  return {
    gateId: delivered.gateId,
    baseTarget: delivered.baseTarget,
    expectedBaseRevisionId: delivered.expectedBaseRevisionId,
    findings: delivered.findings,
    continuationMode: delivered.continuationMode === "checkpointed" ? "checkpointed" : "async_effects_gated",
    continuationAddress: delivered.continuationAddress,
  };
}
