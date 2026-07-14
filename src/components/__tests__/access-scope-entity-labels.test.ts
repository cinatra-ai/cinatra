// Unknown-entity fallback — the ONE shared helper (cinatra#1509 §4.0-a). These
// pure tests assert the "Unknown <kind>" contract (§3.2) BOTH directly AND
// THROUGH the two consumers that used to carry their own `id.slice(-6)` copy:
//   - the hierarchical `resolveAccessParts` (src/components/access-scope.ts), and
//   - the flat picker's local `resolveAccessLabel`
//     (src/components/access-combobox.tsx).
// A single definition means the two can never drift again (the root of
// cinatra#1508's `Team: 288b9a`). Pure (no React) — sits next to
// access-scope-summary.test.ts.

import { describe, it, expect } from "vitest";
import {
  unknownScopeEntityName,
  resolveScopeEntityName,
  resolveAccessParts,
  type AvailableScopes,
} from "@/components/access-scope";
import {
  resolveAccessLabel as flatResolveAccessLabel,
  type AccessComboboxProps,
} from "@/components/access-combobox";
import type { AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";

const hierScopes: AvailableScopes = {
  orgs: [{ id: "o1", name: "Acme", teams: [{ id: "t1", name: "Eng" }] }],
  projects: [{ id: "p1", name: "Alpha" }],
  canGrantWorkspace: true,
};

const flatScopes: AccessComboboxProps["availableScopes"] = {
  projects: [{ id: "p1", name: "Alpha" }],
  teams: [{ id: "t1", name: "Eng" }],
  orgName: "Acme",
  workspaceExposed: true,
};

const UNRESOLVED_TEAM = "team:288b9aXXXXXXXXXXXXXXXXXX";
const UNRESOLVED_PROJECT = "project:zzz999YYYYYYYYYYYYYYYY";

describe("unknownScopeEntityName", () => {
  it("returns the explicit 'Unknown <kind>' label for every kind", () => {
    expect(unknownScopeEntityName("team")).toBe("Unknown team");
    expect(unknownScopeEntityName("project")).toBe("Unknown project");
    expect(unknownScopeEntityName("user")).toBe("Unknown user");
    expect(unknownScopeEntityName("org")).toBe("Unknown organization");
    expect(unknownScopeEntityName("template")).toBe("Unknown template");
  });
});

describe("resolveScopeEntityName", () => {
  it("returns the resolved name when present and non-empty", () => {
    expect(resolveScopeEntityName("team", "t1", "Engineering")).toBe("Engineering");
    expect(resolveScopeEntityName("project", "p1", "Alpha")).toBe("Alpha");
  });

  it("falls back to 'Unknown <kind>' when the name is missing / blank", () => {
    expect(resolveScopeEntityName("team", "t-missing", undefined)).toBe("Unknown team");
    expect(resolveScopeEntityName("team", "t-missing", null)).toBe("Unknown team");
    expect(resolveScopeEntityName("project", "p-missing", "   ")).toBe("Unknown project");
  });

  it("NEVER leaks the id into the label (cinatra#1508 — no id.slice fallback)", () => {
    const label = resolveScopeEntityName("team", "288b9a-deadbeef", undefined);
    expect(label).toBe("Unknown team");
    expect(label).not.toContain("288b9a");
    expect(label).not.toContain("deadbeef");
  });
});

describe("consumer 1 — hierarchical resolveAccessParts delegates to the helper", () => {
  it("renders a resolvable team/project by name", () => {
    expect(resolveAccessParts("team:t1", hierScopes)).toEqual({ type: "Team", name: "Acme - Eng" });
    expect(resolveAccessParts("project:p1", hierScopes)).toEqual({ type: "Project", name: "Alpha" });
  });

  it("renders an unresolvable team as 'Team: Unknown team' (no id suffix)", () => {
    const parts = resolveAccessParts(UNRESOLVED_TEAM as AgentAuthPolicyVisibility, hierScopes);
    expect(parts).toEqual({ type: "Team", name: "Unknown team" });
    expect(parts.name).not.toContain("288b9a");
  });

  it("renders an unresolvable project as 'Project: Unknown project' (no 'Project <id>' string)", () => {
    const parts = resolveAccessParts(UNRESOLVED_PROJECT as AgentAuthPolicyVisibility, hierScopes);
    expect(parts).toEqual({ type: "Project", name: "Unknown project" });
    expect(parts.name).not.toContain("zzz999");
  });
});

describe("consumer 2 — flat resolveAccessLabel delegates to the SAME helper", () => {
  it("renders a resolvable team/project by name", () => {
    expect(flatResolveAccessLabel("team:t1", flatScopes)).toEqual({ type: "Team", name: "Eng" });
    expect(flatResolveAccessLabel("project:p1", flatScopes)).toEqual({ type: "Project", name: "Alpha" });
  });

  it("renders an unresolvable team as 'Unknown team' (no id suffix — the #1508 bug)", () => {
    const label = flatResolveAccessLabel(UNRESOLVED_TEAM, flatScopes);
    expect(label).toEqual({ type: "Team", name: "Unknown team" });
    expect(label.name).not.toContain("288b9a");
  });

  it("renders an unresolvable project as 'Unknown project' (no 'Project <id>' string)", () => {
    const label = flatResolveAccessLabel(UNRESOLVED_PROJECT, flatScopes);
    expect(label).toEqual({ type: "Project", name: "Unknown project" });
    expect(label.name).not.toContain("zzz999");
  });
});
