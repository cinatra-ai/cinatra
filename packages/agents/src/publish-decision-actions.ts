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
  decide,
  insertParkedDecision,
  listDueParked,
  listSettledWithWaitingRun,
  readDecisionForRunNode,
  readLatestDecisionForRun,
  readOpenDecisionForRun,
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

/** The id prefix of the gate the flow runtime inserts in front of a publishing step. The
 *  compiler reserves the same prefix (oas-compiler.ts, PUBLISH_GATE_ID_PREFIX). */
export const PUBLISH_GATE_NODE_PREFIX = "cinatra_publish_gate__";
export const PUBLISH_DECISION_REQUIRED = "publish_decision_required";
export const PUBLISH_DECISION_NOT_OPEN = "publish_decision_not_open";
export const PUBLISH_GATE_UNVERIFIED = "publish_gate_unverified";
export const PUBLISH_DECISION_UNAVAILABLE = "publish_decision_unavailable";
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

/** Refuses a resume when the run's newest decision exists and is not `released`. A read error propagates. Answers
 *  whether the run has a (released) decision: such a run met a publish gate, so it can meet one again. */
export async function assertNoOpenPublishDecision(runId: string): Promise<boolean> {
  const latest = await readLatestDecisionForRun(runId);
  if (latest && latest.status !== "released") throw new PublishDecisionRequiredError();
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

/** Moves the run `from` -> `to`; false when a stale answer shows the run already left `from`. */
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

/**
 * The publish classification of the input-required branch, run before anything else there.
 * False: not a publish gate, the caller goes on as before. True: handled, the caller returns.
 *   - a verified `cinatra_publish_gate__<node>` claim (the prefix wins over the template's
 *     list): the row is written FIRST (a failure ends the run failed), then the run moves to
 *     pending_approval; a lost move closes the row run_ended;
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
    await moveRun(run.id, fromStatus, "failed", { error: `${PUBLISH_GATE_UNVERIFIED}: the pause carries no verified step claim`, completedAt: new Date() }, authority);
    return true;
  }
  if (!verified.startsWith(PUBLISH_GATE_NODE_PREFIX)) return false;

  let park: Awaited<ReturnType<typeof insertParkedDecision>>;
  try {
    park = await insertParkedDecision({
      orgId: run.orgId,
      runId: run.id,
      nodeId: verified.slice(PUBLISH_GATE_NODE_PREFIX.length),
      gateTaskId: task.id,
      a2aContextId: contextId ?? null,
      surfacedValues: surfacedValuesOf(task),
    });
  } catch {
    await moveRun(run.id, fromStatus, "failed", { error: "publish_decision_unrecorded: the publish decision could not be recorded", completedAt: new Date() }, authority);
    return true;
  }
  // A stop this gate task already answered is closed; the newest-decision rule keeps it closed.
  if (park.decision.status !== "parked" || fromStatus === "pending_approval") return true;
  if (!(await moveRun(run.id, fromStatus, "pending_approval", undefined, authority))) {
    await decide(park.decision.id, { from: "parked", to: "run_ended", actor: null });
  }
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
 * the decision's own gate task; then ONE decision write (parked -> released, with that person), the steps that can fail
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
      const answer = (await resolveLatestWayflowGateTaskId(run.id)) !== target.gateTaskId ? null
        : open ? await decide(open.id, { from: "parked", to: "released", actor: deciderId }) : { outcome: "won" as const };
      if (answer?.outcome !== "won") {
        await giveBack();
        return answer ? { ok: false, code: PUBLISH_DECISION_NOT_OPEN, currentStatus: answer.currentStatus } : { ok: true, resumed: false };
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
 *   - A verified step with a decision row is served only while that row (its newest) reads `released`.
 *   - A verified step with no row is refused when the template lists it as a publishing step.
 *   - A call with no verified step is refused when the template lists any publishing step.
 *   - A template that is not found cannot prove that it publishes nothing; a list stored as null (a template compiled
 *     before the list existed) lists none, so only a decision row holds such a run.
 * A read error refuses the call; it is logged by the error's name only.
 */
export async function publishCallAllowed(run: { id: string; templateId: string }, verifiedStepId: string | undefined): Promise<boolean> {
  try {
    const template = await readAgentTemplateById(run.templateId);
    const listed = template?.publishingSteps ?? [];
    if (verifiedStepId === undefined) return template !== null && listed.length === 0;
    const row = await readDecisionForRunNode(run.id, verifiedStepId);
    if (row) return row.status === "released";
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
