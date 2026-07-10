// Unit tests for the assistant runtime config/ports builder (cinatra#1037 P2a).
import { describe, expect, it } from "vitest";

import {
  buildAssistantRuntimeConfig,
  isAllowedByList,
  DEFAULT_MAX_TOOL_ROUNDS,
  DEFAULT_SKILL_ID_NAMESPACE,
} from "../ports";
import { assistantConfigSchema } from "@/lib/assistant-config";

function cfg(overrides: Record<string, unknown> = {}) {
  return assistantConfigSchema.parse({
    persona: "You are a test assistant.",
    skillBundle: ["core-skill", "extra-skill"],
    ...overrides,
  });
}

describe("buildAssistantRuntimeConfig", () => {
  it("qualifies skillBundle slugs with the default namespace and picks skillBundle[0] as the system skill", () => {
    const rt = buildAssistantRuntimeConfig(cfg());
    expect(rt.skillIdNamespace).toBe(DEFAULT_SKILL_ID_NAMESPACE);
    expect(rt.skillIds).toEqual([
      `${DEFAULT_SKILL_ID_NAMESPACE}:core-skill`,
      `${DEFAULT_SKILL_ID_NAMESPACE}:extra-skill`,
    ]);
    expect(rt.systemSkillId).toBe(`${DEFAULT_SKILL_ID_NAMESPACE}:core-skill`);
  });

  it("passes the sidecar fields through unchanged (persona→fallback, allow-lists, modelPrefs)", () => {
    const rt = buildAssistantRuntimeConfig(
      cfg({ allowedTools: ["a"], allowedAgents: ["@x/y"], modelPrefs: { model: "m" } }),
    );
    expect(rt.fallbackPersona).toBe("You are a test assistant.");
    expect(rt.allowedTools).toEqual(["a"]);
    expect(rt.allowedAgents).toEqual(["@x/y"]);
    expect(rt.modelPrefs).toEqual({ model: "m" });
  });

  it("defaults maxToolRounds and honours overrides for namespace + ceiling", () => {
    expect(buildAssistantRuntimeConfig(cfg()).maxToolRounds).toBe(DEFAULT_MAX_TOOL_ROUNDS);
    const rt = buildAssistantRuntimeConfig(cfg(), {
      skillIdNamespace: "@acme/assistant",
      maxToolRounds: 9,
    });
    expect(rt.skillIds[0]).toBe("@acme/assistant:core-skill");
    expect(rt.maxToolRounds).toBe(9);
  });

  it("fails loud on an empty skillBundle (no system skill)", () => {
    expect(() =>
      buildAssistantRuntimeConfig(cfg({ skillBundle: [] })),
    ).toThrow(/non-empty skillBundle/);
  });
});

describe("isAllowedByList", () => {
  it("treats an EMPTY list as no restriction (every tool allowed — parity)", () => {
    expect(isAllowedByList("anything", [])).toBe(true);
  });
  it("restricts to members when the list is non-empty", () => {
    expect(isAllowedByList("shell", ["shell"])).toBe(true);
    expect(isAllowedByList("web_search", ["shell"])).toBe(false);
  });
});
