import "server-only";

// ---------------------------------------------------------------------------
// THE PER-SCOPE ASSIGNMENT WRITES (cinatra#2814, per-scope assignment S2).
//
// Every write the assignment page offers lands here, and every one of them
// starts from nothing the browser decided:
//
//   1. the target is RE-RESOLVED (`resolveScopeAssignmentTarget`): the
//      package from the scope tab's own rows, the scope from the route, the
//      reader's authority re-read in the scope's own organization;
//   2. the scope the write is for must be one the page itself shows;
//   3. S1's assignment-target admission must admit the package;
//   4. S1's exact-scope resolver must allow the write. A refusal is returned
//      as S1's own typed reason, and no store is touched. A platform admin
//      with no scope role writes ONLY through `withPlatformAdminBypass`, and
//      the audit row is written BEFORE the store mutation (an audit failure
//      aborts the write);
//   5. the store's own validation runs last (the skills cap and assignability
//      under the owning extension's lifecycle lock; the context store's slot,
//      visibility and kind checks), and its typed refusals are surfaced
//      unchanged.
//
// So a forged mutation, one that never rendered the page or rendered it for a
// different person, reaches the S1 resolver and is refused by it.
// ---------------------------------------------------------------------------

import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";

import type { ActorContext } from "@/lib/authz/actor-context";
import type { ResourceRef } from "@/lib/authz/resource-ref";
import type { AssignmentScope } from "@/lib/assignment-scope";
import type {
  AgentAssignedContextValidators,
  InsertAssignedContextResult,
  ReorderAssignedContextResult,
} from "@/lib/agent-assigned-context-store";
import type { InsertAssignedSkillResult } from "@/lib/agent-assigned-skills-store";
import type { SkillAssignability } from "@cinatra-ai/skills/agent-skill-assignability";
import {
  type ScopeAssignmentActionRefusal,
  type ScopeAssignmentActionResult,
  type ScopeAssignmentActionTarget,
  type ScopeAssignmentArtifactCandidate,
  type ScopeAssignmentSearchResult,
  type ScopeAssignmentSkillCandidate,
} from "./scope-assignment-model";
import {
  defaultScopeAssignmentReadDeps,
  inspectArtifactForSlot,
  acceptedExtensionsForSlot,
  searchScopeArtifactCandidates,
  searchScopeSkillCandidates,
  type ScopeArtifactVantage,
  type ScopeAssignmentReadDeps,
} from "./scope-assignment-reads.server";
import {
  defaultScopeAssignmentTargetDeps,
  resolveScopeAssignmentTarget,
  selectScopeAssignmentSection,
  type ResolvedScopeAssignmentTarget,
  type ScopeAssignmentSection,
  type ScopeAssignmentTargetDeps,
} from "./scope-assignment-target.server";
import {
  readTrustedContextSlots,
  type TrustedContextSlots,
} from "./context-slot-manifest.server";

export type ScopeAssignmentWriteDeps = {
  target: ScopeAssignmentTargetDeps;
  reads: ScopeAssignmentReadDeps;
  bypass: (
    actor: ActorContext,
    operation: string,
    resource: ResourceRef & { ownerId: string },
    reason: "workspace_configuration" | "scope_configuration",
    extraMetadata?: Record<string, unknown>,
  ) => Promise<{ auditEventId: string }>;
  resolveAssignability: (skillIds: string[]) => Promise<Map<string, SkillAssignability>>;
  withInstallLock: <T>(packageName: string, fn: () => Promise<T>) => Promise<T>;
  insertSkill: (input: {
    agentPackageName: string;
    skillId: string;
    createdBy: string;
    scope: AssignmentScope;
  }) => Promise<InsertAssignedSkillResult>;
  deleteSkill: (input: {
    agentPackageName: string;
    skillId: string;
    scope: AssignmentScope;
  }) => Promise<{ deleted: boolean }>;
  readSlots: (packageName: string) => Promise<TrustedContextSlots>;
  insertContext: (
    input: {
      agentPackageName: string;
      slotId: string;
      artifactId: string;
      scope: AssignmentScope;
      createdBy: string;
    },
    validators: AgentAssignedContextValidators,
  ) => Promise<InsertAssignedContextResult>;
  deleteContext: (input: {
    agentPackageName: string;
    slotId: string;
    artifactId: string;
    scope: AssignmentScope;
  }) => Promise<{ deleted: boolean }>;
  reorderContext: (input: {
    agentPackageName: string;
    slotId: string;
    scope: AssignmentScope;
    orderedArtifactIds: readonly string[];
  }) => Promise<ReorderAssignedContextResult>;
};

