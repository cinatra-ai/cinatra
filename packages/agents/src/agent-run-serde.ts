// ---------------------------------------------------------------------------
// Agent-run (de)serialization + OBO scope-ceiling persistence helpers.
//
// Co-located slice extracted VERBATIM from store.ts (no behavior change) to keep
// store.ts under the file-size ratchet ceiling (a thin-facade vertical slice).
// Holds three helpers store.ts re-imports:
//   - parseAuthPolicySafe: defensive AgentAuthPolicy JSON parser (shared by the
//     run + template deserializers).
//   - deserializeRun: agent_runs row -> AgentRunRecord mapper.
//   - deriveRunOboCeilingJson: persist-at-dispatch OBO scope-ceiling derivation.
// The only edge back to store.ts is the TYPE-ONLY `AgentRunRecord` import
// (fully erased at runtime — no runtime import cycle; store.ts imports the three
// values one-directionally).
// ---------------------------------------------------------------------------
import { eq } from "drizzle-orm";
import {
  deriveOboCeilingChain,
  parseOboCeilingChain,
  composeOboCeilingChain,
  OboCeilingCompositionError,
  type OboCeiling,
  type OboCeilingChain,
  type OboOwnerContainment,
} from "@cinatra-ai/mcp-server/obo-ceiling";
import { readOwnerContainmentResolver } from "./owner-containment-port";
import { db } from "./db";
import { agentTemplates, agentRuns } from "./schema";
import { AgentAuthPolicySchema } from "./auth-policy";
// cinatra#2485 C — the pure install-scope evaluator lives with the rest of
// the agent auth policy; the async guard below resolves its inputs.
import {
  AgentTemplateScopeError,
  assertActorWithinAgentTemplateScope,
  hasCorruptOrgAnchor,
  normalizeAgentTemplateScopeLevel,
  type AgentTemplateScopeRef,
} from "./auth-policy";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { AgentAuthPolicy } from "./auth-policy";
import type { AgentRunRecord } from "./store";

// ---------------------------------------------------------------------------
// Defensive AgentAuthPolicy JSON parser.
//
// JSON.parse on an unguarded raw column can throw on malformed input
// (direct SQL writes, partial migrations, dev tools), and a static `as
// AgentAuthPolicy` cast lies about the runtime shape — `JSON.parse("null")`
// returns null, and `{"runListVisibility":"EVIL"}` typechecks but is
// semantically broken. Wrap parse + zod validation with try/catch so a
// bad row degrades gracefully to null (which downstream code treats as
// "no override; inherit from template / use DEFAULT_AGENT_AUTH_POLICY").
//
// This intentionally does NOT touch the existing compiledPlan /
// approvalPolicy / gatedSteps parses — those predate this parser and are
// out of scope unless parser symmetry is needed.
// ---------------------------------------------------------------------------
export function parseAuthPolicySafe(raw: string | null): AgentAuthPolicy | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = AgentAuthPolicySchema.safeParse(parsed);
    if (!result.success) {
      // eslint-disable-next-line no-console
      console.warn(
        "[agent-builder/store] AgentAuthPolicy row failed zod validation; treating as null override",
        { issues: result.error.issues },
      );
      return null;
    }
    return result.data;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[agent-builder/store] AgentAuthPolicy row failed JSON.parse; treating as null override",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }
}

