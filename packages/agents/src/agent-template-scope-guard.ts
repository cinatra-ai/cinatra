import "server-only";

// ---------------------------------------------------------------------------
// The SHARED run-scope invariant — cinatra#2485 work item C.
//
// One enforcement helper, invoked at THREE layers, because no single layer can
// carry the guarantee alone:
//
//   1. CREATION perimeter — `createAgentRun` / `createAgentRunPendingInput`
//      (`./store`). Every run-creating path in the instance funnels through
//      these two functions, so a guard here covers the paths that never enqueue
//      at all (the host content-editor override dispatch mints a `queued`
//      carrier run and hands it straight to a blocking A2A sendTask — an
//      enqueue-only guard misses it entirely).
//   2. DISPATCH guard — `enqueueAgentRun` (the single BullMQ chokepoint) and
//      every `transitionRunStatus(... , "queued", ...)` edge. Creation-time
//      enforcement alone cannot honor a LATER-SET scope: a run created while
//      in scope, parked in `pending_input` / `armed` for a day, then dispatched
//      after the agent was re-scoped must be re-checked at dispatch.
//   3. EXECUTION worker — `runAgentBuilderExecutionJob`, immediately before any
//      side effect. This is the fire-time recheck: a recurring/scheduled run
//      armed while authorized is refused if the actor lost scope before the
//      job actually ran.
//
// ACTOR RESOLUTION — never manufactures membership:
//   • an explicit `actor` (the interactive session / MCP frame / A2A peer) is
//     used as supplied;
//   • a run that carries `runBy` resolves the ORIGINAL human LIVE
//     (`buildActorContextFromRun`) — a delegated or system-driven dispatch is
//     therefore authorized by the human it acts for, at the memberships they
//     hold RIGHT NOW, not by the dispatcher;
//   • when BOTH are present and name different humans, BOTH must pass, so an
//     in-scope requester cannot mint a run owned by an out-of-scope principal
//     (or vice versa);
//   • a genuinely autonomous run (no explicit actor, no `runBy` — e.g. a
//     recurring clone of a runBy-less source) falls back to the template's
//     PERSISTED INSTALLATION PRINCIPAL (`agent_templates.creator_id`, the human
//     who installed/created the agent at this scope) resolved LIVE against the
//     same rule. That is an explicitly-authorized, revocable principal tied to
//     the template's own scope — NOT a generic system bypass. No principal at
//     all ⇒ refuse.
//
// Reads go through this module's own drizzle queries (never `./store`) so the
// guard can be called from `./store` and `./run-transition` without an import
// cycle.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import type { ActorContext } from "@/lib/authz/actor-context";
import { db } from "./db";
import { agentRuns, agentTemplates } from "./schema";
import {
  AgentTemplateScopeError,
  assertActorWithinAgentTemplateScope,
  normalizeAgentTemplateScopeLevel,
  type AgentTemplateScopeRef,
} from "./agent-template-scope";

export {
  AgentTemplateScopeError,
  assertActorWithinAgentTemplateScope,
} from "./agent-template-scope";
export type {
  AgentTemplateScopeRef,
  AgentTemplateScopeDecision,
  AgentTemplateScopeLevel,
  AgentTemplateScopeDenyReason,
} from "./agent-template-scope";

/** Which enforcement layer is asking. Surfaces in the refusal message + audit. */
export type AgentRunScopeStage = "create" | "dispatch" | "execute";

/**
 * The template scope ref PLUS the persisted installation principal used as the
 * autonomous-run fallback.
 */
type TemplateScopeRow = AgentTemplateScopeRef & { creatorId: string | null };

