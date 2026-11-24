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
import { isHumanDecisionFingerprint, isPersonDecider } from "./declared-review-pause";

/** The id prefix of the gate the flow runtime inserts in front of a publishing step. The
 *  compiler reserves the same prefix (oas-compiler.ts, PUBLISH_GATE_ID_PREFIX). */
export const PUBLISH_GATE_NODE_PREFIX = "cinatra_publish_gate__";
export const PUBLISH_DECISION_REQUIRED = "publish_decision_required";
export const PUBLISH_DECISION_NOT_OPEN = "publish_decision_not_open";
export const PUBLISH_GATE_UNVERIFIED = "publish_gate_unverified";
export const PUBLISH_DECISION_UNAVAILABLE = "publish_decision_unavailable";
/** A Publish refused because the review fence of the decision's attempt no longer holds (cinatra#4762). */
export const PUBLISH_REVIEW_NOT_APPROVED = "publish_review_not_approved";
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

/** A review a person approved: settled 'approve' with a decision fingerprint AND a person as its decider of record.
 *  Every terminal decision carries a fingerprint, also one a non-human carrier submits (it records no decider); the
 *  optional review's expiry settles 'approve' with a synthetic fingerprint and no decider. Neither is a person's. */
const personApproved = (g: ReviewOfRun): boolean =>
  g.status === "resolved" && g.disposition === "approve" && isHumanDecisionFingerprint(g.fingerprint)
    && isPersonDecider(g.resolvedBy);

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
 * An approval counts only with a person as its decider of record (personApproved); which person is not compared: the
 * reviewer and the person who answers the publish card may differ. A read error propagates.
 */