export function deserializeRun(row: typeof agentRuns.$inferSelect): AgentRunRecord {
  return {
    id: row.id,
    templateId: row.templateId,
    versionId: row.versionId,
    runBy: row.runBy,
    status: row.status,
    inputParams: JSON.parse(row.inputParams) as Record<string, unknown>,
    stepResults: row.stepResults ? (JSON.parse(row.stepResults) as unknown[]) : null,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    error: row.error,
    title: row.title,
    createdAt: row.createdAt,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    packageVersion: row.packageVersion ?? null,
    a2aTaskId: row.a2aTaskId ?? null,
    a2aContextId: row.a2aContextId ?? null,
    parentRunId: row.parentRunId ?? null,
    agUiEnabled: row.agUiEnabled ?? null,
    lgThreadId: row.lgThreadId ?? null,
    traceId: row.traceId ?? null,
    timeoutSeconds: row.timeoutSeconds ?? null,
    streamedText: row.streamedText ?? null,
    // per-run override; null when not set.
    // Defensive parse — see parseAuthPolicySafe definition above.
    authPolicy: parseAuthPolicySafe(row.authPolicy ?? null),
    // orgId from agent_runs.org_id; column is NOT NULL after the
    // DDL migration.
    orgId: row.orgId,
    // nullable project refinement (
    // DDL). Drizzle returns the typed column directly.
    projectId: row.projectId ?? null,
    // idempotent child-run dispatch key.
    idempotencyKey: row.idempotencyKey ?? null,
    // persisted OBO scope-ceiling chain (JSON-as-text). Defensive parse — a
    // malformed / empty stored value becomes null (fails closed at mint).
    oboCeiling: parseOboCeilingChain(row.oboCeiling ?? null),
    // dependent_install_id surfaced onto the record so buildActorContextFromRun
    // carries it onto the ActorContext for edge-bound serving (cinatra#1392 Gap 2).
    dependentInstallId: row.dependentInstallId ?? null,
    // current attempt id for the OBO token's `att` claim (cinatra#1939 S3).
    executionAttemptId: row.executionAttemptId ?? null,
    // run-start presence discriminator (cinatra#2067). Drizzle returns the typed
    // boolean column directly; null on pre-backfill / headless rows.
    humanPresent: row.humanPresent ?? null,
  };
}

// ---------------------------------------------------------------------------
// Persist-at-dispatch: derive the agent-run OBO scope-ceiling chain from the
// run's LOCKED template owner anchor + org + (optional) project launch, and
// return it JSON-serialized for the agent_runs.obo_ceiling column. Called by
// EVERY run-creation path (createAgentRun / createAgentRunPendingInput) so all
// origins — interactive, A2A, widget, workflow-child, recurring-trigger clone —
// record the exact chain the mint path re-derives and compares against.
//
// Returns null ONLY for a corrupt partial anchor (a known non-org owner tier
// with a missing id); the run then fails closed at mint. A null / null (pre-
// backfill) anchor derives the organization floor — NOT the fail-closed case.
//
// Child-run composition (epic W5 / #1884 C4): when the caller supplies
// `parentOboCeiling` (a genuine child dispatch — the parent RUN's persisted
// chain, read from the dispatching run's actor frame), the child's OWN anchor is
// STILL freshly derived here — never copied — and the parent chain is folded in
// on top via the shared `composeOboCeilingChain` primitive (satisfy-all → never
// wider than the parent; transitive across grandchildren). A non-satisfiable
// composition — a same-axis id conflict, cross-org, OR a mixed owner-tier chain
// with no verified containment relation — THROWS `OboCeilingCompositionError` so
// the dispatch fails closed and no child run is inserted (a STRUCTURED error, not
// a silently-unsatisfiable persisted chain).
//
// `ownerContainments` carries the VERIFIED owner-axis containment facts (a
// narrower `user` is a member of the wider `team`, etc.) that let a legitimate
// mixed-owner-tier child collapse to its satisfiable narrowest tier. The
// anchor-derivation seam (#1884 C1) resolves live membership and supplies them;
// until then the dispatch seams pass none, so mixed-owner-tier child dispatches
// fail closed (safe). Top-level and recurring-clone paths pass no parent chain
// and derive the un-composed child anchor — the copy-trap-safe behavior (the
// clone re-derives, never carries a stale chain).
// ---------------------------------------------------------------------------
export async function deriveRunOboCeilingJson(input: {
  templateId: string;
  orgId: string;
  projectId: string | null | undefined;
  parentOboCeiling?: OboCeilingChain | null;
  /** Verified owner-axis containment facts (#1884 C1 wiring; default none). */
  ownerContainments?: OboOwnerContainment[];
}): Promise<string | null> {
  const [tmpl] = await db
    .select({
      ownerLevel: agentTemplates.ownerLevel,
      ownerId: agentTemplates.ownerId,
    })
    .from(agentTemplates)
    .where(eq(agentTemplates.id, input.templateId))
    .limit(1);
  const childChain = deriveOboCeilingChain({
    ownerLevel: tmpl?.ownerLevel ?? null,
    ownerId: tmpl?.ownerId ?? null,
    orgId: input.orgId,
    projectId: input.projectId ?? null,
  });
  // Corrupt partial anchor → persist SQL NULL, fail closed at mint (W1 contract).
  // Unchanged even under a child dispatch: nothing to compose onto.
  if (!childChain) return null;
  // Genuine child dispatch → fold the parent chain in on top of the freshly
  // derived child anchor (never copy the parent as the child's own anchor).
  if (input.parentOboCeiling && input.parentOboCeiling.length > 0) {
    // Owner-axis containment facts (#1885 C1; C4 handoff). When the composed
    // chain carries ≥2 DISTINCT owner tiers, resolve LIVE membership so a
    // legitimate mixed-owner-tier child collapses to its verified-narrowest
    // tier; otherwise C4 fails the composition closed. Explicit facts (test
    // seams / future direct callers) win; else the globalThis-published resolver
    // is consulted. No resolver / no facts → C4's structured fail-closed denial.
    const ownerContainments = await resolveOwnerContainmentsForCompose({
      orgId: input.orgId,
      childChain,
      parentChain: input.parentOboCeiling,
      explicit: input.ownerContainments,
    });
    const composed = composeOboCeilingChain(
      input.parentOboCeiling,
      childChain,
      ownerContainments,
    );
    if (!composed.ok) throw new OboCeilingCompositionError(composed);
    return JSON.stringify(composed.chain);
  }
  return JSON.stringify(childChain);
}

