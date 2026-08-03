"use server";

// ---------------------------------------------------------------------------
// Server actions for direct agent↔skill assignment (cinatra#2346 S1, epic
// #2345). Three actions, all of which:
//
//   * RE-ASSERT ADMIN SERVER-SIDE. The settings surface is admin-only, but a
//     surface being admin-only is not an authorization decision — every action
//     re-resolves the session and re-checks the role itself, so a crafted
//     request that never rendered the page is refused identically.
//   * DERIVE THE TARGET SERVER-SIDE. The caller passes the agent reference the
//     authorized settings context is FOR; the action re-resolves it to the
//     canonical package name through the shared resolver and re-checks that the
//     canonical target is an agent-kind, non-assistant extension. Any other
//     field on the input object is ignored — position, creator and canonical
//     key are all server-derived, never accepted from the wire.
//   * DELIBERATELY DO NOT COPY the execution action's DB-template lookup
//     (`readAgentTemplateByPackageName`): provider-declared on-disk agents have
//     NO `agent_templates` row, and a template-shaped lookup would make every
//     one of them permanently unassignable.
//
// "use server" modules may only export async functions — every helper below is
// module-private.
// ---------------------------------------------------------------------------

import {
  assertAgentWriteTarget,
  resolveCanonicalAgentPackage,
  type AgentPackageResolution,
} from "./agent-package-resolver";
import {
  resolveSkillAssignability,
  type SkillAssignability,
} from "./agent-skill-assignability";

import {
  AGENT_ASSIGNED_SKILLS_CAP,
  deleteAssignedSkill,
  insertAssignedSkill,
  readAssignedSkillsForAgentPackage,
  type AgentAssignedSkillRow,
} from "@/lib/agent-assigned-skills-store";

/** Why an assignment action refused. Rendered by S4; logged by everyone. */
export type AgentSkillActionRefusal =
  | "forbidden"
  | "unknown-agent"
  | "ambiguous-agent"
  | "not-an-agent"
  | "assistant"
  | "eligibility-unreadable"
  | "unknown-skill"
  | "not-assignable"
  | "cap-exceeded";

export type AgentSkillActionResult<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: AgentSkillActionRefusal; detail?: string };

/**
 * ONE hydrated assignment row for the settings list.
 *
 * `status` is what makes this read usable as the list's ONLY source: an
 * assignment whose skill has since been archived or has changed role STAYS in
 * the list — visible and removable — because the S3 search population excludes
 * exactly those rows and could never hydrate them. A COMPLETED uninstall
 * deletes the row (S5), so "gone" and "degraded" stay distinguishable.
 */
export type AssignedAgentSkillView = {
  skillId: string;
  position: number;
  /** Catalog display name; falls back to the raw id when the row is gone. */
  name: string;
  description: string;
  /** The REAL owning package (never the virtual chat namespace), when known. */
  ownerPackageName: string | null;
  /** `ok` when still assignable; otherwise the predicate's refusal. */
  status: "ok" | "archived" | "role-changed" | "missing" | "unavailable";
  /** Convenience for the UI: `status === "ok"`. */
  assignable: boolean;
  createdBy: string;
  createdAt: string;
};

function projectStatus(verdict: SkillAssignability | undefined): AssignedAgentSkillView["status"] {
  if (!verdict) return "unavailable";
  if (verdict.assignable) return "ok";
  switch (verdict.reason) {
    case "unknown-skill":
    case "no-owning-extension":
    case "not-installed":
      return "missing";
    case "archived":
      return "archived";
    case "not-injectable":
    case "not-globally-visible":
      return "role-changed";
    default:
      return "unavailable";
  }
}

function refusalForResolution(
  resolution: Extract<AgentPackageResolution, { ok: false }>,
): AgentSkillActionRefusal {
  return resolution.reason === "ambiguous" ? "ambiguous-agent" : "unknown-agent";
}

/**
 * Render an identifier for a LOG LINE safely.
 *
 * A skill id and an agent reference both originate off the wire. Interpolating
 * one into the message string would make the log format itself caller-
 * controlled: a value carrying `%s` or a newline could forge a second log
 * record. The value is therefore length-bounded, stripped of control characters
 * and passed as a console ARGUMENT, never spliced into the format string.
 */
function forLog(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 200);
}

/** Admin re-assertion. Dynamic import so unit tests can `vi.doMock` the
 *  auth-session module without dragging in the full app-server module graph. */
async function requireAdmin(): Promise<{ userId: string }> {
  const { requireAdminSession } = await import("@/lib/auth-session");
  const session = await requireAdminSession();
  return { userId: String(session?.user?.id ?? "") };
}

