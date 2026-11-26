import "server-only";

// publish-decision-actions (cinatra#4150): a run the flow runtime stops at a publish gate parks
// on its decision record and on nothing else. "Do not publish" and the 24-hour expiry end it
// stopped. Every resume road refuses a run whose newest decision is not released.

import type { OrgWriteAuthority } from "@cinatra-ai/org-write-kernel";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import { verifyGateNodeClaim } from "@/lib/agent-run-token";
import { AuthzError } from "@/lib/authz/errors";
import { sessionAuthorityFromResolvedRole } from "@/lib/org-write/authority";
import type { ActorRoleHints } from "./auth-policy";
import {
  claimPublishCall,
  decide,
  endPublishCall,
  insertParkedDecision,
  listDueParked,
  listSettledWithWaitingRun,
  readDecisionForRunNode,
  readDispatchedPublishRows,
  readLatestDecisionForRun,
  readOpenDecisionForRun,
  readRunBoundGraph,
  withRunRowLock,
  type PublishDecisionRow,
  type PublishDecisionStatus,
} from "./publish-decision-store";
import {
  readAgentRunById,
  readAgentTemplateById,
  readRunCoOwners,
  transitionRunStatus,
  type AgentRunRecord,
  type AgentRunStatus,
} from "./store";
import { resolveWayflowUrl } from "./wayflow-url";
import { claimPause, releasePauseClaim, settlePauseSend } from "./run-pause-claim";
import { personApproved } from "./declared-review-pause";

/** The id prefix of the gate the flow runtime inserts in front of a publishing step. The
 *  compiler reserves the same prefix (oas-compiler.ts, PUBLISH_GATE_ID_PREFIX). */
export const PUBLISH_GATE_NODE_PREFIX = "cinatra_publish_gate__";
export const PUBLISH_DECISION_REQUIRED = "publish_decision_required";
export const PUBLISH_DECISION_NOT_OPEN = "publish_decision_not_open";
export const PUBLISH_GATE_UNVERIFIED = "publish_gate_unverified";
export const PUBLISH_DECISION_UNAVAILABLE = "publish_decision_unavailable";
/** A Publish refused because the review fence of the decision's attempt no longer holds (cinatra#4762). */
export const PUBLISH_REVIEW_NOT_APPROVED = "publish_review_not_approved";
/** cinatra#4150 W4: the stop surfaced more than a decision record holds. The run ends failed with this fixed text,
 *  before any record is written: nothing is decided, and the step and every step after it do not run. A pack keeps its
 *  surfaced values small (bounded lists, artifact references, never whole bodies). */
export const PUBLISH_DECISION_TOO_LARGE = "publish_decision_too_large";
/** The decision record's own cap (publish-decision-store.ts PUBLISH_DECISION_MAX_SURFACED_BYTES; a test pins the two
 *  equal). Read here as a literal so that no module that stubs the store reaches a missing export. */
export const PUBLISH_SURFACED_VALUES_MAX_BYTES = 64 * 1024;
const PUBLISH_DECISION_UNRECORDED_TEXT = "publish_decision_unrecorded: the publish decision could not be recorded";
const PUBLISH_RESUME_FAILED = "publish_resume_failed";
const EXPIRY_PAGE = 50;

/** A resume of a run held at a publish decision. The text names no run, step or value. */
export class PublishDecisionRequiredError extends Error {
  readonly code = PUBLISH_DECISION_REQUIRED;
  constructor() {
    super("This run waits at a publish decision; only that decision can let it go on.");
    this.name = "PublishDecisionRequiredError";
  }
}

export const isPublishDecisionRequired = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === PUBLISH_DECISION_REQUIRED;

const isStale = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === "stale_from_status";
/** The error's class name for a log line, from a fixed list only: a name outside it (a custom error could carry an id in
 *  its name) is logged as "Error". */
const LOGGED_ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "AuthzError"]);
const nameOf = (err: unknown): string => (err instanceof Error ? (LOGGED_ERROR_NAMES.has(err.name) ? err.name : "Error") : "error");

/** Refuses a resume when the newest decision of the run's CURRENT attempt exists and is not `released`: a decision of an
 *  attempt a retry's reset ended (an earlier reset generation) never holds the later attempt's gate, while a declined,
 *  expired or run_ended decision of the current attempt still does. A read error propagates. Answers whether the run has
 *  any decision, of any attempt: such a run met a publish gate, so it can meet one again. */
export async function assertNoOpenPublishDecision(runId: string): Promise<boolean> {
  const latest = await readLatestDecisionForRun(runId, { orEarlierAttempt: true });
  // Only a row the read marks as an earlier generation's (current === false) lets the run go on: fail-closed.
  if (latest && latest.current !== false && latest.status !== "released") throw new PublishDecisionRequiredError();
  return latest !== null;
}

const HOLD_UNREADABLE = "Resume failed: the publish hold could not be checked.";

/** agent_run_resume's answer to a refused or unreadable hold. Neither text carries an id, a value or the store's error. */
export function publishHoldAnswer(err: unknown): { error: string; code?: string } {
  if (isPublishDecisionRequired(err)) return { error: (err as Error).message, code: PUBLISH_DECISION_REQUIRED };
  console.warn(`[publish-decision] a resume could not check the publish hold: ${nameOf(err)}`);
  return { error: HOLD_UNREADABLE };
}

/** A refusal or an unreadable hold, as publishHoldFault answers them. */
export const isPublishHoldFault = (err: unknown): boolean =>
  isPublishDecisionRequired(err) || (err as { code?: unknown } | null)?.code === PUBLISH_DECISION_UNAVAILABLE;

/** The fault the generic approve and the stopped-orchestrator resume throw for a hold they could not check: the refusal
 *  unchanged, any other fault one fixed text (publish_decision_unavailable) with no id, value or store error. */
export function publishHoldFault(err: unknown): unknown {
  if (isPublishDecisionRequired(err)) return err;
  console.warn(`[publish-decision] a resume could not check the publish hold: ${nameOf(err)}`);
  return Object.assign(new Error(HOLD_UNREADABLE), { code: PUBLISH_DECISION_UNAVAILABLE });
}

/**
 * A5 for the two roads that resume from pending_approval and keep the run there while they send (agent_run_resume and
 * the artifact-review delivery). `publishes`: the template lists publishing steps, or the run has a decision (a verified
 * publish-gate claim holds a run whatever the list says, so a run that met one can meet another). Then the road claims
 * the run (pending_approval -> running) right before it sends and reads the hold again: a decision parked by another
 * resume after the road's first read refuses the send. A refusal or a read error tries to put the run back and
 * propagates; when that move fails too, the run stays running, where no resume road claims it. Answers the status the
 * road hands to handleWayflowTaskState, or null when another road holds the run. A send that fails after the claim
 * leaves the run running, as the generic approve does (cinatra#3423): the runtime may have taken the message.
 */
export async function claimRunBeforeSend(runId: string, publishes: boolean, authority: OrgWriteAuthority): Promise<AgentRunStatus | null> {
  if (!publishes) return "pending_approval";
  if (!(await moveRun(runId, "pending_approval", "running", undefined, authority))) return null;
  try {
    await assertNoOpenPublishDecision(runId);
  } catch (err) {
    await moveRun(runId, "running", "pending_approval", undefined, authority).catch(() => false);
    throw err;
  }
  return "running";
}

type GateTask = {
  id: string;
  contextId?: string | null;
  history?: ReadonlyArray<{ role?: string; parts?: readonly unknown[] }>;
};

/** The gate's surfaced values: the last agent message, when its whole text is a JSON object. */
function surfacedValuesOf(task: GateTask): Record<string, unknown> {
  const last = task.history?.slice().reverse().find((m) => m?.role === "agent" || m?.role === "assistant");
  const text = ((last?.parts ?? []) as Array<{ kind?: unknown; text?: unknown }>)
    .filter((p) => p?.kind === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("")
    .trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* not an object: the gate surfaced no values */ }
  return {};
}

/** Moves the run `from` -> `to`; false when a stale answer shows the run already left `from`, or (with `attemptGeneration`)
 *  a retry's reset ended the attempt the move belongs to. */
