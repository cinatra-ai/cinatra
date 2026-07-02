/**
 * Contract tests for the shared default OpenAI model constant in
 * `llm-provider-policy.ts`.
 *
 * Locks DEFAULT_OPENAI_MODEL_ID to "gpt-5.5" so the /setup/ai and
 * /configuration/llm default-model pickers and the persisted
 * openai-connection store (which all route their fallbacks through the
 * constant) cannot silently drift to another default, and asserts the
 * constant stays a member of the canonical ALLOWED_MODEL_IDS.openai
 * allowlist.
 *
 * Run: cd packages/agents && pnpm exec vitest run \
 *      src/__tests__/llm-provider-policy.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  ALLOWED_MODEL_IDS,
  DEFAULT_OPENAI_MODEL_ID,
  canProviderSatisfyCapability,
  providersForCapability,
  describeCapabilityRequirement,
} from "../llm-provider-policy";

describe("DEFAULT_OPENAI_MODEL_ID", () => {
  it('is "gpt-5.5"', () => {
    expect(DEFAULT_OPENAI_MODEL_ID).toBe("gpt-5.5");
  });

  it("is a member of ALLOWED_MODEL_IDS.openai", () => {
    expect(ALLOWED_MODEL_IDS.openai).toContain(DEFAULT_OPENAI_MODEL_ID);
  });
});

// Capability matrix — the single source of truth moved here from
// _llm-dispatch.ts (engineering#417). These lock the matrix so the bridge
// resolver + actionable error wording cannot drift.
describe("capability matrix", () => {
  it("media_input → gemini only", () => {
    expect(canProviderSatisfyCapability("gemini", "media_input")).toBe(true);
    expect(canProviderSatisfyCapability("openai", "media_input")).toBe(false);
    expect(canProviderSatisfyCapability("anthropic", "media_input")).toBe(false);
    expect(providersForCapability("media_input")).toEqual(["gemini"]);
  });

  it("function_tools → all three providers", () => {
    expect(providersForCapability("function_tools")).toEqual([
      "openai",
      "anthropic",
      "gemini",
    ]);
  });

  it("native_mcp → openai | anthropic (gemini excluded)", () => {
    expect(canProviderSatisfyCapability("gemini", "native_mcp")).toBe(false);
    expect(providersForCapability("native_mcp")).toEqual(["openai", "anthropic"]);
  });
});

describe("describeCapabilityRequirement", () => {
  it("default phrasing names the satisfying provider(s), not a connector package", () => {
    const msg = describeCapabilityRequirement("media_input");
    expect(msg).toContain("media_input");
    expect(msg).toContain("gemini");
    expect(msg).toContain("no installed");
    // True-IoC: core must NOT name a specific connector-package instance.
    expect(msg).not.toContain("@cinatra-ai/");
    expect(msg).not.toContain("-connector");
  });

  it("incompatible-provider phrasing names the active provider + alternatives", () => {
    const msg = describeCapabilityRequirement("native_mcp", {
      incompatibleProvider: "gemini",
    });
    expect(msg).toContain("native_mcp");
    expect(msg).toContain('provider "gemini" cannot satisfy');
    expect(msg).toContain("openai");
    expect(msg).toContain("anthropic");
    expect(msg).not.toContain("@cinatra-ai/");
  });
});