async function readTemplateScopeRow(
  templateId: string,
): Promise<TemplateScopeRow | null> {
  const [row] = await db
    .select({
      id: agentTemplates.id,
      orgId: agentTemplates.orgId,
      ownerLevel: agentTemplates.ownerLevel,
      ownerId: agentTemplates.ownerId,
      creatorId: agentTemplates.creatorId,
    })
    .from(agentTemplates)
    .where(eq(agentTemplates.id, templateId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    orgId: row.orgId ?? null,
    ownerLevel: row.ownerLevel ?? null,
    ownerId: row.ownerId ?? null,
    creatorId: row.creatorId ?? null,
  };
}

/** Narrow run projection the dispatch / execute layers assert against. */
export type RunScopeRef = {
  id: string;
  templateId: string;
  orgId: string;
  runBy: string | null;
};

export async function readRunScopeRef(
  runId: string,
): Promise<RunScopeRef | null> {
  const [row] = await db
    .select({
      id: agentRuns.id,
      templateId: agentRuns.templateId,
      orgId: agentRuns.orgId,
      runBy: agentRuns.runBy,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    templateId: row.templateId,
    orgId: row.orgId,
    runBy: row.runBy ?? null,
  };
}

/**
 * Resolve a LIVE `ActorContext` for a human principal, or `null` when that
 * human is NOT a live member of the run's organization.
 *
 * The membership probe is deliberately SEPARATE from
 * `buildActorContextFromRun`. That resolver anchors the context on `run.orgId`
 * unconditionally and floors `orgRole` at `"member"`, so a user REMOVED from
 * the org still comes back stamped with `organizationId: run.orgId` and
 * `orgRole: "member"` — which the organization branch of the scope rule would
 * read as membership. Probing `resolveOrgRoleForUser` first (the same
 * membership test `verifySessionAuthority` uses) is what makes revocation
 * actually take effect at dispatch and at fire time.
 *
 * A THROWN membership read propagates (it is a transient infra fault, not a
 * decision): the worker retries the job, an interactive caller sees an error.
 * Only a determinate `undefined` — "no membership row" — returns `null`.
 *
 * Both host modules are imported dynamically so `./store` (which this guard is
 * called from) does not pull the better-auth host graph into its static module
 * graph.
 */
async function resolveLiveHumanActor(input: {
  runId: string;
  userId: string;
  orgId: string;
}): Promise<ActorContext | null> {
  const { resolveOrgRoleForUser } = await import("@/lib/auth-session");
  const role = await resolveOrgRoleForUser(input.orgId, input.userId);
  if (role === undefined) return null;
  const { buildActorContextFromRun } = await import(
    "@/lib/authz/build-actor-context-from-run"
  );
  return buildActorContextFromRun({
    id: input.runId,
    runBy: input.userId,
    orgId: input.orgId,
  });
}

export type AssertAgentRunScopeInput = {
  stage: AgentRunScopeStage;
  templateId: string;
  orgId: string;
  /** The run this check is about. Used only for diagnostics + actor resolution. */
  runId?: string;
  /** The persisted run owner (`agent_runs.run_by`). */
  runBy?: string | null;
  /** The requesting actor, when the caller holds one (session / MCP / A2A). */
  actor?: ActorContext | null;
  /**
   * The human DRIVING this particular dispatch, when they are not the run's
   * owner — the admin releasing someone else's armed trigger, the reviewer
   * clearing a HITL gate. Server actions hold a session user id but no resolved
   * `ActorContext`, so they pass the id and the guard resolves it LIVE.
   *
   * Without this, a dispatch initiated by A on B's run would be authorized
   * entirely against B: an org admin outside the agent's team/project scope
   * could start work the scope does not permit them to start.
   */
  actingUserId?: string | null;
};

/**
 * THE shared run-authorization assertion. Throws {@link AgentTemplateScopeError}
 * when the run may not proceed.
 *
 * Fail-closed everywhere: an unreadable/absent template, an unresolvable
 * principal, and an unrecognized scope all refuse.
 */
export async function assertAgentRunScopeAuthorized(
  input: AssertAgentRunScopeInput,
): Promise<void> {
  const template = await readTemplateScopeRow(input.templateId);
  if (!template) {
    // No template row ⇒ no scope to be inside of. Refuse rather than let the
    // downstream insert decide.
    throw new AgentTemplateScopeError({
      templateId: input.templateId,
      reason: "unknown_scope",
      level: null,
      stage: input.stage,
    });
  }

  const runIdForResolve = input.runId ?? `scope-check:${input.templateId}`;
  const explicitActor = input.actor ?? null;

  // ---- Build the candidate principal set (EVERY candidate must pass) -------
  const candidates: Array<{ label: string; actor: ActorContext }> = [];
  const resolvedUsers = new Set<string>();

  // Every HUMAN principal is RE-RESOLVED LIVE from its user id — the caller's
  // supplied axes are never trusted. Two reasons, both load-bearing:
  //   • completeness: some transports carry a thin actor (the MCP/chat frame
  //     forwards org/platform roles but not teamIds/projectGrants), and reading
  //     an unresolved axis as "holds nothing" would FALSE-DENY a legitimate
  //     member of the owning team/project;
  //   • integrity: an actor is a plain JSON object flowing through ALS frames
  //     and job payloads, so its membership claims are re-derived from the
  //     database rather than believed.
  const pushHuman = async (label: string, userId: string): Promise<void> => {
    if (resolvedUsers.has(userId)) return; // same human, one resolve, one check
    resolvedUsers.add(userId);
    const live = await resolveLiveHumanActor({
      runId: runIdForResolve,
      userId,
      orgId: input.orgId,
    });
    if (!live) {
      // Determinate non-member of the run's org — the strongest refusal there
      // is, and the one that makes membership revocation effective.
      throw new AgentTemplateScopeError({
        templateId: template.id,
        reason: "cross_org",
        level: null,
        stage: `${input.stage}/${label}`,
      });
    }
    candidates.push({ label, actor: live });
  };

  if (explicitActor) {
    if (explicitActor.principalType === "HumanUser") {
      await pushHuman("requesting-actor", explicitActor.principalId);
    } else {
      // A non-human principal (external A2A peer, service account, worker) has
      // no membership rows to re-resolve; its org/scope facts come from the
      // transport that authenticated it, and the four-level rule evaluates
      // those as supplied.
      candidates.push({ label: "requesting-actor", actor: explicitActor });
    }
  }
  if (input.actingUserId) {
    await pushHuman("dispatching-actor", input.actingUserId);
  }
  if (input.runBy) {
    await pushHuman("run-owner", input.runBy);
  }

  if (candidates.length === 0) {
    // ---- Autonomous run: no requester, no persisted owner --------------
    //
    // (a) ORG-ANCHORED. For an ORGANIZATION-scoped agent, "in scope" means
    // "belongs to the owning org", and the run's OWN `org_id` is exactly that
    // evidence — the run is the org's work. Admitting it needs no principal
    // and is not a system bypass: it cannot admit anything at team, project or
    // personal scope (where an org anchor proves nothing), and it cannot admit
    // a run from another org. Without this, an ownerless system run — a
    // lifecycle repair whose producing run had no human, a recurring clone of
    // a runBy-less source — could never dispatch an org-wide agent.
    const level = normalizeAgentTemplateScopeLevel(template.ownerLevel);
    const owningOrgId = template.orgId ?? template.ownerId;
    if (level === "organization" && owningOrgId && owningOrgId === input.orgId) {
      return;
    }
    // (b) Narrower scope ⇒ the run must be authorized by the PERSISTED
    // installation principal (the human who installed the agent at this
    // scope), resolved LIVE so a revoked installer stops authorizing it.
    // Absent ⇒ refuse. There is no generic system bypass.
    if (!template.creatorId) {
      throw new AgentTemplateScopeError({
        templateId: template.id,
        reason: "no_actor",
        level,
        stage: input.stage,
      });
    }
    await pushHuman("installation-principal", template.creatorId);
  }

  for (const candidate of candidates) {
    assertActorWithinAgentTemplateScope(template, candidate.actor, {
      stage: `${input.stage}/${candidate.label}`,
    });
  }
}

/**
 * The shared DISPATCH guard (layer 2) and the worker's fire-time recheck
 * (layer 3). Loads the run row itself so a caller that only holds a run id —
 * `enqueueAgentRun`, `transitionRunStatus` — can assert without threading a
 * template through.
 *
 * A run row that has vanished is NOT an authorization failure (a concurrent
 * delete / a not-yet-committed idempotent insert); the caller's own
 * missing-run handling stays in charge, so this returns quietly.
 */
export async function assertAgentRunDispatchAuthorized(input: {
  runId: string;
  stage: AgentRunScopeStage;
  actor?: ActorContext | null;
  /** See {@link AssertAgentRunScopeInput.actingUserId} — the human driving THIS
   *  dispatch when they are not the run's owner. */
  actingUserId?: string | null;
}): Promise<void> {
  const run = await readRunScopeRef(input.runId);
  if (!run) return;
  await assertAgentRunScopeAuthorized({
    stage: input.stage,
    templateId: run.templateId,
    orgId: run.orgId,
    runId: run.id,
    runBy: run.runBy,
    actor: input.actor ?? null,
    actingUserId: input.actingUserId ?? null,
  });
}