async function moveRun(runId: string, from: AgentRunStatus, to: AgentRunStatus, patch: Parameters<typeof transitionRunStatus>[3], authority: OrgWriteAuthority): Promise<boolean> {
  try {
    await transitionRunStatus(runId, from, to, patch, authority);
    return true;
  } catch (err) {
    if (!isStale(err)) throw err;
    return false;
  }
}
const stopHeldRun = (runId: string, from: AgentRunStatus, authority: OrgWriteAuthority) =>
  moveRun(runId, from, "stopped", { completedAt: new Date() }, authority);
/** A run a publish decision holds: waiting at the gate, or `running` when a hold wrote its row but not its move. */
type HeldRunStatus = Extract<AgentRunStatus, "pending_approval" | "running">;
/** The stored status (plain text) as a held status, or null for any other status or none: no other text reaches a move. */
const heldStatusOf = (status: string | undefined): HeldRunStatus | null =>
  status === "pending_approval" || status === "running" ? status : null;
/** An access refusal and the store's own refusals name no id or value; any other fault becomes one fixed text (no id,
 *  note or query value). */
const STORE_CODES = new Set(["invalid-input", "invalid-transition", "malformed-row", "not-found", "conflict"]);
const opaque = (err: unknown): unknown => err instanceof AuthzError || STORE_CODES.has((err as { code?: unknown } | null)?.code as string) ? err
  : Object.assign(new Error("The publish decision could not be read or written."), { code: PUBLISH_DECISION_UNAVAILABLE });

/** What a run records when it reaches an external write with no approved review before it (design §XV). */
export const PUBLISH_REVIEW_MISSING_REASON = "No approved review came before this change outside Cinatra.";

/** One review of a run, as the gate seam's listReviews answers it. */
type ReviewOfRun = {
  id: string; status: string; disposition: string | null; createdAt?: Date; runGeneration: number | null;
  fingerprint?: string | null; resolvedBy?: string | null; successorGateId?: string | null;
  reproducedGeneration?: number | null;
};

/** The gate seam's review reads, reached as the run executor reaches them (execution.ts): never imported here, so no
 *  route's graph grows. An unbound seam is a read error. `executor`: a transaction to read in (withRunRowLock's). */
type ReviewSeamReads = {
  listReviews: (runId: string, executor?: unknown) => Promise<ReviewOfRun[]>;
  hasPendingProducedReview: (input: { orgId: string; runId: string; generation: number }, executor?: unknown) => Promise<boolean>;
};
/** The executor argument of a seam read: none when the read runs on the pool. */
const via = (executor?: unknown): [] | [unknown] => (executor === undefined ? [] : [executor]);
function reviewSeam(): ReviewSeamReads {
  const seam = (globalThis as { __cinatraArtifactReviewGateSeam?: Partial<ReviewSeamReads> }).__cinatraArtifactReviewGateSeam;
  if (typeof seam?.listReviews !== "function" || typeof seam.hasPendingProducedReview !== "function") {
    throw new Error("the review store is not bound");
  }
  return { listReviews: seam.listReviews, hasPendingProducedReview: seam.hasPendingProducedReview };
}

/**
 * cinatra#4762 (design app-lifecycle-cards §XV): did an approved review card (§II) come earlier in the attempt that
 * reached the publish gate? The attempt is the run's reset generation the caller holds: a retry's reset raises it once
 * in its compare-and-set and nothing else writes it, and each review gate records the generation of the attempt that
 * raised it (a gate raised before the column existed reads as generation 0, and a repair's successor of such a gate is
 * stamped 0 too). So a review of an attempt a reset ended never counts, whatever later writes do to the run.
 * Approved, as a set: the attempt has a review a person approved, none is still open or declined, and each review
 * settled changes requested is cleared by its own repair lineage: the successor gate the repair of that review
 * recorded (lifecycle_repair.successor_gate_id) is a review of this attempt that a person approved, or that was itself
 * settled changes requested and is cleared the same way. Another review approved later (a different artifact, a
 * sibling of the same family) never clears it, whenever it was raised.
 * A review with no generation (raised before the column existed, or from an output that names no attempt) may be a
 * review of this attempt: while it is still open, or once it settled with anything but an approval (rejected, changes
 * requested), it counts as a review of this attempt, so it holds every attempt's fence (fail closed). Only a settled
 * approval with no generation is read as generation 0.
 * A retry that writes exactly the bytes an earlier attempt's review pinned reuses that revision and raises no review
 * of its own; the store reads that attempt as the review's (reproducedGeneration: every pinned revision's produced
 * event restamped by that attempt). Such a review is a review of that attempt, whatever it settled: an approval counts,
 * since a person approved exactly these bytes, and a decline or an open review holds the fence as any other.
 * An approval counts only with a person as its decider of record (personApproved); which person is not compared: the
 * reviewer and the person who answers the publish card may differ. A read error propagates.
 */
export async function approvedReviewPrecedes(runId: string, generation: number, executor?: unknown): Promise<boolean> {
  const all = (await reviewSeam().listReviews(runId, ...via(executor))).map((g) =>
    Number.isSafeInteger(g.reproducedGeneration) && g.runGeneration != null && (g.reproducedGeneration as number) > g.runGeneration
      ? { ...g, runGeneration: g.reproducedGeneration as number } : g);
  if (all.some((g) => g.runGeneration == null && g.status !== "resolved")) return false;
  const reviews = all.filter((g) => (g.runGeneration ?? 0) === generation || (g.runGeneration == null && g.disposition !== "approve"));
  if (!reviews.some(personApproved)) return false;
  const byId = new Map(reviews.map((g) => [g.id, g] as const));
  const cleared = (g: ReviewOfRun): boolean => {
    // Follow the successors; a successor seen again (a malformed lineage) clears nothing.
    const seen = new Set<string>([g.id]);
    for (let at = g; ;) {
      const next = typeof at.successorGateId === "string" ? byId.get(at.successorGateId) : undefined;
      if (!next || seen.has(next.id)) return false;
      if (personApproved(next)) return true;
      if (next.status !== "resolved" || next.disposition !== "changes_requested") return false;
      seen.add(next.id);
      at = next;
    }
  };
  return reviews.every((g) => g.status === "resolved" && (g.disposition === "approve" ||
    (g.disposition === "changes_requested" && cleared(g))));
}

/**
 * cinatra#4762 — the review fence before an external write, for the attempt `generation` of the run: an approved
 * review came before it (approvedReviewPrecedes), and no output of the attempt still waits for the review
 * orchestration. A produced event of the attempt still pending may yet raise a review of it; until the drain settles
 * it, the fence does not hold, as for a review still open. A pending event with no generation (written before the column
 * existed) may be this attempt's, so it holds the fence too. A read error propagates.
 * The events are read before the reviews: the drain settles an event and raises its review in one transaction, so an
 * event that is no longer pending at the first read has its review visible at the second. `executor`: the transaction of
 * withRunRowLock, under which no output of the run is in flight (see there).
 */
export async function reviewFenceHolds(input: { runId: string; orgId: string; generation: number; executor?: unknown }): Promise<boolean> {
  const { runId, orgId, generation, executor } = input;
  if (await reviewSeam().hasPendingProducedReview({ orgId, runId, generation }, ...via(executor))) return false;
  return approvedReviewPrecedes(runId, generation, executor);
}

/**
 * The publish classification of the input-required branch, run before anything else there.
 * False: not a publish gate, the caller goes on as before. True: handled, the caller returns.
 *   - a verified `cinatra_publish_gate__<node>` claim (the prefix wins over the template's
 *     list): the row is written FIRST (a failure ends the run failed), then the run moves to
 *     pending_approval; a lost move closes the row run_ended;
 *   - before the park, the review fence must hold for the attempt that reached the gate (reviewFenceHolds: an approved
 *     review, and no output of the attempt still waiting for the review orchestration): else the run ends stopped with
 *     PUBLISH_REVIEW_MISSING_REASON, no row is written, and the stop closes run_ended any row of the attempt still
 *     parked (cinatra#4762);
 *   - every move of the run here carries the reset generation of the attempt that reached the gate (attemptGeneration):
 *     a callback of an attempt a retry's reset ended moves nothing on the next attempt's row (cinatra#4762);
 *   - a missing or unverified claim on a template that lists publishing steps, or an unverified publish-gate claim
 *     on a template that is not found or cannot be read: the run ends failed, publish_gate_unverified.
 * No renderer, no generic review task and no lifecycle moment is offered for a publish gate.
 */