export async function approvedReviewPrecedes(runId: string, generation: number, executor?: unknown): Promise<boolean> {
  const all = await reviewSeam().listReviews(runId, ...via(executor));
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

  let park: Awaited<ReturnType<typeof insertParkedDecision>>;
  try {
    park = await insertParkedDecision({
      orgId: run.orgId,
      runId: run.id,
      nodeId,
      gateTaskId: task.id,
      a2aContextId: contextId ?? null,
      surfacedValues: surfacedValuesOf(task),
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
    await moveRun(run.id, fromStatus, "failed", { error: "publish_decision_unrecorded: the publish decision could not be recorded", completedAt: new Date(), ...attempt }, authority);
    return true;
  }
  // A stop this gate task already answered is closed; the newest-decision rule keeps it closed.
  if (park.decision.status !== "parked" || fromStatus === "pending_approval") return true;
  let moved: boolean;
  try {
    moved = await moveRun(run.id, fromStatus, "pending_approval", attempt, authority);
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

type DecideInput = { runId: string; actorContext: PrimitiveActorContext; roleHints?: ActorRoleHints };
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
 * widgetReaderMayDecidePublish, which answers a boolean for the card and decides nothing. Publish and Do not publish
 * still refuse this actor (isPublishDecider); a widget decide door is a later part (cinatra#4758).
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
 * "Do not publish" (its surface is the decision card, a later part). The decider and the authority are those of
 * enforcePublishDecisionAccess. Then ONE decision write (parked -> declined, with that person and the optional note),
 * then the run moves pending_approval -> stopped. It never sends anything to the run's context. A late answer is
 * reported as publish_decision_not_open with the decision's current status. Every fault after the person check, a read
 * of the authority check included, surfaces as publish_decision_unavailable with a fixed text; access and store refusals
 * pass.
 */
export async function declinePublishDecision(input: DecideInput & { note?: string | null }): Promise<PublishDecisionAnswer> {
  try {
    const { run, deciderId, authority } = await enforcePublishDecisionAccess(input);
    const open = await readOpenDecisionForRun(run.id);
    if (!open) {
      const latest = await readLatestDecisionForRun(run.id);
      return { ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: latest?.status ?? null };
    }
    const note = typeof input.note === "string" && input.note.trim().length > 0 ? input.note : null;
    const answer = await decide(open.id, { from: "parked", to: "declined", actor: deciderId, note });
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
 * "Publish" (its surface is the decision card, a later part). The decider and the authority are those of
 * enforcePublishDecisionAccess, then the agent's install scope for that person, as the generic approve asks it. The run
 * must hold a WayFlow context of an internal template. Its decision is the open (parked) one, or else a released one (a
 * resume that failed before its send). The run's pause is claimed first (claimPause, cinatra#4245, the claim every
 * resume road takes; the run stays pending_approval): only the claim holder releases or resumes, so a run that is not
 * waiting (another resume holds it, or it went on or ended) gets no release ({ ok: true, resumed: false } when its
 * newest decision is released, else publish_decision_not_open). Under the claim, the run's current gate visit must be
 * the decision's own gate task, and the review fence of the decision's attempt must still hold (reviewFenceHolds, read
 * again here: else the claim is given back and the answer is publish_review_not_approved, cinatra#4762); then ONE
 * decision write (parked -> released, with that person), the steps that can fail
 * before the send (the client, the credential, the message id), the fence (the one move pending_approval -> running,
 * under the claim) and ONE message sent into the held context. A run at another gate, or whose gate cannot be read,
 * gives the claim back and resumes nothing. A late answer is publish_decision_not_open with the current status. A resume
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
  let access: Awaited<ReturnType<typeof enforcePublishDecisionAccess>>;
  try {
    access = await enforcePublishDecisionAccess(input);
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
    // claimPause refuses a generation that cannot be read.
    const claimed = await claimPause({ runId: run.id, orgId: run.orgId, generation: run.pauseGeneration as number }, authority);
    if (claimed.kind === "refused") {
      const latest = await readLatestDecisionForRun(run.id);
      return latest?.status === "released" ? { ok: true, resumed: false } : { ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: latest?.status ?? null };
    }
    claim = claimed;
    try {
      const { resolveLatestWayflowGateTaskId } = await import("@cinatra-ai/a2a");
      if ((await resolveLatestWayflowGateTaskId(run.id)) !== target.gateTaskId) {
        await giveBack();
        return { ok: true, resumed: false };
      }
      // cinatra#4762: the review fence is read again under the claim, and the release is written in the SAME transaction
      // as that read, under the run row's lock (withRunRowLock): no output of the run is in flight while it runs, so an
      // output of the attempt begun after the park is either committed and seen here (and refuses the Publish) or begins
      // after the release commits, where the call-site check (publishCallAllowed) reads the fence again. A review of the
      // attempt raised or settled otherwise since the park refuses it too. The claim is given back and the decision
      // stays as it is; nothing is sent.
      // A decision with no generation (written by code older than the column) is the current attempt's, as the store reads
      // it (CURRENT_ATTEMPT): it is approved under the run's own generation, never read as attempt 0.
      const generation = run.resetGeneration ?? 0;
      const answer = await withRunRowLock(run.id, async (tx, locked) => {
        if (locked?.resetGeneration !== generation || (target.runGeneration ?? generation) !== generation ||
          !(await reviewFenceHolds({ runId: run.id, orgId: run.orgId, generation, executor: tx }))) return null;
        return open ? decide(open.id, { from: "parked", to: "released", actor: deciderId }, tx) : { outcome: "won" as const };
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
    const prepared = await prepareWayflowResume(run.id, agentUrl);
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

/**
 * The call-site check of the model bridge and the passthrough road (A6): may this call of `run` go on? `verifiedStepId`
 * is the step the runtime signed for the call, or undefined when the call carries no verified step.
 *   - A verified step with a decision row is served only while that row (its newest) reads `released` and the review
 *     fence of its attempt still holds (reviewFenceHolds, read under the run row's lock, cinatra#4762): an output of the
 *     attempt written after the release, or a review of it opened since, refuses the call until it is approved. In the
 *     same transaction the call takes the decision (claimPublishCall): until `callEnded` settles, no output or review of
 *     the run is written, so nothing the fence did not see comes before the call's effect. A claim that cannot be
 *     taken refuses the call. The caller settles `callEnded` once the call is done, whatever its outcome.
 *   - A verified step with no row is refused when the template lists it as a publishing step.
 *   - A call with no verified step is refused when the template lists any publishing step.
 *   - A template that is not found cannot prove that it publishes nothing; a list stored as null (a template compiled
 *     before the list existed) lists none, so only a decision row holds such a run.
 * A read error refuses the call; it is logged by the error's name only.
 */
export async function publishCallAllowed(run: { id: string; templateId: string }, verifiedStepId: string | undefined, callEnded: Promise<unknown>): Promise<boolean> {
  try {
    const template = await readAgentTemplateById(run.templateId);
    const listed = template?.publishingSteps ?? [];
    if (verifiedStepId === undefined) return template !== null && listed.length === 0;
    const row = await readDecisionForRunNode(run.id, verifiedStepId);
    if (row) {
      if (row.status !== "released") return false;
      // The decision read before the lock may be stale: a reset since then stamped it with the attempt it ended (a row
      // read with no generation included) and moved the run to a newer attempt, whose own approval it is not. Under the
      // lock the decision is read again; only that reading decides, and it must still be the same released row.
      const claimed = await withRunRowLock(run.id, async (tx, locked) => {
        if (!locked) return false;
        const current = await readDecisionForRunNode(run.id, verifiedStepId, tx);
        if (!current || current.id !== row.id || current.status !== "released") return false;
        if (current.runGeneration != null && current.runGeneration !== locked.resetGeneration) return false;
        if (!(await reviewFenceHolds({ runId: run.id, orgId: locked.orgId, generation: current.runGeneration ?? locked.resetGeneration, executor: tx }))) return false;
        return claimPublishCall(current.id, tx);
      });
      if (claimed) {
        const end = () => endPublishCall(row.id).catch((err: unknown) => {
          // The count stays up: the run's output stays refused until a retry's reset (fail closed).
          console.warn(`[publish-decision] the end of a publishing call could not be written: ${nameOf(err)}`);
        });
        void callEnded.then(end, end);
      }
      return claimed;
    }
    return template !== null && !listed.includes(verifiedStepId);
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
