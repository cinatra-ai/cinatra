// Agent ROLE resolution (cinatra#151 Stage 5b) — activation + fail-loud pins.
//
// The four host-required roles are claimed by cinatra.systemExtensions
// members (present in EVERY universe by the required lock), so the committed
// generated bindings MUST resolve all of them — and an unknown role must
// fail LOUD with the descriptive regeneration message, never a silent
// fallback.

import { describe, it, expect } from "vitest";
import { requireAgentRole, agentRoleDirSlug, type KnownAgentRole } from "../agent-roles";
import { GENERATED_AGENT_ROLE_BINDINGS } from "@/lib/generated/agent-bindings";

const REQUIRED_ROLES: KnownAgentRole[] = [
  "agent-security-reviewer",
  "agent-code-reviewer",
  "agent-planner",
  "agent-author",
];

describe("requireAgentRole — activation", () => {
  it.each(REQUIRED_ROLES)("%s resolves from the committed generated bindings", (role) => {
    const pkg = requireAgentRole(role);
    expect(pkg).toMatch(/^@[\w-]+\/[\w-]+$/);
    expect(GENERATED_AGENT_ROLE_BINDINGS[role]).toBe(pkg);
  });

  it("every required role has EXACTLY ONE claimant (uniqueness held at generation)", () => {
    const claimants = REQUIRED_ROLES.map((r) => requireAgentRole(r));
    expect(new Set(claimants).size).toBe(claimants.length);
  });

  it("the reviewer lane order is security, code, planner (canonical dispatch order)", async () => {
    const { REVIEWER_LANE_PACKAGES, REVIEWER_LANE_ROLES } = await import("../agent-creation-review");
    expect(REVIEWER_LANE_ROLES).toEqual([
      "agent-security-reviewer",
      "agent-code-reviewer",
      "agent-planner",
    ]);
    expect(REVIEWER_LANE_PACKAGES).toEqual(REVIEWER_LANE_ROLES.map((r) => requireAgentRole(r)));
  });
});

describe("requireAgentRole — fail-loud", () => {
  it("throws a descriptive error naming the role and the regeneration step", () => {
    expect(() => requireAgentRole("agent-nonexistent" as KnownAgentRole)).toThrow(
      /no package claims the role "agent-nonexistent"[\s\S]*generate-extension-manifest/,
    );
  });
});

describe("agentRoleDirSlug", () => {
  it.each(REQUIRED_ROLES)("derives the install-dir slug from the %s package name", (role) => {
    expect(agentRoleDirSlug(role)).toBe(requireAgentRole(role).split("/")[1]);
  });
});