/** The audit tuple a platform admin's bypassed write records. */
export const SCOPE_ASSIGNMENT_AUDIT_OPERATION = {
  skills: "agent.assignments.manage",
  context: "context.assign",
} as const;

type Authorized = {
  target: ResolvedScopeAssignmentTarget;
  section: ScopeAssignmentSection;
  /** Writes the audit row for a bypassed write; a no-op on the grant road.
   *  Called immediately before the store mutation. */
  beforeMutation: (change: Record<string, unknown>) => Promise<void>;
};

type Refused = { ok: false; reason: ScopeAssignmentActionRefusal };

function refuse(reason: ScopeAssignmentActionRefusal): Refused {
  return { ok: false, reason };
}

/** Values arriving off the wire, bounded before they reach a log or a store. */
function wireId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 400) : "";
}

class AuditFailed extends Error {}

async function authorize(
  input: ScopeAssignmentActionTarget,
  area: keyof typeof SCOPE_ASSIGNMENT_AUDIT_OPERATION,
  mode: "write" | "search",
  deps: ScopeAssignmentWriteDeps,
): Promise<Authorized | Refused> {
  const target = await resolveScopeAssignmentTarget(
    {
      surface: input?.surface,
      scope: input?.scope,
      vendor: input?.vendor,
      name: input?.name,
    },
    deps.target,
  );
  if (!target) return refuse("not-found");
  if (area === "context" && target.surface === "assistant") return refuse("assistants-take-skills-only");
  const section = selectScopeAssignmentSection(target, input?.section ?? null);
  if (!section) return refuse("scope-not-on-this-page");
  if (!target.admission.ok) return refuse(target.admission.reason);
  const write = section.write;
  if (!write.allowed) return refuse(write.reason);

  const beforeMutation = async (change: Record<string, unknown>) => {
    if (mode !== "write" || write.road !== "audited-bypass") return;
    try {
      await deps.bypass(
        section.actor,
        SCOPE_ASSIGNMENT_AUDIT_OPERATION[area],
        {
          resourceType: "agent",
          resourceId: target.packageName,
          ...(section.orgId ? { organizationId: section.orgId } : {}),
          ownerId: section.assignmentScope.scopeId,
        },
        write.reason,
        {
          agentPackageName: target.packageName,
          scopeKind: section.assignmentScope.scopeKind,
          scopeId: section.assignmentScope.scopeId,
          ...change,
        },
      );
    } catch {
      throw new AuditFailed();
    }
  };
  return { target, section, beforeMutation };
}

async function guarded<T extends { ok: boolean }>(fn: () => Promise<T | Refused>): Promise<T | Refused> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuditFailed) return refuse("audit-failed");
    throw err;
  }
}

function artifactVantage(target: ResolvedScopeAssignmentTarget, section: ScopeAssignmentSection): ScopeArtifactVantage {
  return {
    orgId: section.orgId ?? target.activeOrgId,
    actor: section.actor,
    projectId: section.scope.kind === "project" ? section.scope.id : null,
  };
}

// ---------------------------------------------------------------------------
// Skills.
// ---------------------------------------------------------------------------

