import "server-only";

// ---------------------------------------------------------------------------
// The §V settings "Skills" section for an AGENT extension (cinatra#2349 S4,
// epic #2345).
//
// Server half: decides whether the section applies at all, hydrates the chosen
// rows, binds the three server actions, and hands everything to the client
// editor. Kept out of `packages/extensions` for the same reason the Execution
// section is: the settings screen only needs to know "render this node for an
// eligible agent", while the skills-plane knowledge stays next to the rest of
// the skills slice.
//
// ELIGIBILITY IS AUTHORITATIVE, AND IT IS THE WHOLE SECTION. An assistant is
// an agent-kind extension whose injection branch ignores the channel these
// assignments feed, so an assignment there could never be delivered — offering
// the section would be a silent lie. It is detected from the persisted
// assistant declaration / the agent-template registry linkage (S1's shared
// eligibility module), NEVER from a `-assistant` name suffix or a template
// shape. When the section does not apply, this returns `null` and the caller
// renders NOTHING — no heading, no empty frame, no placeholder — which is why
// the decision lives here rather than inside the rendered component.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";

import {
  listAssignedAgentSkills,
  assignAgentSkill,
  removeAgentSkill,
} from "@cinatra-ai/skills/agent-assigned-skills-actions";
import { searchAssignableSkillExtensions } from "@cinatra-ai/extensions/assignable-skills-actions";
import { resolveAssignedSkillDisplay } from "@cinatra-ai/extensions/assigned-skills-display";
import { AGENT_ASSIGNED_SKILLS_CAP } from "@/lib/agent-assigned-skills-store";
import { isAssistantPackageName, readCanonicalPackageKind } from "@/lib/agent-package-eligibility";
import {
  AgentSkillsConfigClient,
  type AgentSkillCandidate,
  type AgentSkillRow,
} from "@/components/skills/agent-skills-config-client";

/**
 * Does this package get a Skills section?
 *
 * FAIL-CLOSED on every read failure: "the registry could not be read" must
 * never render as "this is not an assistant". A false verdict costs an admin a
 * section they can reload into; a wrong true verdict advertises an assignment
 * the injection path would silently drop.
 */
export async function isAgentSkillsSectionEligible(packageName: string): Promise<boolean> {
  if (!packageName) return false;
  try {
    const kind = await readCanonicalPackageKind(packageName);
    if (kind !== "agent") return false;
    return !(await isAssistantPackageName(packageName));
  } catch (err) {
    console.warn(
      "[agent-skills] eligibility read failed — omitting the Skills section:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * The section node for `packageName`, or `null` when it does not apply.
 *
 * The chosen rows come from S1's `listAssignedAgentSkills` and NOT from the
 * search population: the search deliberately excludes skills that have since
 * been archived or re-declared, so hydrating from it would make exactly the
 * rows an admin needs to clear disappear from the only surface that can clear
 * them.
 */
export async function loadAgentSkillsSection({
  packageName,
}: {
  packageName: string;
}): Promise<ReactNode | null> {
  if (!(await isAgentSkillsSectionEligible(packageName))) return null;

  const listed = await listAssignedAgentSkills(packageName);
  if (!listed.ok) {
    // The read re-asserts admin and re-resolves the target itself. A refusal
    // here means this caller should not have had the section at all — omit it
    // rather than render a section whose every action would refuse.
    console.warn("[agent-skills] assigned-skills read refused:", listed.reason);
    return null;
  }

  const labels = await resolveAssignedSkillDisplay(listed.skills.map((s) => s.skillId));
  const initialRows: AgentSkillRow[] = listed.skills.map((s) => {
    const label = labels.get(s.skillId);
    return {
      skillId: s.skillId,
      skillName: s.name,
      // Fall back to the owning package name — the platform's own last-resort
      // display tier — for a row the assignable population no longer covers
      // (archived / role-changed). The row's state badge is what explains it.
      displayName: label?.displayName ?? s.ownerPackageName ?? s.name,
      vendorName: label?.vendorName ?? null,
      status: s.status,
    };
  });

  // The three actions, bound to the SERVER-DERIVED package name. Each one
  // re-asserts admin and re-resolves the target itself; binding here only means
  // the client never gets to name a different agent.
  const search = async (query: string, page: { offset: number; limit: number }) => {
    "use server";
    const r = await searchAssignableSkillExtensions(packageName, query, page);
    if (!r.ok) return { ok: false as const, reason: r.reason };
    const results: AgentSkillCandidate[] = r.results.map((row) => ({
      skillId: row.skillId,
      skillName: row.skillName,
      displayName: row.displayName,
      vendorName: row.vendorName,
      status: row.status,
    }));
    return { ok: true as const, results, hasMore: r.hasMore };
  };

  const assign = async (skillId: string) => {
    "use server";
    const r = await assignAgentSkill({ agentRef: packageName, skillId });
    return r.ok ? { ok: true as const } : { ok: false as const, reason: r.reason };
  };

  const remove = async (skillId: string) => {
    "use server";
    const r = await removeAgentSkill({ agentRef: packageName, skillId });
    return r.ok ? { ok: true as const } : { ok: false as const, reason: r.reason };
  };

  return (
    <AgentSkillsConfigClient
      cap={AGENT_ASSIGNED_SKILLS_CAP}
      initialRows={initialRows}
      search={search}
      assign={assign}
      remove={remove}
    />
  );
}
