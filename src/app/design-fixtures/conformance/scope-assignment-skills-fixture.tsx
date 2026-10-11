"use client";

import { useMemo } from "react";
import { ScopeAssignmentPage } from "@/components/scope-assignment/scope-assignment-page";
import {
  ScopeAssignmentSkillActionsProvider,
  type ScopeAssignmentSkillActions,
} from "@/components/scope-assignment/scope-assignment-skill-actions";
import type { ScopeAssignmentActionTarget } from "@/lib/scope-assignment/scope-assignment-model";
import { SCOPE_SKILLS_CANDIDATES as SKILLS, SCOPE_SKILLS_MODEL } from "./scope-assignment-skills-fixture-data";

export { SCOPE_SKILLS_MODEL } from "./scope-assignment-skills-fixture-data";


function isFixtureTarget(target: ScopeAssignmentActionTarget): boolean {
  const expected = SCOPE_SKILLS_MODEL.target;
  return target.surface === expected.surface && target.vendor === expected.vendor &&
    target.name === expected.name && target.scope.kind === "team" && target.scope.id === "team_growth" &&
    (target.section == null || (target.section.kind === "team" && target.section.id === "team_growth"));
}

/** A per-mount, exact-target data store in place of the bound server calls.
 * No session, database or product assignment is touched. A wrong tuple refuses
 * the operation, so an action driver cannot green a call the page misrouted. */
export function createScopeSkillsFixtureActions(): ScopeAssignmentSkillActions {
  const assigned = new Set(SCOPE_SKILLS_MODEL.sections[0]!.skills!.map((skill) => skill.skillId));
  const refused = { ok: false, reason: "scope-not-on-this-page" } as const;
  return {
    searchScopeAssignableSkillsAction: async (target, query, page) => {
      if (!isFixtureTarget(target)) return refused;
      if (!Number.isInteger(page.offset) || page.offset < 0 || !Number.isInteger(page.limit) || page.limit <= 0) {
        return { ok: false, reason: "validation-unreadable" };
      }
      const search = query.trim().toLocaleLowerCase("en");
      const matching = SKILLS.filter((skill) => !assigned.has(skill.skillId) &&
        `${skill.skillName} ${skill.displayName}`.toLocaleLowerCase("en").includes(search));
      return { ok: true, results: matching.slice(page.offset, page.offset + page.limit), hasMore: matching.length > page.offset + page.limit };
    },
    assignScopeSkillAction: async (target, skillId) => {
      if (!isFixtureTarget(target)) return refused;
      if (!SKILLS.some((skill) => skill.skillId === skillId)) return { ok: false, reason: "unknown-skill" };
      if (!assigned.has(skillId) && assigned.size >= 5) return { ok: false, reason: "cap-exceeded" };
      assigned.add(skillId);
      return { ok: true };
    },
    removeScopeSkillAction: async (target, skillId) => {
      if (!isFixtureTarget(target)) return refused;
      if (!SKILLS.some((skill) => skill.skillId === skillId)) return { ok: false, reason: "unknown-skill" };
      assigned.delete(skillId);
      return { ok: true };
    },
  };
}

export function ScopeAssignmentSkillsConformanceFixture() {
  const actions = useMemo(() => createScopeSkillsFixtureActions(), []);
  return (
    <div data-surface-id="agent-assignment-skills" data-variant="populated">
      <ScopeAssignmentSkillActionsProvider actions={actions}>
        <ScopeAssignmentPage model={SCOPE_SKILLS_MODEL} />
      </ScopeAssignmentSkillActionsProvider>
    </div>
  );
}