export async function searchScopeSkills(
  input: ScopeAssignmentActionTarget,
  query: string,
  page: { offset: number; limit: number },
  deps: ScopeAssignmentWriteDeps = defaultScopeAssignmentWriteDeps,
): Promise<ScopeAssignmentSearchResult<ScopeAssignmentSkillCandidate>> {
  const auth = await authorize(input, "skills", "search", deps);
  if ("ok" in auth) return auth;
  const { results, hasMore } = await searchScopeSkillCandidates(
    auth.target.packageName,
    auth.section.assignmentScope,
    typeof query === "string" ? query.slice(0, 200) : "",
    page,
    deps.reads,
  );
  return { ok: true, results, hasMore };
}

/**
 * Assign ONE skill at the section's exact scope, atomically at the cap.
 *
 * Lock order, never inverted: the owning skill extension's lifecycle lock
 * with a revalidation of assignability under it (closing the assign against
 * uninstall race), then the store's per-(package, scope) advisory lock.
 */
export async function assignScopeSkill(
  input: ScopeAssignmentActionTarget,
  rawSkillId: string,
  deps: ScopeAssignmentWriteDeps = defaultScopeAssignmentWriteDeps,
): Promise<ScopeAssignmentActionResult> {
  return guarded(async () => {
    const skillId = wireId(rawSkillId);
    const auth = await authorize(input, "skills", "write", deps);
    if ("ok" in auth) return auth;
    if (!skillId) return refuse("unknown-skill");

    const pre = (await deps.resolveAssignability([skillId])).get(skillId);
    if (!pre || !pre.assignable || !pre.ownerPackageName) {
      return refuse(pre?.reason === "unknown-skill" || !pre ? "unknown-skill" : "not-assignable");
    }
    return deps.withInstallLock(pre.ownerPackageName, async (): Promise<ScopeAssignmentActionResult> => {
      const verdict = (await deps.resolveAssignability([skillId])).get(skillId);
      if (!verdict || !verdict.assignable) {
        return refuse(verdict?.reason === "unknown-skill" || !verdict ? "unknown-skill" : "not-assignable");
      }
      await auth.beforeMutation({ change: "assign-skill", skillId });
      const result = await deps.insertSkill({
        agentPackageName: auth.target.packageName,
        skillId,
        createdBy: auth.target.userId,
        scope: auth.section.assignmentScope,
      });
      if (result.outcome === "cap_exceeded") return refuse("cap-exceeded");
      if (result.outcome === "assigned") {
        // POST-COMMIT RECHECK, still under the lifecycle lock. The lock is
        // process-local, so an uninstall in a sibling process can land between
        // the revalidation and the commit; a skill that stopped being
        // assignable must not keep a row. A recheck that throws counts as a
        // regression: the row was committed, so "could not confirm" is no yes.
        let regressed = false;
        try {
          regressed = (await deps.resolveAssignability([skillId])).get(skillId)?.assignable !== true;
        } catch {
          regressed = true;
        }
        if (regressed) {
          await deps.deleteSkill({
            agentPackageName: auth.target.packageName,
            skillId,
            scope: auth.section.assignmentScope,
          });
          return refuse("not-assignable");
        }
      }
      return { ok: true };
    });
  });
}