const OWNER_AXIS_TIERS: ReadonlySet<OboCeiling["tier"]> = new Set([
  "user",
  "team",
  "workspace",
]);

/**
 * Gather the DISTINCT owner-axis elements the composed chain will carry (child
 * anchor ∪ parent chain) and, only when there are ≥2 distinct owner TIERS,
 * resolve the verified containment facts among them via the published resolver.
 * Returns explicit facts verbatim when supplied. Zero/one owner tier → no facts
 * needed (the composer passes them through untouched, byte-stable).
 */
async function resolveOwnerContainmentsForCompose(input: {
  orgId: string;
  childChain: OboCeilingChain;
  parentChain: OboCeilingChain;
  explicit?: OboOwnerContainment[];
}): Promise<OboOwnerContainment[]> {
  if (input.explicit) return input.explicit;
  const ownerEls: OboCeiling[] = [];
  for (const c of [...input.childChain, ...input.parentChain]) {
    if (!OWNER_AXIS_TIERS.has(c.tier)) continue;
    if (!ownerEls.some((e) => e.tier === c.tier && e.id === c.id)) ownerEls.push(c);
  }
  const distinctTiers = new Set(ownerEls.map((e) => e.tier));
  if (distinctTiers.size < 2) return [];
  const resolver = readOwnerContainmentResolver();
  if (!resolver) return []; // fail closed — C4 denies the mixed composition
  return resolver({ orgId: input.orgId, ownerElements: ownerEls });
}

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
    // The evaluator's OWN corrupt-org-anchor rule (`hasCorruptOrgAnchor`),
    // applied here too. `??` never consults `owner_id` once `org_id` is set, so
    // without this a row whose two org anchors DISAGREE would be fail-closed for
    // every principal-bearing run (the evaluator denies it `unknown_scope`) and
    // fail-OPEN for an ownerless one — the strictly worse direction, since an
    // autonomous run has no human to notice the refusal.
    if (
      level === "organization" &&
      owningOrgId &&
      owningOrgId === input.orgId &&
      !hasCorruptOrgAnchor(template)
    ) {
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