/**
 * Read the ordered assignments for an agent, HYDRATED with display metadata
 * and the CURRENT assignability status of each assigned skill.
 */
export async function listAssignedAgentSkills(
  agentRef: string,
): Promise<AgentSkillActionResult<{ agentPackageName: string; skills: AssignedAgentSkillView[] }>> {
  await requireAdmin();

  const resolved = await resolveCanonicalAgentPackage(agentRef);
  if (!resolved.ok) return { ok: false, reason: refusalForResolution(resolved) };

  const rows = await readAssignedSkillsForAgentPackage(resolved.packageName);
  if (rows.length === 0) {
    return { ok: true, agentPackageName: resolved.packageName, skills: [] };
  }

  // ONE predicate pass over the whole assigned set — archived and role-changed
  // rows come back with a verdict rather than being dropped.
  const verdicts = await resolveSkillAssignability(rows.map((r) => r.skillId));
  const skills = rows.map((row: AgentAssignedSkillRow): AssignedAgentSkillView => {
    const verdict = verdicts.get(row.skillId);
    return {
      skillId: row.skillId,
      position: row.position,
      name: verdict?.skill?.name || row.skillId,
      description: verdict?.skill?.description ?? "",
      ownerPackageName: verdict?.ownerPackageName ?? null,
      status: projectStatus(verdict),
      assignable: verdict?.assignable === true,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
  });
  return { ok: true, agentPackageName: resolved.packageName, skills };
}

/**
 * Assign ONE skill to an agent, atomically at the 3-cap.
 *
 * LOCK ORDER (issue scope item 3), never inverted:
 *   1. the owning skill extension's LIFECYCLE lock, and a REVALIDATION of the
 *      shared assignability predicate while holding it. This is what closes the
 *      assign-vs-uninstall race: the uninstall path runs under the same lock,
 *      so a concurrent assign either completes entirely before the uninstall's
 *      teardown, or waits and then finds the skill gone and refuses. A cap lock
 *      alone would only serialize competing ASSIGNMENTS.
 *   2. the per-agent advisory TRANSACTION lock (inside the store).
 *   3. count → position → insert (inside the store), backed by
 *      UNIQUE (agent_package_name, position).
 *
 * UI disable is additive decoration; THIS is the enforcement.
 */
export async function assignAgentSkill(input: {
  agentRef: string;
  skillId: string;
}): Promise<
  AgentSkillActionResult<{
    agentPackageName: string;
    skillId: string;
    position: number;
    alreadyAssigned: boolean;
  }>
> {
  const { userId } = await requireAdmin();

  const agentRef = String(input?.agentRef ?? "").trim();
  const skillId = String(input?.skillId ?? "").trim();
  if (!skillId) return { ok: false, reason: "unknown-skill" };

  // TARGET: server-derived from the authorized settings context, then gated.
  const resolved = await resolveCanonicalAgentPackage(agentRef);
  if (!resolved.ok) return { ok: false, reason: refusalForResolution(resolved) };
  const target = await assertAgentWriteTarget(resolved.packageName);
  if (!target.ok) return { ok: false, reason: target.reason };

  // Pre-lock pass: resolve the OWNING package so we know which lifecycle lock to
  // take. A refusal here is already final (nothing an uninstall could do would
  // make an unassignable skill assignable).
  const pre = await resolveSkillAssignability([skillId]);
  const preVerdict = pre.get(skillId);
  if (!preVerdict || !preVerdict.assignable || !preVerdict.ownerPackageName) {
    return {
      ok: false,
      reason: preVerdict?.reason === "unknown-skill" ? "unknown-skill" : "not-assignable",
      detail: preVerdict?.reason ?? "unknown-skill",
    };
  }

  const { withInstallLock } = await import("@cinatra-ai/agents");
  return withInstallLock(preVerdict.ownerPackageName, async () => {
    // (1) REVALIDATE under the lifecycle lock. Between the pre-lock pass and
    // here, an uninstall may have completed; if so this refuses instead of
    // inserting a row the teardown has already swept past.
    const revalidated = await resolveSkillAssignability([skillId]);
    const verdict = revalidated.get(skillId);
    if (!verdict || !verdict.assignable) {
      return {
        ok: false as const,
        reason: verdict?.reason === "unknown-skill" ? ("unknown-skill" as const) : ("not-assignable" as const),
        detail: verdict?.reason ?? "unknown-skill",
      };
    }

    // (2)+(3) Atomic cap: per-agent advisory lock → count → position → insert.
    const result = await insertAssignedSkill({
      agentPackageName: resolved.packageName,
      skillId,
      // SERVER-DERIVED. Never the wire's idea of who is assigning.
      createdBy: userId,
    });
    if (result.outcome === "cap_exceeded") {
      return {
        ok: false as const,
        reason: "cap-exceeded" as const,
        detail: `An agent can have at most ${AGENT_ASSIGNED_SKILLS_CAP} assigned skills.`,
      };
    }

    // (4) POST-COMMIT COMPENSATION, still under the lifecycle lock.
    //
    // The lifecycle lock is a PROCESS-LOCAL queue (it is what every install /
    // uninstall / purge path in the platform serializes on), so it orders this
    // assign against uninstalls IN THIS PROCESS but not against one running in
    // a sibling worker. In that narrow multi-process window an uninstall's
    // teardown can complete between the revalidation above and the commit,
    // leaving a row the teardown already swept past. Re-checking here and
    // deleting the row turns "present forever" into "present for the length of
    // one transaction", and the row was never deliverable in the meantime:
    // S2's resolution-time revalidation drops a non-assignable assigned skill
    // from the injected set. Widening the serialization itself to a
    // cross-process lock would change every lifecycle path, not this one.
    if (result.outcome === "assigned") {
      // A THROWN re-check is treated as a regression (fail-closed) — the row
      // was committed, so "we could not confirm" must not read as "confirmed".
      let regression: string | null = null;
      try {
        const after = await resolveSkillAssignability([skillId]);
        const verdictAfter = after.get(skillId);
        if (verdictAfter?.assignable !== true) {
          regression = verdictAfter?.reason ?? "unknown-skill";
        }
      } catch (err) {
        regression = "revalidation-failed";
        console.warn(
          "[skills/agent-assigned-skills] post-commit revalidation threw for skill:",
          forLog(skillId),
          err instanceof Error ? err.message : err,
        );
      }
      if (regression) {
        // Deleting the (agent, skill) pair is correct even if a concurrent
        // admin re-created it in the gap: the skill is no longer assignable, so
        // NO row for it should survive — the pair, not this particular row, is
        // what the compensation is about.
        try {
          await deleteAssignedSkill({ agentPackageName: resolved.packageName, skillId });
        } catch (err) {
          // The refusal is still the truthful answer to the caller. The row
          // that could not be swept is inert in the meantime — S2's
          // resolution-time revalidation refuses to deliver a non-assignable
          // assigned skill — and the next remove or uninstall teardown clears
          // it. Logged loudly so it is not silent.
          console.error(
            "[skills/agent-assigned-skills] compensation delete FAILED — this agent still carries " +
              "an unassignable assignment; it will NOT be delivered, remove it from the agent's " +
              "settings. agent / skill / cause:",
            forLog(resolved.packageName),
            forLog(skillId),
            err instanceof Error ? err.message : err,
          );
          return {
            ok: false as const,
            reason: "not-assignable" as const,
            detail: "compensation-failed",
          };
        }
        return { ok: false as const, reason: "not-assignable" as const, detail: regression };
      }
    }
    return {
      ok: true as const,
      agentPackageName: resolved.packageName,
      skillId,
      position: result.row.position,
      alreadyAssigned: result.outcome === "already_assigned",
    };
  });
}

/**
 * Remove ONE assignment. Works down to ZERO rows — there is no last-assignment
 * floor (unlike extension owners). Idempotent: removing what is already gone
 * succeeds with `removed: false`.
 *
 * Removal deliberately does NOT consult assignability: an archived or
 * role-changed assignment is exactly the row an admin most needs to be able to
 * delete.
 */
export async function removeAgentSkill(input: {
  agentRef: string;
  skillId: string;
}): Promise<AgentSkillActionResult<{ agentPackageName: string; skillId: string; removed: boolean }>> {
  await requireAdmin();

  const agentRef = String(input?.agentRef ?? "").trim();
  const skillId = String(input?.skillId ?? "").trim();
  if (!skillId) return { ok: false, reason: "unknown-skill" };

  const resolved = await resolveCanonicalAgentPackage(agentRef);
  if (!resolved.ok) return { ok: false, reason: refusalForResolution(resolved) };
  const target = await assertAgentWriteTarget(resolved.packageName);
  if (!target.ok) return { ok: false, reason: target.reason };

  const { deleted } = await deleteAssignedSkill({
    agentPackageName: resolved.packageName,
    skillId,
  });
  return { ok: true, agentPackageName: resolved.packageName, skillId, removed: deleted };
}