/** Remove ONE skill at the section's exact scope. No floor: the last one goes too. */
export async function removeScopeSkill(
  input: ScopeAssignmentActionTarget,
  rawSkillId: string,
  deps: ScopeAssignmentWriteDeps = defaultScopeAssignmentWriteDeps,
): Promise<ScopeAssignmentActionResult> {
  return guarded(async () => {
    const skillId = wireId(rawSkillId);
    const auth = await authorize(input, "skills", "write", deps);
    if ("ok" in auth) return auth;
    if (!skillId) return refuse("unknown-skill");
    await auth.beforeMutation({ change: "remove-skill", skillId });
    await deps.deleteSkill({
      agentPackageName: auth.target.packageName,
      skillId,
      scope: auth.section.assignmentScope,
    });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Context artifacts (agents only).
// ---------------------------------------------------------------------------

async function slotFor(
  packageName: string,
  slotId: string,
  deps: ScopeAssignmentWriteDeps,
): Promise<{ ok: true; slot: AgentContextSlot } | Refused> {
  const manifest = await deps.readSlots(packageName);
  if (!manifest.ok) return refuse("validation-unreadable");
  const slot = manifest.slots.find((s) => s.slotId === slotId);
  return slot ? { ok: true, slot } : refuse("unknown-slot");
}

export async function searchScopeContextArtifacts(
  input: ScopeAssignmentActionTarget,
  rawSlotId: string,
  query: string,
  page: { offset: number; limit: number },
  deps: ScopeAssignmentWriteDeps = defaultScopeAssignmentWriteDeps,
): Promise<ScopeAssignmentSearchResult<ScopeAssignmentArtifactCandidate>> {
  const auth = await authorize(input, "context", "search", deps);
  if ("ok" in auth) return auth;
  const found = await slotFor(auth.target.packageName, wireId(rawSlotId), deps);
  if (!found.ok) return found;
  const { results, hasMore } = await searchScopeArtifactCandidates(
    auth.target.packageName,
    found.slot,
    auth.section.assignmentScope,
    artifactVantage(auth.target, auth.section),
    typeof query === "string" ? query.slice(0, 200) : "",
    page,
    deps.reads,
  );
  return { ok: true, results, hasMore };
}

/**
 * Attach ONE artifact to ONE declared slot at the section's exact scope.
 *
 * The context store validates before it writes, fail-closed, through the
 * three validators wired here: the slot exists in the trusted manifest, the
 * WRITER can see the artifact where the section reads artifacts, and the
 * artifact is a kind the slot takes. Its typed refusals come back unchanged.
 */
export async function assignScopeContextArtifact(
  input: ScopeAssignmentActionTarget,
  rawSlotId: string,
  rawArtifactId: string,
  deps: ScopeAssignmentWriteDeps = defaultScopeAssignmentWriteDeps,
): Promise<ScopeAssignmentActionResult> {
  return guarded(async () => {
    const slotId = wireId(rawSlotId);
    const artifactId = wireId(rawArtifactId);
    const auth = await authorize(input, "context", "write", deps);
    if ("ok" in auth) return auth;
    if (!slotId) return refuse("unknown-slot");
    if (!artifactId) return refuse("artifact-not-visible");
    const vantage = artifactVantage(auth.target, auth.section);
    const inspected = new Map<string, Promise<{ visible: boolean; compatible: boolean }>>();
    const inspect = async (id: string, sid: string) => {
      const key = `${sid}\u0000${id}`;
      let hit = inspected.get(key);
      if (!hit) {
        hit = (async () => {
          const found = await slotFor(auth.target.packageName, sid, deps);
          if (!found.ok) throw new Error("slot unreadable");
          const accepted = await acceptedExtensionsForSlot(found.slot, deps.reads);
          return inspectArtifactForSlot(id, accepted, vantage, deps.reads);
        })();
        inspected.set(key, hit);
      }
      return hit;
    };
    const validators: AgentAssignedContextValidators = {
      slotExists: async ({ agentPackageName, slotId: sid }) => {
        const manifest = await deps.readSlots(agentPackageName);
        if (!manifest.ok) throw new Error(manifest.reason);
        return manifest.slots.some((s) => s.slotId === sid);
      },
      artifactVisibleToWriter: async ({ artifactId: id }) => (await inspect(id, slotId)).visible,
      slotAcceptsArtifact: async ({ artifactId: id, slotId: sid }) => (await inspect(id, sid)).compatible,
    };
    // The same three checks, once BEFORE the audit row: a platform admin's
    // audited write records only a change the store is about to accept. The
    // store re-runs them inside the insert and stays the enforcement.
    try {
      const probe = { agentPackageName: auth.target.packageName, slotId, artifactId };
      if (!(await validators.slotExists(probe))) return refuse("unknown-slot");
      if (!(await validators.artifactVisibleToWriter({ artifactId, writerId: auth.target.userId, scope: auth.section.assignmentScope }))) {
        return refuse("artifact-not-visible");
      }
      if (!(await validators.slotAcceptsArtifact(probe))) return refuse("incompatible-artifact");
    } catch {
      return refuse("validation-unreadable");
    }
    await auth.beforeMutation({ change: "assign-context", slotId, artifactId });
    const result = await deps.insertContext(
      {
        agentPackageName: auth.target.packageName,
        slotId,
        artifactId,
        scope: auth.section.assignmentScope,
        createdBy: auth.target.userId,
      },
      validators,
    );
    if (result.outcome === "refused") return refuse(result.reason);
    return { ok: true };
  });
}

export async function removeScopeContextArtifact(
  input: ScopeAssignmentActionTarget,
  rawSlotId: string,
  rawArtifactId: string,
  deps: ScopeAssignmentWriteDeps = defaultScopeAssignmentWriteDeps,
): Promise<ScopeAssignmentActionResult> {
  return guarded(async () => {
    const slotId = wireId(rawSlotId);
    const artifactId = wireId(rawArtifactId);
    const auth = await authorize(input, "context", "write", deps);
    if ("ok" in auth) return auth;
    if (!slotId || !artifactId) return refuse("unknown-slot");
    await auth.beforeMutation({ change: "remove-context", slotId, artifactId });
    await deps.deleteContext({
      agentPackageName: auth.target.packageName,
      slotId,
      artifactId,
      scope: auth.section.assignmentScope,
    });
    return { ok: true };
  });
}

export async function reorderScopeContextArtifacts(
  input: ScopeAssignmentActionTarget,
  rawSlotId: string,
  rawOrder: readonly string[],
  deps: ScopeAssignmentWriteDeps = defaultScopeAssignmentWriteDeps,
): Promise<ScopeAssignmentActionResult> {
  return guarded(async () => {
    const slotId = wireId(rawSlotId);
    const order = Array.isArray(rawOrder) ? rawOrder.slice(0, 500).map(wireId) : [];
    const auth = await authorize(input, "context", "write", deps);
    if ("ok" in auth) return auth;
    if (!slotId) return refuse("unknown-slot");
    if (order.length === 0 || order.some((id) => !id)) return refuse("stale-order");
    await auth.beforeMutation({ change: "reorder-context", slotId, order });
    const result = await deps.reorderContext({
      agentPackageName: auth.target.packageName,
      slotId,
      scope: auth.section.assignmentScope,
      orderedArtifactIds: order,
    });
    return result.outcome === "stale-order" ? refuse("stale-order") : { ok: true };
  });
}

// ---------------------------------------------------------------------------
// The production I/O.
// ---------------------------------------------------------------------------

export const defaultScopeAssignmentWriteDeps: ScopeAssignmentWriteDeps = {
  target: defaultScopeAssignmentTargetDeps,
  reads: defaultScopeAssignmentReadDeps,
  bypass: async (actor, operation, resource, reason, extraMetadata) =>
    (await import("@/lib/authz/admin-bypass")).withPlatformAdminBypass(
      actor,
      operation,
      resource,
      reason,
      extraMetadata,
    ),
  resolveAssignability: async (ids) =>
    (await import("@cinatra-ai/skills/agent-skill-assignability")).resolveSkillAssignability(ids),
  withInstallLock: async (packageName, fn) =>
    (await import("@cinatra-ai/agents/materialize-agent-package")).withInstallLock(packageName, fn),
  insertSkill: async (input) => (await import("@/lib/agent-assigned-skills-store")).insertAssignedSkill(input),
  deleteSkill: async (input) => (await import("@/lib/agent-assigned-skills-store")).deleteAssignedSkill(input),
  readSlots: (packageName) => readTrustedContextSlots(packageName),
  insertContext: async (input, validators) =>
    (await import("@/lib/agent-assigned-context-store")).insertAssignedContext(input, validators),
  deleteContext: async (input) =>
    (await import("@/lib/agent-assigned-context-store")).deleteAssignedContext(input),
  reorderContext: async (input) =>
    (await import("@/lib/agent-assigned-context-store")).reorderAssignedContext(input),
};