export async function holdRunAtPublishGate(args: {
  run: AgentRunRecord;
  fromStatus: AgentRunStatus;
  task: GateTask;
  claim: { node: string; attestation: string } | null;
  authority: OrgWriteAuthority;
}): Promise<boolean> {
  const { run, fromStatus, task, claim, authority } = args;
  // cinatra#4762: the attempt that reached this gate, as the run record its caller read for the attempt names it.
  const attempt = { attemptGeneration: run.resetGeneration ?? 0 };
  const contextId = task.contextId ?? run.a2aContextId;
  const verified = verifyGateNodeClaim({
    key: process.env.CINATRA_CONTEXT_ATTEST_KEY,
    contextId,
    taskId: task.id,
    claim,
  });
  if (verified === null) {
    let publishes: boolean | null = null;
    try {
      const template = await readAgentTemplateById(run.templateId);
      if (template) publishes = (template.publishingSteps?.length ?? 0) > 0;
    } catch { /* unreadable: decided below, as a template that is not found */ }
    // Not found or unreadable: only a pause that claims a publish gate fails; any other keeps today's road, as on main.
    publishes ??= typeof claim?.node === "string" && claim.node.startsWith(PUBLISH_GATE_NODE_PREFIX);
    if (!publishes) return false;
    await moveRun(run.id, fromStatus, "failed", { error: `${PUBLISH_GATE_UNVERIFIED}: the pause carries no verified step claim`, completedAt: new Date(), ...attempt }, authority);
    return true;
  }
  if (!verified.startsWith(PUBLISH_GATE_NODE_PREFIX)) return false;
  const nodeId = verified.slice(PUBLISH_GATE_NODE_PREFIX.length);

  // cinatra#4762: no publish card opens without an approved review earlier in this attempt. The run ends stopped with
  // the reason, no decision row is written and nothing is sent, so the write never happens. An unreadable review ends
  // the run failed, as an unrecorded decision does. Either move closes, in its own guarded transaction, every decision
  // of this attempt still parked (a gate redelivered after its row parked, before this rule): no parked row outlives
  // the attempt the move ends.
  const endAttempt = { ...attempt, endParkedDecisions: true as const };
  let reviewed: boolean;
  try {
    reviewed = await reviewFenceHolds({ runId: run.id, orgId: run.orgId, generation: attempt.attemptGeneration });
  } catch (err) {
    console.warn(`[publish-decision] the review before a publish could not be read: ${nameOf(err)}`);
    await moveRun(run.id, fromStatus, "failed", { error: "publish_review_unread: the review before the publish could not be read", completedAt: new Date(), ...endAttempt }, authority);
    return true;
  }
  if (!reviewed) {
    await moveRun(run.id, fromStatus, "stopped", { error: PUBLISH_REVIEW_MISSING_REASON, completedAt: new Date(), ...endAttempt }, authority);
    return true;
  }

  const surfacedValues = surfacedValuesOf(task);
  // A stop that surfaced more than the record holds is refused by name, before any write. The text is fixed: it names
  // the cap, never a value, the step or the size the pack surfaced.
  // The measure itself can fail (a structure nested past the serializer's depth): that stop cannot be recorded either, so
  // it takes the unrecorded road below with its own fixed text, and nothing is thrown past this step.
  let surfacedBytes: number | null;
  try {
    surfacedBytes = Buffer.byteLength(JSON.stringify(surfacedValues), "utf8");
  } catch {
    surfacedBytes = null;
  }
  if (surfacedBytes === null) {
    await moveRun(run.id, fromStatus, "failed", { error: PUBLISH_DECISION_UNRECORDED_TEXT, completedAt: new Date(), ...attempt }, authority);
    return true;
  }
  if (surfacedBytes > PUBLISH_SURFACED_VALUES_MAX_BYTES) {
    await moveRun(run.id, fromStatus, "failed", {
      error: `${PUBLISH_DECISION_TOO_LARGE}: the values this step surfaced for the decision are over ${PUBLISH_SURFACED_VALUES_MAX_BYTES} bytes, so no decision was recorded and the step did not run`,
      completedAt: new Date(),
      ...attempt,
    }, authority);
    return true;
  }
  let park: Awaited<ReturnType<typeof insertParkedDecision>>;
  try {
    park = await insertParkedDecision({
      orgId: run.orgId,
      runId: run.id,
      nodeId,
      gateTaskId: task.id,
      a2aContextId: contextId ?? null,
      surfacedValues,
      declaredRows: await readDispatchedPublishRows(run.id, nodeId).catch(() => null),
      // cinatra#4762: the row is written only while the run is still at this attempt, in the insert's own transaction.
      attemptGeneration: attempt.attemptGeneration,
    });
    // The stop belongs to an attempt that has ended: an existing row of an earlier reset generation, or a new row
    // stamped while the run was no longer held at a gate (its attempt failed and may have been reset meanwhile). It
    // cannot hold this attempt; a new row is closed run_ended at once, so it never waits for a person.
    if (!park.current) {
      if (park.inserted) await decide(park.decision.id, { from: "parked", to: "run_ended", actor: null }).catch(() => undefined);
      throw new Error("superseded");
    }
  } catch (err) {
    // A callback of an attempt a retry's reset ended: the store wrote no row, and nothing of the next attempt moves.
    if ((err as { code?: unknown } | null)?.code === "stale-attempt") return true;
    await moveRun(run.id, fromStatus, "failed", { error: PUBLISH_DECISION_UNRECORDED_TEXT, completedAt: new Date(), ...attempt }, authority);
    return true;
  }
  // A stop this gate task already answered is closed; the newest-decision rule keeps it closed.
  if (park.decision.status !== "parked" || fromStatus === "pending_approval") return true;
  let moved: boolean;
  try {
    // The pause records its own gate task in the compare-and-set that enters it (and raises its generation), so the
    // run row names this gate's task for exactly this pause (cinatra#4758).
    moved = await moveRun(run.id, fromStatus, "pending_approval", { ...attempt, pauseTaskId: task.id }, authority);
  } catch (err) {
    // The dispatch records this attempt failed. A row left parked would read as the open stop of the run's next attempt
    // (a retry), so it is closed run_ended here, as a lost move closes it. A fault on that close does not hide the move's
    // own fault; the retry's reset closes the row then, in the guarded transaction of its compare-and-set.
    await decide(park.decision.id, { from: "parked", to: "run_ended", actor: null }).catch(() => undefined);
    throw err;
  }
  if (!moved) await decide(park.decision.id, { from: "parked", to: "run_ended", actor: null });
  return true;
}

export type PublishDecisionAnswer =
  | { ok: true; runStopped: boolean }
  | { ok: false; code: typeof PUBLISH_DECISION_NOT_OPEN; currentStatus: PublishDecisionStatus | null };

/** `decisionId` (the publish card, cinatra#4758): the decision row the answer was given on. Given, the decision write
 *  lands only on that row, and only while it is the run's newest decision, of its current attempt, still parked: one
 *  guarded write (the store's `decide`), so an answer to an earlier gate never lands on a newer one. */
type DecideInput = { runId: string; actorContext: PrimitiveActorContext; roleHints?: ActorRoleHints; decisionId?: string };
/** The decision an answer writes, and the store's guard for an answer that names its row. */
const answerTarget = (runId: string, open: PublishDecisionRow, decisionId: string | undefined) =>
  decisionId === undefined ? { id: open.id, guard: {} } : { id: decisionId, guard: { ofRun: runId, newestOnly: true } };
const forbidden = (message: string) => new AuthzError({ statusCode: 403, reason: "forbidden", message });
/**
 * Who counts as a person for Publish and Do not publish: a human actor that reached the product through its own UI or a
 * session route (source "ui" or "route"), carrying no token scopes, with a user id and no delegated agent ceiling. Every
 * other actor is refused: an A2A, MCP, worker, scheduler or agent source (the header-built human of the passthrough road
 * included), and any token-scoped actor. Local to the publish decision; the other human-only gates keep their own rules.
 */
