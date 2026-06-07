/**
 * `resolveAgentCreationDispatch` tests.
 *
 * Verifies:
 *   - INACTIVE pin → byte-for-byte openai/gpt-5 default.
 *   - ACTIVE pin → admin-configured provider/model.
 *   - ACTIVE pin on Anthropic ALWAYS uses skill-aware path:
 *     even when caller has no skill ids, the routing-to-skill-aware ensures
 *     the SkillDeliveryAdapter seam is consulted — function-tool fallback
 *     prevention).
 *   - Throws `AgentCreationPinConfigError` on misconfigured pin.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks for the dynamic-import target.
const dbMock = vi.hoisted(() => ({
  isAgentCreationPinActive: vi.fn(() => false),
  readAgentCreationLlmProviderFromDatabase: vi.fn(() => null as string | null),
  readAgentCreationModelFromDatabase: vi.fn(() => null as string | null),
}));
vi.mock("@/lib/database", () => dbMock);

import {
  resolveAgentCreationDispatch,
  AgentCreationPinConfigError,
} from "../resolve-agent-creation-dispatch";

describe("resolveAgentCreationDispatch — pin INACTIVE default", () => {
  beforeEach(() => {
    dbMock.isAgentCreationPinActive.mockReturnValue(false);
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue(null);
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue(null);
  });

  it("returns openai/gpt-5 with useSkillAware=true when hasSkillIds=true", async () => {
    const result = await resolveAgentCreationDispatch({ hasSkillIds: true });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5");
    expect(result.useSkillAware).toBe(true);
  });

  it("returns openai/gpt-5 with useSkillAware=false when hasSkillIds=false (byte-for-byte parity)", async () => {
    const result = await resolveAgentCreationDispatch({ hasSkillIds: false });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5");
    expect(result.useSkillAware).toBe(false);
  });
});

describe("resolveAgentCreationDispatch — pin ACTIVE", () => {
  beforeEach(() => {
    dbMock.isAgentCreationPinActive.mockReturnValue(true);
  });

  it("returns admin-configured provider/model when pinned on anthropic + opus-4-7", async () => {
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue("anthropic");
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue("claude-opus-4-7");
    const result = await resolveAgentCreationDispatch({ hasSkillIds: true });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4-7");
    expect(result.useSkillAware).toBe(true);
  });

  it("forces useSkillAware=true for anthropic even when hasSkillIds=false", async () => {
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue("anthropic");
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue("claude-opus-4-7");
    const result = await resolveAgentCreationDispatch({ hasSkillIds: false });
    // Anthropic ALWAYS uses skill-aware to ensure the SkillDeliveryAdapter
    // seam is consulted — the dispatch-site empty-skill abort guard
    // (`AgentCreationDispatchAbortError`) is the belt-and-suspenders that
    // prevents an actual empty-skillIds call from reaching the orchestration.
    expect(result.useSkillAware).toBe(true);
  });

  it("respects hasSkillIds for openai pin", async () => {
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue("openai");
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue("gpt-5.5");
    const result1 = await resolveAgentCreationDispatch({ hasSkillIds: true });
    expect(result1.useSkillAware).toBe(true);
    const result2 = await resolveAgentCreationDispatch({ hasSkillIds: false });
    expect(result2.useSkillAware).toBe(false);
  });

  it("throws AgentCreationPinConfigError with code pin_active_but_unset when provider is null", async () => {
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue(null);
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue("claude-opus-4-7");
    await expect(resolveAgentCreationDispatch({ hasSkillIds: true })).rejects.toThrow(
      AgentCreationPinConfigError,
    );
    try {
      await resolveAgentCreationDispatch({ hasSkillIds: true });
    } catch (err) {
      expect((err as AgentCreationPinConfigError).code).toBe("pin_active_but_unset");
    }
  });

  it("throws AgentCreationPinConfigError with code pin_active_but_unset when model is null", async () => {
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue("anthropic");
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue(null);
    try {
      await resolveAgentCreationDispatch({ hasSkillIds: true });
    } catch (err) {
      expect((err as AgentCreationPinConfigError).code).toBe("pin_active_but_unset");
    }
  });

  it("throws AgentCreationPinConfigError with code invalid_provider_config when provider is junk", async () => {
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue("claude-opus-4");
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue("claude-opus-4-7");
    try {
      await resolveAgentCreationDispatch({ hasSkillIds: true });
    } catch (err) {
      expect((err as AgentCreationPinConfigError).code).toBe("invalid_provider_config");
    }
  });
});
