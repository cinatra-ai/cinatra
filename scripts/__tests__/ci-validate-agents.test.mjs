// Regression tests for ci-validate-agents' agent-definition classifier
// (epic #1873 W6/W7). The legacy OAS/agent.json validator must recognize the
// THIRD agent form — an assistant-kind agent that declares via
// cinatra/config.json's `assistant` block instead of a compiled-plan
// oas.json / agent.json — and DEFER its validation to the assistant-declaration
// gate, WITHOUT opening a fail-open hole for a genuinely broken agent.

import { describe, it, expect } from "vitest";
import { classifyAgentDefinition } from "../ci-validate-agents.mjs";

const PKG = "@cinatra-ai/cinatra-assistant";

/** A well-formed assistant declaration (mirrors the real cinatra-assistant
 *  cinatra/config.json; matches the pinned validateAssistantConfig schema). */
const VALID_ASSISTANT = {
  formatVersion: 1,
  assistant: {
    abiVersion: 1,
    displayName: "Cinatra",
    preferredTag: "cinatra",
    persona: "You are the Cinatra AI assistant.",
    skillBundle: ["chat-assistant-core"],
    launch: { kind: "local" },
    delivery: { kind: "host-runtime" },
  },
};

describe("classifyAgentDefinition", () => {
  it("routes an OAS agent to the OAS/agent validator", () => {
    expect(classifyAgentDefinition({ hasOas: true, hasLegacy: false, config: null, packageName: PKG }))
      .toEqual({ verdict: "oas" });
  });

  it("OAS wins even when a config.json is also present (no premature skip)", () => {
    expect(classifyAgentDefinition({ hasOas: true, hasLegacy: false, config: VALID_ASSISTANT, packageName: PKG }))
      .toEqual({ verdict: "oas" });
  });

  it("routes a legacy agent.json agent to the legacy validator", () => {
    expect(classifyAgentDefinition({ hasOas: false, hasLegacy: true, config: null, packageName: PKG }))
      .toEqual({ verdict: "legacy" });
  });

  it("SKIPS (defers) a valid config.json-declared assistant", () => {
    expect(classifyAgentDefinition({ hasOas: false, hasLegacy: false, config: VALID_ASSISTANT, packageName: PKG }))
      .toEqual({ verdict: "assistant" });
  });

  it("FAILS a config.json with a MALFORMED assistant block (fail-closed, no green-wash)", () => {
    const bad = { formatVersion: 1, assistant: { ...VALID_ASSISTANT.assistant, preferredTag: "Not A Token" } };
    const res = classifyAgentDefinition({ hasOas: false, hasLegacy: false, config: bad, packageName: PKG });
    expect(res.verdict).toBe("assistant-invalid");
    expect(res.errors.length).toBeGreaterThan(0);
    expect(res.errors.join("\n")).toContain("preferredTag");
  });

  it("FAILS a config.json with NO assistant block (falls through to missing-definition)", () => {
    expect(classifyAgentDefinition({ hasOas: false, hasLegacy: false, config: { formatVersion: 1 }, packageName: PKG }))
      .toEqual({ verdict: "missing" });
  });

  it("FAILS a genuinely broken agent (no oas.json, no agent.json, no config.json)", () => {
    expect(classifyAgentDefinition({ hasOas: false, hasLegacy: false, config: null, packageName: PKG }))
      .toEqual({ verdict: "missing" });
  });
});
