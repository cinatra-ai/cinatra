// resolveAccessSummary: a compact trigger label for a token SELECTION — a
// single token renders as its full "Type: Name" label; N>1 tokens render as a
// composed, pluralised, stable-ordered per-category breakdown ("1 project,
// 1 team"); an empty selection falls back to the owner label. Pure (no React) —
// the single-token resolveAccessParts / resolveAccessLabel are exercised
// elsewhere.

import { describe, it, expect } from "vitest";
import { resolveAccessSummary, type AvailableScopes } from "@/components/access-scope";
import type { AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";

const scopes: AvailableScopes = {
  orgs: [{ id: "o1", name: "Acme", teams: [{ id: "t1", name: "Eng" }] }],
  projects: [{ id: "p1", name: "Alpha" }],
  canGrantWorkspace: true,
};

describe("resolveAccessSummary", () => {
  it("renders a single token as its full Type: Name label", () => {
    expect(resolveAccessSummary(["team:t1"], scopes)).toBe("Team: Acme - Eng");
    expect(resolveAccessSummary(["owner"], scopes)).toBe("Personal: Only me");
    expect(resolveAccessSummary(["workspace"], scopes)).toBe("Workspace: All");
  });

  it("composes N>1 tokens as a pluralised, per-category breakdown", () => {
    expect(resolveAccessSummary(["team:t1", "project:p1"], scopes)).toBe("1 project, 1 team");
    expect(
      resolveAccessSummary(
        ["org:o1", "team:t1", "admin"] as AgentAuthPolicyVisibility[],
        scopes,
      ),
    ).toBe("1 team, 1 organization, 1 admin scope");
  });

  it("pluralises each category and holds a stable category order", () => {
    // Two of the same category → plural noun.
    expect(resolveAccessSummary(["team:t1", "team:t2", "project:p1"], scopes)).toBe(
      "1 project, 2 teams",
    );
    expect(
      resolveAccessSummary(["org:o1", "org:o2"] as AgentAuthPolicyVisibility[], scopes),
    ).toBe("2 organizations");
    // Selection order does NOT change the summary (project before team, always).
    expect(resolveAccessSummary(["project:p1", "team:t1"], scopes)).toBe("1 project, 1 team");
    expect(resolveAccessSummary(["team:t1", "project:p1"], scopes)).toBe("1 project, 1 team");
  });

  it("an empty selection falls back to the owner label", () => {
    expect(resolveAccessSummary([], scopes)).toBe("Personal: Only me");
  });
});