function isPublishDecider(actor: PrimitiveActorContext | null | undefined): actor is PrimitiveActorContext & { userId: string } {
  return actor?.actorType === "human" && (actor.source === "ui" || actor.source === "route") && actor.tokenScopes === undefined
    && typeof actor.userId === "string" && actor.userId.length > 0 && !actor.oboCeiling;
}

/**
 * The site widget's reader, as the widget lifecycle door builds it (widget-lifecycle-frame-actor.ts): a human actor of
 * source "a2a", with no token scopes, a user id and no delegated agent ceiling. Admitted ONLY by
 * widgetReaderMayDecidePublish (the card's restricted reading) and by the two widget answers below
 * (cinatra#4758), which only the widget's decide route calls, after it consumed the reader's own credential under the
 * decide grant and bound the run to that widget session. Publish and Do not publish refuse this actor (isPublishDecider).
 */
function isWidgetPublishReader(actor: PrimitiveActorContext | null | undefined): actor is PrimitiveActorContext & { userId: string } {
  return actor?.actorType === "human" && actor.source === "a2a" && actor.tokenScopes === undefined
    && typeof actor.userId === "string" && actor.userId.length > 0 && !actor.oboCeiling;
}

/** A run that is not found, and a run the person may not see (outside its organization), answer the same. */
const hidden = () => new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });

/**
 * Who may decide a publish, for Publish and Do not publish alike. The decider is ONE principal: the person of
 * `actorContext` (isPublishDecider: a human actor from the UI or a session route, with no token scopes, a user id and no
 * delegated agent ceiling; every other actor is refused before any read), and a member of the run's organization.
 *   - A run with a human owner: run.execute and run.approveHitl under the run's effective policy, as every gate decision.
 *   - A run with no human owner (runBy null, and only null): the policy's owner tier would refuse everyone, so the
 *     person's role in the run's organization is resolved first and both permissions are asked of the kernel for that
 *     organization, with the token-scope and agent-ceiling checks of enforceRunAccess kept (the run's stored ceiling is
 *     on the probe) and the run policy not applied.
 *   - A run whose owner is neither null nor a non-empty string is refused.
 * A run that is not found, and a person outside the run's organization, answer the same 404 "Not found.".
 * Answers the run, the decider and the decider's write authority in the run's organization.
 */
export async function enforcePublishDecisionAccess(input: DecideInput): Promise<{ run: AgentRunRecord; deciderId: string; authority: OrgWriteAuthority }> {
  const actor = input.actorContext;
  if (!isPublishDecider(actor)) throw forbidden("Only a person can decide a publish.");
  return enforcePublishDecisionRights(actor, input);
}

/**
 * May the site widget's reader decide this publish? READ ONLY, for the card's restricted reading: the widget reader
 * (isWidgetPublishReader) and then the SAME rights enforcePublishDecisionAccess asks after its person check (run.execute
 * and run.approveHitl, membership of the run's organization). Any other actor, and any refusal or fault, is false.
 */
export async function widgetReaderMayDecidePublish(input: DecideInput): Promise<boolean> {
  const actor = input.actorContext;
  if (!isWidgetPublishReader(actor)) return false;
  return enforcePublishDecisionRights(actor, input).then(() => true, () => false);
}

/** The access check of the site widget's answers: the widget reader (isWidgetPublishReader), then the SAME rights
 *  enforcePublishDecisionAccess asks after its person check. Any other actor is refused before any read. */
async function enforceWidgetPublishDecisionAccess(input: DecideInput): Promise<{ run: AgentRunRecord; deciderId: string; authority: OrgWriteAuthority }> {
  const actor = input.actorContext;
  if (!isWidgetPublishReader(actor)) throw forbidden("Only a person can decide a publish.");
  return enforcePublishDecisionRights(actor, input);
}

type DecisionAccess = typeof enforcePublishDecisionAccess;

/** The rights half of the publish decision's access check, for a person already admitted by the caller. */
async function enforcePublishDecisionRights(
  actor: PrimitiveActorContext & { userId: string },
  input: DecideInput,
): Promise<{ run: AgentRunRecord; deciderId: string; authority: OrgWriteAuthority }> {
  const deciderId = actor.userId;
  const run = await readAgentRunById(input.runId);
  const { enforceRunAccess, resolveEffectivePolicy } = await import("./auth-policy");
  const { resolveOrgRoleForUser } = await import("@/lib/auth-session");
  const notMember = hidden;
  let runForCheck: Parameters<typeof enforceRunAccess>[0] = null;
  let roles = input.roleHints;
  if (run && run.runBy !== null && (typeof run.runBy !== "string" || run.runBy.length === 0)) throw hidden();
  const headless = run !== null && run.runBy === null;
  let role = headless ? await resolveOrgRoleForUser(run.orgId, deciderId) : undefined;
  if (run && headless) {
    if (role === undefined) throw notMember();
    runForCheck = { id: run.id, runBy: null, orgId: run.orgId, coOwnerUserIds: [], oboCeiling: run.oboCeiling };
    roles = { ...input.roleHints, orgRole: role, actorOrganizationId: run.orgId };
  } else if (run) {
    const template = await readAgentTemplateById(run.templateId);
    const coOwners = await readRunCoOwners(run.id);
    runForCheck = { id: run.id, runBy: run.runBy, orgId: run.orgId, effectivePolicy: resolveEffectivePolicy(run, template),
      coOwnerUserIds: coOwners.map((r) => r.userId) };
  }
  await enforceRunAccess(runForCheck, actor, "execute", roles);
  await enforceRunAccess(runForCheck, actor, "approveHitl", roles);
  if (!run) throw hidden();
  if (!headless) role = await resolveOrgRoleForUser(run.orgId, deciderId);
  if (role === undefined) throw notMember();
  return { run, deciderId, authority: sessionAuthorityFromResolvedRole(run.orgId, role) };
}

/**
 * "Do not publish" (the publish card's Do not allow, cinatra#4758). The decider and the authority are those of
 * enforcePublishDecisionAccess. Then ONE decision write (parked -> declined, with that person and the optional note),
 * then the run moves pending_approval -> stopped. It never sends anything to the run's context. A late answer is
 * reported as publish_decision_not_open with the decision's current status. Every fault after the person check, a read
 * of the authority check included, surfaces as publish_decision_unavailable with a fixed text; access and store refusals
 * pass.
 */
export async function declinePublishDecision(input: DecideInput & { note?: string | null }): Promise<PublishDecisionAnswer> {
  return declineWith(enforcePublishDecisionAccess, input);
}

/** "Do not allow" from the site widget (cinatra#4758): declinePublishDecision for the widget's reader. Called only by
 *  the widget's decide route, after the decide grant and the run's widget-session binding. */
export async function declinePublishDecisionAsWidgetReader(input: DecideInput & { note?: string | null }): Promise<PublishDecisionAnswer> {
  return declineWith(enforceWidgetPublishDecisionAccess, input);
}

async function declineWith(access: DecisionAccess, input: DecideInput & { note?: string | null }): Promise<PublishDecisionAnswer> {
  try {
    const { run, deciderId, authority } = await access(input);
    const open = await readOpenDecisionForRun(run.id);
    if (!open) {
      const latest = await readLatestDecisionForRun(run.id);
      return { ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: latest?.status ?? null };
    }
    const note = typeof input.note === "string" && input.note.trim().length > 0 ? input.note : null;
    const target = answerTarget(run.id, open, input.decisionId);
    const answer = await decide(target.id, { from: "parked", to: "declined", actor: deciderId, note, ...target.guard });
    if (answer.outcome === "lost") return { ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: answer.currentStatus };
    // false: the run is not waiting at the gate. A fault here, or a run still running, leaves the stop to the expiry pass.
    return { ok: true, runStopped: await stopHeldRun(run.id, "pending_approval", authority) };
  } catch (err) {
    throw opaque(err);
  }
}

