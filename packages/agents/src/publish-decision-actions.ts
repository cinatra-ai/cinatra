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
  readLatestDecisionForRun,
  readOpenDecisionForRun,
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

/** The id prefix of the gate the flow runtime inserts in front of a publishing step. The
 *  compiler reserves the same prefix (oas-compiler.ts, PUBLISH_GATE_ID_PREFIX). */
export const PUBLISH_GATE_NODE_PREFIX = "cinatra_publish_gate__";
export const PUBLISH_DECISION_REQUIRED = "publish_decision_required";
export const PUBLISH_DECISION_NOT_OPEN = "publish_decision_not_open";
export const PUBLISH_GATE_UNVERIFIED = "publish_gate_unverified";
export const PUBLISH_DECISION_UNAVAILABLE = "publish_decision_unavailable";
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
const nameOf = (err: unknown): string => (err instanceof Error ? err.name : "error");

/** Refuses a resume when the run's newest decision exists and is not `released`. A read error propagates. */
export async function assertNoOpenPublishDecision(runId: string): Promise<void> {
  const latest = await readLatestDecisionForRun(runId);
  if (latest && latest.status !== "released") throw new PublishDecisionRequiredError();
}

/** agent_run_resume's answer to a refused or unreadable hold. Neither text carries an id, a value or the store's error. */
export function publishHoldAnswer(err: unknown): { error: string; code?: string } {
  if (isPublishDecisionRequired(err)) return { error: (err as Error).message, code: PUBLISH_DECISION_REQUIRED };
  console.warn(`[publish-decision] a resume could not check the publish hold: ${nameOf(err)}`);
  return { error: "Resume failed: the publish hold could not be checked." };
}

/**
 * A5 for the two roads that resume from pending_approval and keep the run there while they send (agent_run_resume and
 * the artifact-review delivery). On a template that lists publishing steps the road claims the run (pending_approval ->
 * running) right before it sends, then reads the hold again: a decision parked by another resume after the road's first
 * read refuses the send. A refusal or a read error puts the run back and propagates. Answers the status the road hands to
 * handleWayflowTaskState, or null when another road holds the run. A send that fails after the claim leaves the run
 * running, as the generic approve does (cinatra#3423): the runtime may have taken the message.
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
/** The store's own refusals name no id or value; any other fault becomes one fixed text (no id, note or query value). */
const STORE_CODES = new Set(["invalid-input", "invalid-transition", "malformed-row", "not-found", "conflict"]);
const opaque = (err: unknown): unknown => STORE_CODES.has((err as { code?: unknown } | null)?.code as string) ? err
  : Object.assign(new Error("The publish decision could not be read or written."), { code: PUBLISH_DECISION_UNAVAILABLE });

/**
 * The publish classification of the input-required branch, run before anything else there.
 * False: not a publish gate, the caller goes on as before. True: handled, the caller returns.
 *   - a verified `cinatra_publish_gate__<node>` claim (the prefix wins over the template's
 *     list): the row is written FIRST (a failure ends the run failed), then the run moves to
 *     pending_approval; a lost move closes the row run_ended;
 *   - a missing or unverified claim on a template that lists publishing steps or is not found, or an unverified
 *     publish-gate claim on a template that cannot be read: the run ends failed, publish_gate_unverified.
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
    let publishes: boolean;
    try { // a template that is not found cannot prove that it publishes nothing
      const template = await readAgentTemplateById(run.templateId);
      publishes = !template || (template.publishingSteps?.length ?? 0) > 0;
    } catch { // unreadable: only a pause that claims a publish gate fails; any other keeps today's road, as on main
      publishes = typeof claim?.node === "string" && claim.node.startsWith(PUBLISH_GATE_NODE_PREFIX);
    }
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

/**
 * "Do not publish" (its surface is the decision card, a later part). The decider is ONE principal: the person of
 * `actorContext` (a human actor with a user id and no delegated agent ceiling; a model, a peer, the system or an agent
 * acting for a person is refused). Authority: run.execute and run.approveHitl on the run, then membership of the run's
 * org, each for that person. Then ONE decision write (parked -> declined, with that person and the optional note), then
 * the run moves pending_approval -> stopped. It never sends anything to the run's context. A late answer is reported as
 * publish_decision_not_open with the decision's current status. A fault after the authority check surfaces as
 * publish_decision_unavailable with a fixed text.
 */
