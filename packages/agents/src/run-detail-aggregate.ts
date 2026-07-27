// ---------------------------------------------------------------------------
// Run-detail aggregate (cinatra#2066, C0; epic #2037). The ONE run-scoped read
// the canonical run view under /agents composes from. It assembles, behind the
// EXISTING run-access enforcement (`enforceReviewRunAccess`, op "read"):
//
//   run + messages + gates + run_selected_skill_revisions + parked continuations
//   + lifecycle policy decisions (the produced-event outbox rows, #2047 D-5)
//   (+ advisory comments / verification records / suggestion snapshots per gate,
//    when present)
//
// No schema change, no write-path change — every reader is a plain SELECT over a
// table that already exists, joined on the run-scoped indexes the write paths
// already anchor on. The gate reader (`listReviewGatesForRun`) is the missing
// run-scoped enumerator that makes a RESOLVED gate visible from a run surface for
// the first time (the run-embedding audit's lack #2).
//
// Access enforcement is the aggregate's boundary: a caller passes the reviewing
// actor + role hints; a denied actor gets `{ ok: false, status }` (404-shaped for
// an unknown/foreign run, 403 for a cross-org leak) and NO run data. The
// individual readers below are plain reads — this aggregate is the enforced door.
// ---------------------------------------------------------------------------
import "server-only";

import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";

import { readRunSelectedSkillRevisions, type RunSelectedSkillRevision } from "@/lib/run-selected-skill-revisions";

import type { ActorRoleHints } from "./auth-policy";
import type { AgentRunRecord, AgentRunMessageRecord } from "./store";
import { readAgentRunById, readAgentRunMessages } from "./store";
import {
  enforceReviewRunAccess,
  listReviewGatesForRun,
  readAdvisoryCommentsForGates,
  readVerificationRecordsForGates,
  readSuggestionSnapshotsForGates,
  type ReviewGateRow,
  type GateAdvisoryCommentRow,
  type GateVerificationRecordRow,
  type GateSuggestionSnapshotRow,
} from "./artifact-review-gate-store";
import { readContinuationParksForRun } from "./lifecycle-continuation-park-store";
import type { ParkRow } from "./lifecycle-continuation-park-store";
import {
  readLifecycleDecisionsForRun,
  type LifecycleRunDecision,
} from "./lifecycle-policy-store";

/** The assembled run-detail read (returned only to an authorized actor). */
export interface RunDetailAggregate {
  run: AgentRunRecord;
  messages: AgentRunMessageRecord[];
  gates: ReviewGateRow[];
  selectedSkillRevisions: RunSelectedSkillRevision[];
  parkedContinuations: ParkRow[];
  /** Every lifecycle POLICY decision the run's produced-event outbox recorded —
   * fired, skipped, or still pending (cinatra#2047 D-5). A SKIPPED decision has no
   * gate and no park, so before this it left NO trace on any run-scoped read. */
  lifecycleDecisions: LifecycleRunDecision[];
  /** advisory comments grouped by gate id (present entries only). */
  advisoryCommentsByGate: Record<string, GateAdvisoryCommentRow[]>;
  /** verification records grouped by gate id (present entries only). */
  verificationRecordsByGate: Record<string, GateVerificationRecordRow[]>;
  /** suggestion snapshots grouped by gate id (present entries only). */
  suggestionSnapshotsByGate: Record<string, GateSuggestionSnapshotRow[]>;
}

export type RunDetailAggregateOutcome =
  | { ok: true; aggregate: RunDetailAggregate }
  | { ok: false; status: number };

function groupByGate<T extends { gateId: string }>(rows: readonly T[]): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const r of rows) (out[r.gateId] ??= []).push(r);
  return out;
}

/**
 * Read the full run-detail aggregate for `runId` as `actor`. Enforces the run's
 * effective auth policy through `enforceReviewRunAccess` (op "read") — the SAME
 * gate the review surface and the run screens clear — before reading any run
 * data. Returns `{ ok: false, status }` for a denied/absent run.
 */
export async function readRunDetailAggregate(input: {
  runId: string;
  actor: PrimitiveActorContext;
  roles?: ActorRoleHints;
}): Promise<RunDetailAggregateOutcome> {
  const access = await enforceReviewRunAccess(input.runId, input.actor, "read", input.roles);
  if (!access.ok) return { ok: false, status: access.status };

  // Enforcement passed ⇒ this actor may READ the run. Plain reads below (the
  // access door is above; re-enforcing per reader would be redundant work).
  const run = await readAgentRunById(input.runId);
  if (!run) return { ok: false, status: 404 };

  const [messages, gates, parkedContinuations, lifecycleDecisions] = await Promise.all([
    readAgentRunMessages(input.runId),
    listReviewGatesForRun(input.runId),
    readContinuationParksForRun(input.runId),
    readLifecycleDecisionsForRun(input.runId),
  ]);

  const gateIds = gates.map((g) => g.id);
  const [advisoryComments, verificationRecords, suggestionSnapshots] = await Promise.all([
    readAdvisoryCommentsForGates(gateIds),
    readVerificationRecordsForGates(gateIds),
    readSuggestionSnapshotsForGates(gateIds),
  ]);

  // Sync sql-pg read — the authoritative per-run selection set (empty ⇒ none).
  const selectedSkillRevisions = readRunSelectedSkillRevisions(input.runId);

  return {
    ok: true,
    aggregate: {
      run,
      messages,
      gates,
      selectedSkillRevisions,
      parkedContinuations,
      lifecycleDecisions,
      advisoryCommentsByGate: groupByGate(advisoryComments),
      verificationRecordsByGate: groupByGate(verificationRecords),
      suggestionSnapshotsByGate: groupByGate(suggestionSnapshots),
    },
  };
}