export type PublishApproveAnswer =
  | { ok: true; resumed: boolean }
  | { ok: false; code: typeof PUBLISH_REVIEW_NOT_APPROVED }
  | Extract<PublishDecisionAnswer, { ok: false }>;

/** The text sent into the held gate. The gate's output feeds no step, so it carries no value. */
const PUBLISH_RESUME_TEXT = "[Publish approved]";

/**
 * "Publish" (the publish card's Allow, cinatra#4758). The decider and the authority are those of
 * enforcePublishDecisionAccess, then the agent's install scope for that person, as the generic approve asks it. The run
 * must hold a WayFlow context of an internal template. Its decision is the open (parked) one, or else a released one (a
 * resume that failed before its send). The run's pause is claimed first (claimPause, cinatra#4245, the claim every
 * resume road takes, bound to the decision's gate task; the run stays pending_approval): only the claim holder releases or resumes, so a run that is not
 * waiting (another resume holds it, or it went on or ended) gets no release ({ ok: true, resumed: false } when its
 * newest decision is released, else publish_decision_not_open). Under the claim, the run must still wait at the
 * decision's own gate task (pauseIsDecisionGate: the run row, and the latest-task key when present; a released decision
 * is claimed at the pause generation its release recorded and read by releasedAtPause, or, released by older code, needs
 * the key), and the review fence of the decision's attempt must still hold (reviewFenceHolds, read again here: else the
 * claim is given back and the answer is publish_review_not_approved, cinatra#4762). Before that, under the claim, the
 * graph the run is bound to execute (readRunBoundGraph) must pass the first dispatch's publishing route check
 * (checkExecutedPublishingCallRoutes, cinatra#4762): a run bound before that check, or with no readable binding, is not
 * released; it ends failed with the check's fixed PUBLISH_CALL_UNCHECKED text in the move that closes the attempt's
 * parked decision and clears the claim (the claim is given back when that move loses), and the answer is
 * publish_decision_not_open with the current status; then ONE decision
 * write (parked -> released, with that person and the pause generation the claim holds), the steps that can fail before the send (the client, the credential, the message id), the fence (the one move pending_approval -> running,
 * under the claim) and ONE message sent into the held context. A run at another gate or another pause generation than
 * the release recorded, a released decision with neither a recorded pause nor a latest-task key, or a latest-task read that faults gives the claim back and resumes nothing. A late answer is publish_decision_not_open with the current status. A resume
 * that fails before its fence gives the claim back; a fence lost to a stop or to another claimer sends nothing; after the
 * fence the run stays where the send left it and the send's lease is settled (when that settle write fails, it is logged
 * and the lease stays until it expires). Its fault is publish_resume_failed, with a fixed text. When the give-back faults,
 * the run is moved pending_approval -> failed (terminal, so no released decision waits on a run no road can claim); that
 * move lands only while the run is still pending_approval, so a stop that landed first leaves the run stopped. When that
 * write faults too, the fault surfaces as publish_decision_unavailable. A fault of a read of the authority check or of the install-scope
 * check surfaces as publish_decision_unavailable with a fixed text, as in Do not publish; access and store refusals
 * pass, and a scope refusal is answered as before.
 */
export async function approvePublishDecision(input: DecideInput): Promise<PublishApproveAnswer> {
  return approveWith(enforcePublishDecisionAccess, input);
}

/** "Allow" from the site widget (cinatra#4758): approvePublishDecision for the widget's reader. Called only by the
 *  widget's decide route, after the decide grant and the run's widget-session binding. */
export async function approvePublishDecisionAsWidgetReader(input: DecideInput): Promise<PublishApproveAnswer> {
  return approveWith(enforceWidgetPublishDecisionAccess, input);
}

async function approveWith(enforce: DecisionAccess, input: DecideInput): Promise<PublishApproveAnswer> {
  let access: Awaited<ReturnType<typeof enforcePublishDecisionAccess>>;
  try {
    access = await enforce(input);
  } catch (err) {
    throw opaque(err);
  }
  const { run, deciderId, authority } = access;
  const { assertAgentRunDispatchAuthorized } = await import("./agent-run-serde");
  await assertAgentRunDispatchAuthorized({ runId: run.id, stage: "dispatch", actingUserId: deciderId }).catch((err: unknown) => {
    if ((err as { code?: unknown } | null)?.code !== "AGENT_TEMPLATE_SCOPE_DENIED") throw opaque(err);
    console.warn("[publish-decision] a Publish was refused by the agent's install scope");
    throw forbidden("Run access denied.");
  });
  let agentUrl: string;
  let contextId: string;
  // cinatra#3745: the decision this Publish releases or resumes, named in the resume message.
  let releasedDecisionId: string;
  let claim: Extract<Awaited<ReturnType<typeof claimPause>>, { kind: "claimed" }>;
  const giveBack = () => releasePauseClaim({ runId: run.id, orgId: run.orgId, token: claim.token }, authority).catch(() =>
    moveRun(run.id, "pending_approval", "failed", { error: `${PUBLISH_RESUME_FAILED}: the run could not be put back`, completedAt: new Date() }, authority));
  try {
    const template = await readAgentTemplateById(run.templateId);
    if (!run.a2aContextId || !template?.packageName || template.sourceType !== "internal") throw new Error("not resumable");
    agentUrl = resolveWayflowUrl(template.packageName);
    contextId = run.a2aContextId;
    const open = await readOpenDecisionForRun(run.id);
    const target = open ?? (await readLatestDecisionForRun(run.id));
    if (!target || (!open && target.status !== "released")) return { ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: target?.status ?? null };
    // An answer that names its row is never applied to another gate: a newer open decision, or another released one.
    if (input.decisionId !== undefined && target.id !== input.decisionId) return { ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: null };
    releasedDecisionId = target.id;
    // claimPause refuses a generation that cannot be read.
    // The claim is bound to the decision's own gate task as well as to a generation: it lands only while the run waits
    // at that task, in one statement, so this resume never holds a pause the run took at another task. A released
    // decision that recorded the pause it was released at is claimed at THAT generation (releasedAtPause): the claim
    // lands only while the run still waits at the very pause the Allow released.
    const recorded = open ? null : (target.releasedPauseGeneration ?? null);
    const claimed = await claimPause(
      { runId: run.id, orgId: run.orgId, generation: recorded ?? (run.pauseGeneration as number), taskId: target.gateTaskId },
      authority,
    );
    if (claimed.kind === "refused") {
      const latest = await readLatestDecisionForRun(run.id);
      return latest?.status === "released" ? { ok: true, resumed: false } : { ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: latest?.status ?? null };
    }
    claim = claimed;
    const answerOn = open ? answerTarget(run.id, open, input.decisionId) : null;
    try {
      // The run row read before the claim is the pause the claim holds (claimPause wins only at that pause generation
      // and gate task, and every pause raises the generation). A released decision with a recorded pause is decided by
      // that record alone (releasedAtPause); any other decision reads the latest-task key, and a read that faults
      // refuses here. A RELEASED decision with no recorded pause needs that key to name its gate task: see
      // pauseIsDecisionGate.
      let atGate: boolean;
      if (recorded !== null) atGate = releasedAtPause(run, target) === true;
      else {
        const { resolveLatestWayflowGateTaskId } = await import("@cinatra-ai/a2a");
        atGate = pauseIsDecisionGate(run, target.gateTaskId, await resolveLatestWayflowGateTaskId(run.id), open ? "open" : "released");
      }
      if (!atGate) {
        await giveBack();
        return { ok: true, resumed: false };
      }
      // cinatra#4762: the graph the run is bound to execute is checked as the first dispatch checks it, before any
      // release. A run first dispatched before that check keeps the graph it bound then, and no resume road selects a
      // source again, so this is where its publishing calls are read. A run with no readable binding cannot be checked
      // and is refused the same way. A refusal ends the run failed with the compiler's fixed text, in the move that
      // also closes the attempt's parked decision and clears the claim; nothing is released or sent.
      const generation = run.resetGeneration ?? 0;
      const { checkExecutedPublishingCallRoutes } = await import("./oas-compiler");
      const routes = checkExecutedPublishingCallRoutes((await readRunBoundGraph(run.id)) ?? "");
      if (!routes.ok) {
        const ended = await moveRun(run.id, "pending_approval", "failed",
          { error: routes.error, completedAt: new Date(), attemptGeneration: generation, endParkedDecisions: true }, authority);
        if (!ended) await giveBack();
        const latest = await readLatestDecisionForRun(run.id);
        return { ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: latest?.status ?? null };
      }
      // cinatra#4762: the review fence is read again under the claim, and the release is written in the SAME transaction
      // as that read, under the run row's lock (withRunRowLock): no output of the run is in flight while it runs, so an
      // output of the attempt begun after the park is either committed and seen here (and refuses the Publish) or begins
      // after the release commits, where the call-site check (publishCallAllowed) reads the fence again. A review of the
      // attempt raised or settled otherwise since the park refuses it too. The claim is given back and the decision
      // stays as it is; nothing is sent.
      // A decision with no generation (written by code older than the column) is the current attempt's, as the store reads
      // it (CURRENT_ATTEMPT): it is approved under the run's own generation, never read as attempt 0.
      const answer = await withRunRowLock(run.id, async (tx, locked) => {
        if (locked?.resetGeneration !== generation || (target.runGeneration ?? generation) !== generation ||
          !(await reviewFenceHolds({ runId: run.id, orgId: run.orgId, generation, executor: tx }))) return null;
        // The release records the pause generation its claim holds, in the same write.
        return answerOn
          ? decide(answerOn.id, { from: "parked", to: "released", actor: deciderId, pauseGeneration: claim.generation, ...answerOn.guard }, tx)
          : { outcome: "won" as const };
      });
      if (answer === null) {
        await giveBack();
        return { ok: false, code: PUBLISH_REVIEW_NOT_APPROVED };
      }
      if (answer.outcome !== "won") {
        await giveBack();
        return { ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: answer.currentStatus };
      }
    } catch (err) {
      await giveBack();
      throw err;
    }
  } catch (err) {
    throw opaque(err);
  }
  // cinatra#4245: everything that can fail before the send comes before the fence and gives the claim back; past the
  // fence every failure counts as possibly sent, so the send's lease is settled and nothing is given back.
  let stage: "before-fence" | "fence-lost" | "fenced" = "before-fence";
  const settle = () => settlePauseSend({ runId: run.id, orgId: run.orgId, token: claim.token }, authority).then(() => undefined, (err: unknown) => {
    // The lease frees itself when it ends.
    console.warn(`[publish-decision] the claim of a sent publish could not be settled: ${nameOf(err)}`);
  });
  try {
    const { prepareWayflowResume, sendWayflowResume } = await import("./review-task-actions");
    // cinatra#3745: the resume names the decision this Publish released, for the calls of this visit.
    const prepared = await prepareWayflowResume(run.id, agentUrl, { publishDecisionId: releasedDecisionId });
    try {
      await transitionRunStatus(run.id, "pending_approval", "running", { pauseFence: { token: claim.token, generation: claim.generation } }, authority);
    } catch (err) {
      // A stop or another claimer since the claim: the lease is no longer this Publish's, and nothing is sent.
      if (isStale(err)) stage = "fence-lost";
      throw err;
    }
    stage = "fenced";
    await sendWayflowResume({ run, contextId, text: PUBLISH_RESUME_TEXT, authority, prepared, pauseClaimToken: claim.token });
  } catch (err) {
    console.warn(`[publish-decision] a released publish could not resume its run: ${nameOf(err)}`);
    if (stage === "before-fence") await giveBack().catch((fault: unknown) => { throw opaque(fault); });
    else if (stage === "fenced") await settle();
    throw Object.assign(new Error("The publish is approved, but the run could not go on."), { code: PUBLISH_RESUME_FAILED });
  }
  await settle();
  return { ok: true, resumed: true };
}

