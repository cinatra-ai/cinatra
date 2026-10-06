import type { ScopeAssignmentPageModel } from "@/lib/scope-assignment/scope-assignment-page.server";
import type { ScopeAssignmentSkillCandidate } from "@/lib/scope-assignment/scope-assignment-model";

// Fictional packages, with the resolved data shape the real server supplies.
// The page itself supplies every label, control and state reading.
export const SCOPE_SKILLS_CANDIDATES: ScopeAssignmentSkillCandidate[] = [
  { skillId: "sk_blog", skillName: "Blog Writing", displayName: "Blog Skills", vendorName: "Cinatra", status: "active" },
  { skillId: "sk_research", skillName: "Company Research", displayName: "Research Toolkit", vendorName: "Northstar", status: "active" },
  { skillId: "sk_market", skillName: "Market Analysis", displayName: "Market Toolkit", vendorName: "Northstar", status: "active" },
  { skillId: "sk_budget", skillName: "Budget Planning", displayName: "Budget Toolkit", vendorName: "Cinatra", status: "active" },
];

export const SCOPE_SKILLS_MODEL: ScopeAssignmentPageModel = {
  surface: "agent",
  tab: "skills",
  routeScope: { kind: "team", id: "team_growth" },
  packageName: "@cinatra-ai/scope-fixture-agent",
  displayName: "Research Assistant",
  scopeLabel: "Team · Growth",
  crossScope: false,
  target: {
    surface: "agent",
    scope: { kind: "team", id: "team_growth" },
    vendor: "cinatra-ai",
    name: "scope-fixture-agent",
  },
  admission: { ok: true },
  manifest: null,
  sections: [{
    key: "team:team_growth",
    scope: { kind: "team", id: "team_growth" },
    label: "Team · Growth",
    write: { allowed: true, road: "grant" },
    skills: SCOPE_SKILLS_CANDIDATES.slice(0, 2).map((skill) => ({ ...skill, status: "ok" })),
    slots: null,
  }],
};
