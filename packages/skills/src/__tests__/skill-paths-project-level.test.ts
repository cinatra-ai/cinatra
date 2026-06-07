// Unit tests for `projectLevelFromIdentity`.
//
// Locks the legacy-`SkillLevel` projection from typed identity columns so
// UI/access readers (plugin-pages.tsx, skill-access-actions.ts,
// agents-store.ts, dedup-skills.ts, llm-matching/*) can adopt it
// incrementally without breaking the existing `payload.level` path.

import { describe, expect, it } from "vitest";

import { projectLevelFromIdentity } from "../skill-paths";

describe("projectLevelFromIdentity legacy-level projection", () => {
  it("maps owner_scope='personal' to 'personal'", () => {
    expect(projectLevelFromIdentity({ owner_scope: "personal", binding_scope: "owner" })).toBe("personal");
    expect(projectLevelFromIdentity({ owner_scope: "personal", binding_scope: "agent" })).toBe("personal");
  });

  it("maps owner_scope='team' to 'team'", () => {
    expect(projectLevelFromIdentity({ owner_scope: "team", binding_scope: "owner" })).toBe("team");
  });

  it("maps owner_scope='organization' to 'organization'", () => {
    expect(projectLevelFromIdentity({ owner_scope: "organization", binding_scope: "owner" })).toBe("organization");
  });

  it("maps owner_scope='project' to 'team' (closest legacy proxy)", () => {
    expect(projectLevelFromIdentity({ owner_scope: "project", binding_scope: "owner" })).toBe("team");
  });

  it("maps (workspace, agent) to 'agent'", () => {
    expect(projectLevelFromIdentity({ owner_scope: "workspace", binding_scope: "agent" })).toBe("agent");
  });

  it("maps (workspace, owner) to 'system'", () => {
    expect(projectLevelFromIdentity({ owner_scope: "workspace", binding_scope: "owner" })).toBe("system");
  });

  it("maps undefined owner_scope to 'system' (safe default for legacy rows)", () => {
    expect(projectLevelFromIdentity({})).toBe("system");
    expect(projectLevelFromIdentity({ owner_scope: null })).toBe("system");
  });

  it("never returns 'project' or 'workspace' (unreachable by switch body)", () => {
    // Sanity check that the narrowed return type matches behavior.
    const allInputs = [
      { owner_scope: "personal" as const, binding_scope: "owner" as const },
      { owner_scope: "team" as const, binding_scope: "owner" as const },
      { owner_scope: "organization" as const, binding_scope: "owner" as const },
      { owner_scope: "project" as const, binding_scope: "owner" as const },
      { owner_scope: "workspace" as const, binding_scope: "owner" as const },
      { owner_scope: "workspace" as const, binding_scope: "agent" as const },
    ];
    for (const input of allInputs) {
      const result = projectLevelFromIdentity(input);
      expect(result).not.toBe("project");
      expect(result).not.toBe("workspace");
    }
  });
});