type FlowComponent = Record<string, unknown>;
const isComponent = (value: unknown): value is FlowComponent => !!value && typeof value === "object" && !Array.isArray(value);

const addTo = (map: Map<string, FlowComponent[]>, name: string, comp: FlowComponent) => map.set(name, [...(map.get(name) ?? []), comp]);

/** Every component of the document by the key it is declared under in a `$referenced_components` map, at any depth (a
 *  key declared in more than one scope names all of them, so a reference read against it reaches each, fail closed),
 *  and every object of the document by its own `id`, inline ones included. */
function indexComponents(document: FlowComponent): { byKey: Map<string, FlowComponent[]>; byId: Map<string, FlowComponent[]> } {
  const byKey = new Map<string, FlowComponent[]>();
  const byId = new Map<string, FlowComponent[]>();
  const seen = new Set<object>();
  const stack: unknown[] = [document];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const comp = value as FlowComponent;
    if (typeof comp.id === "string") addTo(byId, comp.id, comp);
    if (isComponent(comp.$referenced_components)) {
      for (const [key, child] of Object.entries(comp.$referenced_components)) if (isComponent(child)) addTo(byKey, key, child);
    }
    stack.push(...Object.values(comp));
  }
  return { byKey, byId };
}

/** The ids of every component inside `root` (the root's own included): each object's `id`, each key of a
 *  `$referenced_components` map, and every component a `$component_ref` names, followed. Over-reading is fail closed. */
function idsInside(root: FlowComponent, byKey: Map<string, FlowComponent[]>): Set<string> {
  const ids = new Set<string>();
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const comp = value as FlowComponent;
    if (typeof comp.$component_ref === "string") {
      ids.add(comp.$component_ref);
      stack.push(...(byKey.get(comp.$component_ref) ?? []));
    }
    if (typeof comp.id === "string") ids.add(comp.id);
    if (isComponent(comp.$referenced_components)) for (const key of Object.keys(comp.$referenced_components)) ids.add(key);
    stack.push(...Object.values(comp));
  }
  return ids;
}

const declaresPublishes = (comp: FlowComponent): boolean => {
  const cinatra = isComponent(comp.metadata) ? comp.metadata.cinatra : undefined;
  return isComponent(cinatra) && cinatra.publishes === true;
};

/** The publishing step of `stepId` in a flow document: the step itself when it is a publishing node, else the one
 *  publishing node it lies inside, else the step as unrelated to any publishing node. The publishing nodes are the
 *  template's list and every component the document itself declares `publishes: true`. null: inside more than one.
 *
 *  One component carries two names: the key it is declared under in a `$referenced_components` map, which the compiler
 *  records in the template's list and under which the decision is stored, and its own `id`, which the runtime signs for
 *  its calls. Both names resolve to the one component, and a publishing step is always named canonically: the listed
 *  name it carries, else its key, else its own id (an inline component). A name that two components carry (a shared id,
 *  or an id equal to another component's key) resolves only when the same publishing step governs every component it
 *  names; otherwise it is ambiguous and refused (null), as is a publishing component that carries two listed names or
 *  whose canonical name another component also carries. */
function publishingStepInGraph(
  document: FlowComponent,
  stepId: string,
  listed: readonly string[],
): { step: string; publishing: boolean } | null {
  const { byKey, byId } = indexComponents(document);
  const keyOf = new Map<FlowComponent, string>();
  for (const [key, comps] of byKey) for (const comp of comps) keyOf.set(comp, key);
  const namesOf = (comp: FlowComponent): string[] =>
    [...new Set([keyOf.get(comp), typeof comp.id === "string" ? comp.id : undefined])].filter((name): name is string => name !== undefined);
  const named = (name: string): FlowComponent[] => [...new Set([...(byKey.get(name) ?? []), ...(byId.get(name) ?? [])])];
  const AMBIGUOUS = Symbol("ambiguous");
  const canonical = (comp: FlowComponent): string | typeof AMBIGUOUS => {
    const listedNames = namesOf(comp).filter((name) => listed.includes(name));
    if (listedNames.length > 1) return AMBIGUOUS;
    const name = listedNames[0] ?? keyOf.get(comp) ?? (typeof comp.id === "string" ? comp.id : undefined);
    // The decision stored under the name must be this component's alone.
    return name !== undefined && named(name).length === 1 ? name : AMBIGUOUS;
  };
  const containers = new Set<FlowComponent>();
  for (const name of listed) for (const comp of named(name)) containers.add(comp);
  for (const comps of [...byKey.values(), ...byId.values()]) for (const comp of comps) if (declaresPublishes(comp)) containers.add(comp);

  // The publishing step that governs one component (or, for a name no component carries, that name): the component
  // itself when it is a publishing node, else the one publishing node it lies inside, else none (undefined).
  const governing = (comp: FlowComponent | null): string | undefined | typeof AMBIGUOUS => {
    if (comp !== null && containers.has(comp)) return canonical(comp);
    const holders = new Set<string | typeof AMBIGUOUS>();
    for (const container of containers) {
      const inside = comp !== null ? componentsInside(container, byKey).has(comp) : idsInside(container, byKey).has(stepId);
      if (inside) holders.add(canonical(container));
    }
    if (holders.size > 1) return AMBIGUOUS;
    const [holder] = holders;
    return holder;
  };

  const comps = named(stepId);
  const steps = new Set(comps.length === 0 ? [governing(null)] : comps.map(governing));
  if (steps.size !== 1) return null;
  const [step] = steps;
  if (step === undefined) return { step: stepId, publishing: false };
  return typeof step === "string" ? { step, publishing: true } : null; // the symbol: ambiguous
}

