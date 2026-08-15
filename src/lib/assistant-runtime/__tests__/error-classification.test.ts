/**
 * CLASSIFIED RUNTIME RECOVERY (cinatra#2390, epic #2385 S5).
 *
 * The two failure classes the issue names by scenario:
 *   1. A FIRST ASSISTANT TURN immediately after setup's Continue, before the
 *      skill sync caught up → `anthropic_skill_not_synced` with transient
 *      "wait a moment" copy plus the Administration pointer.
 *   2. An explicit `function-tools` MCP-mode REMNANT → the mode-rejection
 *      codes with copy naming the setting and where to fix it.
 * Plus: recognition is CROSS-REALM (by `.code`, never instanceof), the
 * fallback is sanitized + bounded, and no classified message ever forwards a
 * credential-bearing raw provider message.
 */
import { describe, it, expect } from "vitest";

// The domain error classes live in `@cinatra-ai/llm` — whose root barrel is
// stubbed in the root vitest sandbox — and in CONNECTOR-REALM copies at run
// time. Recognition is BY `.code` (never instanceof), so these fixtures build
// code-carrying errors exactly the way a realm-crossed instance presents.
import { AnthropicSkillNotSyncedError } from "../../../../packages/llm/src/errors";

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

import {
  ASSISTANT_RUN_FAILED_CODE,
  classifyAssistantRuntimeError,
  sanitizeAssistantErrorText,
} from "@/lib/assistant-runtime/ports";

describe("classifyAssistantRuntimeError — the S5 scenarios", () => {
  it("NOT-YET-SYNCED SKILLS (first turn right after Continue): stable code + transient guidance + Administration pointer", () => {
    const classified = classifyAssistantRuntimeError(
      new AnthropicSkillNotSyncedError(["skill_a", "skill_b"]),
    );
    expect(classified.code).toBe("anthropic_skill_not_synced");
    expect(classified.message).toContain("first turn right after setup");
    expect(classified.message).toContain("/configuration/llm");
    // Actionable copy, not the raw enumerated internals.
    expect(classified.message).not.toContain("skill_a");
  });

  it("MCP-MODE REMNANT (function-tools): the forbidden-vehicle throw carries the mode remedy", () => {
    const classified = classifyAssistantRuntimeError(
      codedError(
        "anthropic_function_tool_skill_forbidden",
        "Anthropic skill delivery via function tools is forbidden. Offending tool: skill_exec.",
      ),
    );
    expect(classified.code).toBe("anthropic_function_tool_skill_forbidden");
    expect(classified.message).toContain("native MCP");
    expect(classified.message).toContain("/configuration/llm");
    expect(classified.message).not.toContain("skill_exec");
  });

  it("NATIVE-MCP REFUSAL: the ruled copy, verbatim, under its own code (cross-realm by .code)", () => {
    // The class itself is not re-exported from the package root — recognition
    // is by `.code`, which is exactly how it crosses module realms.
    //
    // cinatra#2776: chat + widget turns PIN `native_mcp` whenever they carry
    // the self-MCP toolbox, so this is no longer only the skill-delivery
    // remnant's twin — it is the refusal a person reads when the connector
    // cannot deliver that catalog as one hosted MCP reference. The ruled text
    // is asserted verbatim, not by fragment, because it IS the contract.
    const err = Object.assign(new Error("native MCP path failed"), {
      code: "native_mcp_capability_required",
    });
    const classified = classifyAssistantRuntimeError(err);
    expect(classified.code).toBe("native_mcp_capability_required");
    expect(classified.message).toBe(
      "This chat requires Anthropic native MCP, but the connector is configured " +
        "for function-tools or the native MCP request failed. Switch the Anthropic " +
        "MCP mode to native or re-run AI setup, then retry.",
    );
    // The raw provider/internal text never reaches the person.
    expect(classified.message).not.toContain("native MCP path failed");
  });

  it("recognizes CROSS-REALM copies by `.code`, never instanceof", () => {
    // A connector-realm copy: plain object carrying the domain code.
    const foreign = Object.assign(new Error("realm-crossed"), {
      code: "anthropic_skill_not_synced",
    });
    expect(classifyAssistantRuntimeError(foreign).code).toBe("anthropic_skill_not_synced");
  });

  it("the skill cap gets actionable copy naming the limit", () => {
    const classified = classifyAssistantRuntimeError(
      codedError("anthropic_skill_cap_exceeded", "11 skills were mapped: a, b"),
    );
    expect(classified.code).toBe("anthropic_skill_cap_exceeded");
    expect(classified.message).toContain("8");
  });

  it("the bound-default provider outage keeps its provider-naming copy under a stable code", () => {
    const err = Object.assign(
      new Error('The configured default LLM provider "anthropic" is not available.'),
      { name: "BoundDefaultProviderUnavailableError" },
    );
    const classified = classifyAssistantRuntimeError(err);
    expect(classified.code).toBe("default_provider_unavailable");
    expect(classified.message).toContain("anthropic");
    expect(classified.message).toContain("/configuration/llm");
  });

  it("the FALLBACK sanitizes: a raw provider message echoing a key never survives", () => {
    const classified = classifyAssistantRuntimeError(
      new Error("upstream 401 for x-api-key: sk-ant-SECRETVALUE0123456789"),
    );
    expect(classified.code).toBe(ASSISTANT_RUN_FAILED_CODE);
    expect(classified.message).not.toContain("SECRETVALUE");
    expect(classified.message).toContain("[redacted]");
  });

  it("the FALLBACK bounds unbounded text and survives non-Error throws", () => {
    const classified = classifyAssistantRuntimeError("x".repeat(5000));
    expect(classified.code).toBe(ASSISTANT_RUN_FAILED_CODE);
    expect(classified.message.length).toBeLessThanOrEqual(400);
    expect(classifyAssistantRuntimeError(null).message.length).toBeGreaterThan(0);
    expect(classifyAssistantRuntimeError(undefined).message.length).toBeGreaterThan(0);
  });
});

describe("sanitizeAssistantErrorText", () => {
  it("redacts every key shape and collapses whitespace", () => {
    const raw =
      "authorization: Bearer abc  \n sk-ant-SECRET0123456789 sk-LONGOPENAIKEY0123456789 AIzaSyFAKE-KEY ya29.token";
    const clean = sanitizeAssistantErrorText(raw);
    expect(clean).not.toContain("SECRET0123456789");
    expect(clean).not.toContain("LONGOPENAIKEY");
    expect(clean).not.toContain("AIzaSyFAKE-KEY");
    expect(clean).not.toContain("ya29.token");
    expect(clean).not.toContain("\n");
  });
});
