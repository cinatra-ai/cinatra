// resolveAccessSummary (multi-scope W2): a compact trigger label for a token
// SELECTION — a single token renders as its full "Type: Name" label; N>1
// tokens render as an "N scopes" summary; an empty selection falls back to the
// owner label. Pure (no React) — the single-token resolveAccessParts /
// resolveAccessLabel are exercised elsewhere.

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

  it("renders N>1 tokens as an N-scopes summary", () => {
    expect(resolveAccessSummary(["team:t1", "project:p1"], scopes)).toBe("2 scopes");
    expect(
      resolveAccessSummary(
        ["org:o1", "team:t1", "admin"] as AgentAuthPolicyVisibility[],
        scopes,
      ),
    ).toBe("3 scopes");
  });

  it("an empty selection falls back to the owner label", () => {
    expect(resolveAccessSummary([], scopes)).toBe("Personal: Only me");
  });
});