/** Every component below `root` (the root itself excluded), every `$component_ref` followed to each component its key
 *  names. Over-reading is fail closed. */
function componentsInside(root: FlowComponent, byKey: Map<string, FlowComponent[]>): Set<object> {
  const found = new Set<object>();
  const seen = new Set<object>([root]);
  const stack: unknown[] = Object.values(root);
  while (stack.length > 0) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    const comp = value as FlowComponent;
    found.add(comp);
    if (typeof comp.$component_ref === "string") stack.push(...(byKey.get(comp.$component_ref) ?? []));
    stack.push(...Object.values(comp));
  }
  return found;
}

/**
 * The publishing step whose decision governs a call of the verified step `stepId` (cinatra#4762). The runtime signs the
 * id of the step that executes, so a call made by a step nested inside a publishing FlowNode names that nested step,
 * while the decision is stored under the FlowNode. The ancestry is read from the graph the run is bound to execute
 * (readRunBoundGraph), never from the request, where a component's key and its own id name the same publishing step.
 * When the graph cannot be read, a step the template lists, or a step with its own decision row, is its own; any other step is refused (null) when the template lists a publishing step
 * or the run's current attempt holds any decision, since it may lie inside a publishing node; else it is unrelated.
 * A read error propagates.
 */
async function resolvePublishingStep(
  runId: string,
  stepId: string,
  listed: readonly string[],
): Promise<{ step: string; publishing: boolean } | null> {
  const source = await readRunBoundGraph(runId);
  let document: unknown = null;
  if (source !== null) {
    try {
      document = JSON.parse(source);
    } catch { /* unreadable: no graph */ }
  }
  if (isComponent(document)) return publishingStepInGraph(document, stepId, listed);
  if (listed.includes(stepId)) return { step: stepId, publishing: true };
  if (await readDecisionForRunNode(runId, stepId)) return { step: stepId, publishing: true };
  if (listed.length > 0 || (await readLatestDecisionForRun(runId))) return null;
  return { step: stepId, publishing: false };
}

/** The release of a publishing call's claim: it resolves once the release is written, or logged as not written. */
export type PublishCallRelease = () => Promise<void>;

/** cinatra#4762 — the claim a publishing call took: the released decision it holds. The caller carries it with the call,
 *  so the call's own output passes the in-flight fence of exactly this claim (lifecycle-emit buildProducedEventInsertOp). */
export interface PublishCallClaim {
  decisionId: string;
}

/**
 * Does the run still wait at the pause of the gate task `gateTaskId`? Read from the run row (durable): the run is
 * pending_approval and its a2a_task_id names that gate task. Every pause writes the run's gate task before its move to
 * pending_approval (the interrupt's task-id write, or the move's own pauseTaskId), and every gate visit mints a new task
 * id, so a run that went on and paused at another gate names that gate instead. `latest` is the latest-task key
 * (Redis, a seven-day key that can be lost): when it holds a value it must agree; when it is absent it adds nothing.
 */
function runWaitsAtGateTask(run: Pick<AgentRunRecord, "status" | "a2aTaskId">, gateTaskId: string, latest: string | null): boolean {
  return run.status === "pending_approval" && gateTaskId.length > 0 && run.a2aTaskId === gateTaskId
    && (latest === null || latest === gateTaskId);
}

/**
 * Does the run still wait at the very pause this released decision was released at? Read from durable data only: the
 * release recorded the run's pause generation its claim held (releasedPauseGeneration), and every entry into
 * pending_approval and every fence raises that generation. So:
 *   - true: the run is pending_approval at the recorded generation and its row names the decision's gate task: the
 *     resume died before its fence, and the run is still parked at this gate;
 *   - false: the run is not pending_approval, or it is at another generation: it went on (and may wait at another gate);
 *   - null: no recorded generation (a decision released by code older than the record), or the run is at the recorded
 *     generation but its row names another task (a state no write makes): the caller fails closed.
 */
function releasedAtPause(
  run: Pick<AgentRunRecord, "status" | "a2aTaskId" | "pauseGeneration">,
  decision: Pick<PublishDecisionRow, "gateTaskId" | "releasedPauseGeneration">,
): boolean | null {
  const recorded = decision.releasedPauseGeneration;
  if (recorded === null || recorded === undefined) return null;
  if (run.status !== "pending_approval" || run.pauseGeneration !== recorded) return false;
  return decision.gateTaskId.length > 0 && run.a2aTaskId === decision.gateTaskId ? true : null;
}

/**
 * Is the run's pause this decision's own gate (cinatra#4758)? The run row must wait there (runWaitsAtGateTask). What
 * else proves it depends on the decision:
 *   - an OPEN (parked) decision that is the run's newest holds every resume road (assertNoOpenPublishDecision), so the
 *     run cannot have gone past its gate, and the hold wrote that gate's task in the compare-and-set that entered the
 *     pause: the run row is enough, and a latest-task key that is absent adds nothing;
 *   - a RELEASED decision holds nothing: the run may have gone on and paused again. The run row's task can then still
 *     name this gate (a pause entered without its own task write keeps the column, and that write can lose a race,
 *     event-log.ts), so the row alone is ambiguous. A release that recorded its pause generation is read by
 *     releasedAtPause instead; for one released by older code, only the latest-task key, written before every gate is
 *     shown, proves the run still waits here: it must name this gate. Absent, it proves nothing, and nothing resumes.
 */
function pauseIsDecisionGate(
  run: Pick<AgentRunRecord, "status" | "a2aTaskId">,
  gateTaskId: string,
  latest: string | null,
  decision: "open" | "released",
): boolean {
  if (decision === "released" && latest === null) return false;
  return runWaitsAtGateTask(run, gateTaskId, latest);
}

/**
 * A released decision whose run did NOT go on (the publish card's retry, cinatra#4758): Publish wrote `released`, then a
 * step before its fence failed (or the process died there), so the run still waits at this decision's own pause. Publish
 * again resumes exactly such a run (approveWith: it takes a released decision, writes no second decision, and resumes
 * only under a pause claim bound to the decision's gate task, and the fence), so the card keeps its Allow for it.
 * A release that recorded its pause generation is read from that durable record alone (releasedAtPause): the run still
 * pending_approval at that generation awaits its resume (Allow); at any other generation, or out of pending_approval, it
 * went on (Approved). No latest-task key is read for it. One released by older code keeps this reading, with three
 * answers:
 *   - true: the run row and the latest-task key both name this gate (pauseIsDecisionGate): Allow;
 *   - false: the run shows that it left this pause (not pending_approval, its row names another task, or the key names
 *     another task): the decision is settled, Approved;
 *   - null: the row still names this gate but the key is absent, or its read faults. The row alone cannot tell this
 *     pause from a later one, so the card draws nothing: never Approved (the run may wait here), never Allow (it may
 *     wait at another gate, which an Allow would answer).
 * Reads only.
 */
