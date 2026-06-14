/**
 * `resolveAgentCreationDispatch` tests.
 *
 * Verifies:
 *   - INACTIVE pin → provider openai + the operator-configured OpenAI default
 *     model (canonical DEFAULT_OPENAI_MODEL_ID "gpt-5.5" fallback, never base
 *     gpt-5).
 *   - ACTIVE pin → admin-configured provider/model.
 *   - ACTIVE pin on Anthropic ALWAYS uses skill-aware path:
 *     even when caller has no skill ids, the routing-to-skill-aware ensures
 *     the SkillDeliveryAdapter seam is consulted — function-tool fallback
 *     prevention).
 *   - Throws `AgentCreationPinConfigError` on misconfigured pin.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks for the dynamic-import target. `readOpenAIConnectionFromDatabase`
// mirrors the real app-layer getter: a stored `defaultModel` wins, else the
// canonical `DEFAULT_OPENAI_MODEL_ID` fallback. Default mock returns the
// canonical fallback so the INACTIVE-pin default is the canonical model.
const dbMock = vi.hoisted(() => ({
  isAgentCreationPinActive: vi.fn(() => false),
  readAgentCreationLlmProviderFromDatabase: vi.fn(() => null as string | null),
  readAgentCreationModelFromDatabase: vi.fn(() => null as string | null),
  readOpenAIConnectionFromDatabase: vi.fn(() => ({ defaultModel: "gpt-5.5" })),
}));
vi.mock("@/lib/database", () => dbMock);

import {
  resolveAgentCreationDispatch,
  AgentCreationPinConfigError,
} from "../resolve-agent-creation-dispatch";
import { DEFAULT_OPENAI_MODEL_ID } from "../llm-provider-policy";

describe("resolveAgentCreationDispatch — pin INACTIVE default", () => {
  beforeEach(() => {
    dbMock.isAgentCreationPinActive.mockReturnValue(false);
    dbMock.readAgentCreationLlmProviderFromDatabase.mockReturnValue(null);
    dbMock.readAgentCreationModelFromDatabase.mockReturnValue(null);
    // Out-of-box: no stored openai_connection.defaultModel ⇒ canonical fallback.
    dbMock.readOpenAIConnectionFromDatabase.mockReturnValue({
      defaultModel: DEFAULT_OPENAI_MODEL_ID,
    });
  });

  it("returns openai + canonical default (gpt-5.5, NOT base gpt-5) with useSkillAware=true when hasSkillIds=true", async () => {
    const result = await resolveAgentCreationDispatch({ hasSkillIds: true });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.5");
    expect(result.model).toBe(DEFAULT_OPENAI_MODEL_ID);
    expect(result.model).not.toBe("gpt-5");
    expect(result.useSkillAware).toBe(true);
  });

  it("returns openai + canonical default with useSkillAware=false when hasSkillIds=false", async () => {
    const result = await resolveAgentCreationDispatch({ hasSkillIds: false });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.5");
    expect(result.useSkillAware).toBe(false);
  });

  it("HONORS the operator-configured OpenAI default model when one is stored", async () => {
    // /setup/ai + /configuration/llm persist openai_connection.defaultModel;
    // the inactive-pin dispatch must use it verbatim, never base gpt-5.
    dbMock.readOpenAIConnectionFromDatabase.mockReturnValue({ defaultModel: "gpt-5.4" });
    const result = await resolveAgentCreationDispatch({ hasSkillIds: true });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4");
  });

  it("FALLS BACK to the canonical default (NOT base gpt-5) when the connection read throws (e.g. DB unavailable)", async () => {
    // This path previously read no config and never threw. Reading the
    // configured default can now throw; a throw must still resolve to the
    // canonical default, never base gpt-5.
    dbMock.readOpenAIConnectionFromDatabase.mockImplementation(() => {
      throw new Error("postgres unavailable");
    });
    const result = await resolveAgentCreationDispatch({ hasSkillIds: true });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe(DEFAULT_OPENAI_MODEL_ID);
    expect(result.model).toBe("gpt-5.5");
    expect(result.model).not.toBe("gpt-5");
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