export async function declinePublishDecision(input: {
  runId: string;
  actorContext: PrimitiveActorContext;
  roleHints?: ActorRoleHints;
  note?: string | null;
}): Promise<PublishDecisionAnswer> {
  const actor = input.actorContext;
  if (actor?.actorType !== "human" || typeof actor.userId !== "string" || actor.userId.length === 0 || actor.oboCeiling) {
    throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Only a person can decide a publish." });
  }
  const deciderId = actor.userId;
  const run = await readAgentRunById(input.runId);
  const { enforceRunAccess, resolveEffectivePolicy } = await import("./auth-policy");
  const template = run ? await readAgentTemplateById(run.templateId) : null;
  const coOwners = run ? await readRunCoOwners(run.id) : [];
  const runForCheck = run
    ? { id: run.id, runBy: run.runBy, orgId: run.orgId, effectivePolicy: resolveEffectivePolicy(run, template),
      coOwnerUserIds: coOwners.map((r) => r.userId) }
    : null;
  await enforceRunAccess(runForCheck, actor, "execute", input.roleHints);
  await enforceRunAccess(runForCheck, actor, "approveHitl", input.roleHints);
  if (!run) throw new AuthzError({ statusCode: 404, reason: "hidden" });
  const { resolveOrgRoleForUser } = await import("@/lib/auth-session");
  const role = await resolveOrgRoleForUser(run.orgId, deciderId);
  if (role === undefined) {
    throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Deciding a publish needs membership of the run's organization." });
  }
  const authority = sessionAuthorityFromResolvedRole(run.orgId, role);

  try {
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

export interface PublishExpirySweepSummary {
  due: number;
  expired: number;
  runEnded: number;
  lost: number;
  failed: number;
  stopped: number; // runs a decline or an expiry decided but did not stop, stopped by this pass
}

/**
 * The 24-hour expiry. A due open decision closes with no person: `expired` when its run is held (pending_approval, or
 * running when a hold wrote its row but not its move), and the run then moves from that status to stopped; else
 * `run_ended`. Then it reads, page by page to the end, every held run whose newest decision is declined or expired (a fault
 * or a crash between the decision write and the run move) and moves it to stopped; a run whose stop faults is counted
 * failed and tried again next pass. No row resumes a run; no feature fence is read. `authorityFor` is the caller's
 * dispatch authority for the run's org; `now` is the clock the tests inject.
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
  for (const row of await listDueParked(limit, opts.now)) {
    summary.due += 1;
    try {
      const run = await readAgentRunById(row.runId);
      const held = heldStatusOf(run?.status);
      const answer = await decide(row.id, { from: "parked", to: held ? "expired" : "run_ended", actor: null });
      if (answer.outcome === "lost") summary.lost += 1;
      else if (!held || !run) summary.runEnded += 1;
      else {
        await stopHeldRun(run.id, held, opts.authorityFor(run.orgId)); // a stale answer: the run left meanwhile
        summary.expired += 1;
      }
    } catch (err) {
      fault(err);
    }
  }
  // The store lists only the newest decision of each run, so an old row never takes a place on a page.
  let after: string | undefined = undefined;
  for (;;) {
    const page = await listSettledWithWaitingRun(limit, after);
    for (const row of page) {
      try {
        const run = await readAgentRunById(row.runId);
        const held = heldStatusOf(run?.status);
        if (!run || !held) continue; // the run moved meanwhile
        if (await stopHeldRun(run.id, held, opts.authorityFor(run.orgId))) summary.stopped += 1;
      } catch (err) {
        fault(err);
      }
    }
    if (page.length < limit) break;
    after = page[page.length - 1]!.id;
  }
  return summary;
}