export async function releasedPublishAwaitsResume(
  run: Pick<AgentRunRecord, "id" | "status" | "a2aTaskId" | "pauseGeneration">,
  decision: Pick<PublishDecisionRow, "status" | "gateTaskId"> & Partial<Pick<PublishDecisionRow, "releasedPauseGeneration">>,
): Promise<boolean | null> {
  if (decision.status !== "released" || !decision.gateTaskId) return false;
  const recorded = decision.releasedPauseGeneration ?? null;
  if (recorded !== null) return releasedAtPause(run, { gateTaskId: decision.gateTaskId, releasedPauseGeneration: recorded });
  if (!runWaitsAtGateTask(run, decision.gateTaskId, null)) return false;
  let latest: string | null;
  try {
    const { resolveLatestWayflowGateTaskId } = await import("@cinatra-ai/a2a");
    latest = await resolveLatestWayflowGateTaskId(run.id);
  } catch {
    return null;
  }
  if (latest === null) return null;
  return pauseIsDecisionGate(run, decision.gateTaskId, latest, "released");
}

/**
 * The call-site check of the model bridge and the passthrough road (A6): may this call of `run` go on? `verifiedStepId`
 * is the step the runtime signed for the call, or undefined when the call carries no verified step.
 *   - A verified step with a decision row is served only while that row (its newest) reads `released` and the review
 *     fence of its attempt still holds (reviewFenceHolds, read under the run row's lock, cinatra#4762): an output of the
 *     attempt written after the release, or a review of it opened since, refuses the call until it is approved. In the
 *     same transaction the call takes the decision (claimPublishCall): until its release is written, no output or review of
 *     the run is written, so nothing the fence did not see comes before the call's effect. A claim that cannot be
 *     taken refuses the call. The claim is handed to `holdRelease` with its release (and the decision it holds, so the
 *     call's own output passes the in-flight fence of that claim only): the caller runs the release once the call is
 *     done, whatever its outcome, and awaits it before it answers, so the next node of the run never writes an output or
 *     opens a review while the release is still pending. The release never rejects: a release that cannot be written is
 *     logged, and the claim stays counted, so the attempt's later outputs and reviews stay refused until a retry's reset
 *     (fail closed).
 *   - The verified step is first resolved to the publishing step that governs it (resolvePublishingStep): a step inside a
 *     publishing container (a FlowNode, a ParallelFlowNode or an AgentNode declared `publishes: true`) is fenced and
 *     claimed under that container's decision, exactly as a call of the container itself.
 *   - A verified step with no row is refused when the template lists it as a publishing step, or when it lies inside one.
 *   - A call with no verified step is refused when the template lists any publishing step.
 *   - A template that is not found cannot prove that it publishes nothing; a list stored as null (a template compiled
 *     before the list existed) lists none, so only a decision row holds such a run.
 * A read error refuses the call; it is logged by the error's name only.
 */
export async function publishCallAllowed(
  run: { id: string; templateId: string },
  verifiedStepId: string | undefined,
  holdRelease: (release: PublishCallRelease, claim: PublishCallClaim) => void,
): Promise<boolean> {
  try {
    const template = await readAgentTemplateById(run.templateId);
    const listed = template?.publishingSteps ?? [];
    if (verifiedStepId === undefined) return template !== null && listed.length === 0;
    const resolved = await resolvePublishingStep(run.id, verifiedStepId, listed);
    if (resolved === null) return false;
    const step = resolved.step;
    const row = await readDecisionForRunNode(run.id, step);
    if (row) {
      if (row.status !== "released") return false;
      // The decision read before the lock may be stale: a reset since then stamped it with the attempt it ended (a row
      // read with no generation included) and moved the run to a newer attempt, whose own approval it is not. Under the
      // lock the decision is read again; only that reading decides, and it must still be the same released row.
      const claimed = await withRunRowLock(run.id, async (tx, locked) => {
        if (!locked) return false;
        const current = await readDecisionForRunNode(run.id, step, tx);
        if (!current || current.id !== row.id || current.status !== "released") return false;
        if (current.runGeneration != null && current.runGeneration !== locked.resetGeneration) return false;
        if (!(await reviewFenceHolds({ runId: run.id, orgId: locked.orgId, generation: current.runGeneration ?? locked.resetGeneration, executor: tx }))) return false;
        return claimPublishCall(current.id, tx);
      });
      if (claimed) {
        let released: Promise<void> | undefined;
        holdRelease(() => (released ??= endPublishCall(row.id).catch((err: unknown) => {
          // The count stays up: the run's output stays refused until a retry's reset (fail closed).
          console.warn(`[publish-decision] the end of a publishing call could not be written: ${nameOf(err)}`);
        })), { decisionId: row.id });
      }
      return claimed;
    }
    return template !== null && !resolved.publishing && !listed.includes(step);
  } catch (err) {
    console.warn(`[publish-decision] a call could not check its publish decision: ${nameOf(err)}`);
    return false;
  }
}

export interface PublishExpirySweepSummary {
  due: number;
  expired: number;
  runEnded: number;
  lost: number;
  failed: number;
  stopped: number; // runs a decline or an expiry decided but did not stop, stopped by this pass
}

/**
 * The 24-hour expiry. It reads the due open decisions page by page to the end, so a row that keeps failing never hides the
 * next. A due row closes with no person: `expired` when its run is held (pending_approval, or running when a hold wrote
 * its row but not its move) and the row is still the run's newest decision, checked in the same write, and the run then
 * moves from that status to stopped; else `run_ended`. Then it reads, page by page to the end, every held run whose newest
 * decision is declined or expired (a fault or a crash between the decision write and the run move), reads that run's
 * newest decision again, and moves the run to stopped while the listed row is still the newest. A row whose write or stop
 * faults is counted failed and tried again next pass. No row resumes a run; no feature fence is read. `authorityFor` is
 * the caller's dispatch authority for the run's org; `now` is the clock the tests inject.
 */
export async function sweepExpiredPublishDecisions(opts: {
  authorityFor: (orgId: string) => OrgWriteAuthority;
  limit?: number;
  now?: Date;
}): Promise<PublishExpirySweepSummary> {
  const summary: PublishExpirySweepSummary = { due: 0, expired: 0, runEnded: 0, lost: 0, failed: 0, stopped: 0 };
  const fault = (err: unknown) => {
    summary.failed += 1;
    console.error(`[publish-decision-expiry] a decision was not closed this pass: ${nameOf(err)}`);
  };
  const limit = opts.limit ?? EXPIRY_PAGE;
  const eachRow = async (read: (after?: string) => Promise<PublishDecisionRow[]>, visit: (row: PublishDecisionRow) => Promise<void>) => {
    for (let after: string | undefined = undefined; ;) {
      const page = await read(after);
      for (const row of page) await visit(row).catch(fault);
      if (page.length < limit) return;
      after = page[page.length - 1]!.id;
    }
  };
  await eachRow((after) => listDueParked(limit, opts.now, after), async (row) => {
    summary.due += 1;
    const run = await readAgentRunById(row.runId);
    const held = heldStatusOf(run?.status);
    let answer = await decide(row.id, held ? { from: "parked", to: "expired", actor: null, newestOnly: true } : { from: "parked", to: "run_ended", actor: null });
    let ended = !held;
    if (held && answer.outcome === "lost" && answer.currentStatus === "parked") { // a newer decision governs the run
      answer = await decide(row.id, { from: "parked", to: "run_ended", actor: null });
      ended = true;
    }
    if (answer.outcome === "lost") summary.lost += 1;
    else if (ended || !held || !run) summary.runEnded += 1;
    else {
      await stopHeldRun(run.id, held, opts.authorityFor(run.orgId)); // a stale answer: the run left meanwhile
      summary.expired += 1;
    }
  });
  // The store lists only the newest decision of each run; a newer one written since is read again before the stop.
  await eachRow((after) => listSettledWithWaitingRun(limit, after), async (row) => {
    const run = await readAgentRunById(row.runId);
    const held = heldStatusOf(run?.status);
    if (!run || !held) return; // the run moved meanwhile
    const newest = await readLatestDecisionForRun(run.id);
    if (newest && newest.id !== row.id) return; // a newer decision governs the run
    if (await stopHeldRun(run.id, held, opts.authorityFor(run.orgId))) summary.stopped += 1;
  });
  return summary;
}
