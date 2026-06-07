/**
 * Verifies that POST /api/agents/builder/[templateId]/hitl-assist threads
 * `lastAssistantMessage` into `generate({ messages: [...] })` as
 * a real assistant turn, instead of concatenating it as a
 * "Previous assistant reply:\n..." string prefix.
 *
 * Tests also cover trim normalization:
 *   - whitespace-only input -> messages: undefined (no meaningless turn).
 *   - leading/trailing whitespace -> trimmed content threaded.
 *
 * Run:
 *   pnpm vitest run --reporter=verbose src/__tests__/hitl-assist-multi-turn.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  orchestrateGenerateMock,
  readAgentTemplateByIdMock,
  requireAdminSessionMock,
  buildActorContextMock,
} = vi.hoisted(() => ({
  orchestrateGenerateMock: vi.fn(),
  readAgentTemplateByIdMock: vi.fn(),
  requireAdminSessionMock: vi.fn(),
  buildActorContextMock: vi.fn(),
}));

vi.mock("@cinatra-ai/llm", () => ({
  generate: orchestrateGenerateMock,
}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentTemplateById: readAgentTemplateByIdMock,
}));
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: requireAdminSessionMock,
}));
vi.mock("@/lib/authz/enforce", () => ({
  buildActorContext: buildActorContextMock,
}));

// Import AFTER mocks are registered.
import { POST } from "../app/api/agents/builder/[templateId]/hitl-assist/route";

describe("POST /api/agents/builder/[templateId]/hitl-assist — multi-turn context", () => {
  beforeEach(() => {
    orchestrateGenerateMock.mockReset();
    readAgentTemplateByIdMock.mockReset();
    requireAdminSessionMock.mockReset();
    buildActorContextMock.mockReset();

    // Default: admin session OK.
    requireAdminSessionMock.mockResolvedValue({ user: { id: "admin-1" } });
    // Default: actorContext built so generate's fail-closed actor gate passes.
    buildActorContextMock.mockReturnValue({
      principalType: "HumanUser",
      principalId: "admin-1",
      platformRole: "platform_admin",
      orgRole: "member",
      authSource: "ui",
      policyVersion: "v2",
    });
    // Default: template exists with one HITL screen so editableFields can resolve.
    readAgentTemplateByIdMock.mockResolvedValue({
      id: "tpl-1",
      hitlScreens: ["@cinatra-ai/email-drafting-agent:output"],
    });
    // Default: generate returns valid empty JSON.
    orchestrateGenerateMock.mockResolvedValue({
      text: "{}",
      status: "ok",
      incompleteReason: null,
      rawBody: "{}",
    });
  });

  it("threads lastAssistantMessage as an assistant turn when supplied", async () => {
    const req = new Request(
      "http://localhost/api/agents/builder/tpl-1/hitl-assist",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "use those",
          xRenderer: "@cinatra-ai/email-drafting-agent:output",
          currentValue: { subject: "" },
          schemaProperties: ["subject", "body"],
          lastAssistantMessage: "Subject: Hello",
        }),
      },
    );

    await POST(req as never, {
      params: Promise.resolve({ templateId: "tpl-1" }),
    } as never);

    expect(orchestrateGenerateMock).toHaveBeenCalledTimes(1);
    const call = orchestrateGenerateMock.mock.calls[0][0];
    expect(call.messages).toEqual([
      { role: "assistant", content: "Subject: Hello" },
    ]);
  });

  it("passes messages: undefined AND no 'Previous assistant reply:' prefix when lastAssistantMessage is absent", async () => {
    const req = new Request(
      "http://localhost/api/agents/builder/tpl-1/hitl-assist",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "draft me one",
          xRenderer: "@cinatra-ai/email-drafting-agent:output",
          currentValue: { subject: "" },
          schemaProperties: ["subject", "body"],
        }),
      },
    );

    await POST(req as never, {
      params: Promise.resolve({ templateId: "tpl-1" }),
    } as never);

    expect(orchestrateGenerateMock).toHaveBeenCalledTimes(1);
    const call = orchestrateGenerateMock.mock.calls[0][0];
    // Assert messages is explicitly undefined and the prompt does not contain
    // the assistant-reply prefix. Both must hold for this branch to pass.
    expect(call.messages).toBeUndefined();
    expect(call.prompt).not.toContain("Previous assistant reply:");
    // The structured field must be passed even as undefined so downstream
    // `messages !== undefined` checks behave consistently.
    expect("messages" in call).toBe(true);
  });

  it("does NOT include the 'Previous assistant reply:' string prefix in the user prompt", async () => {
    const req = new Request(
      "http://localhost/api/agents/builder/tpl-1/hitl-assist",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "use those",
          xRenderer: "@cinatra-ai/email-drafting-agent:output",
          currentValue: { subject: "" },
          schemaProperties: ["subject", "body"],
          lastAssistantMessage: "Subject: Hello",
        }),
      },
    );

    await POST(req as never, {
      params: Promise.resolve({ templateId: "tpl-1" }),
    } as never);

    const call = orchestrateGenerateMock.mock.calls[0][0];
    expect(call.prompt).not.toContain("Previous assistant reply:");
  });

  it("treats whitespace-only lastAssistantMessage as absent", async () => {
    const req = new Request(
      "http://localhost/api/agents/builder/tpl-1/hitl-assist",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "draft me one",
          xRenderer: "@cinatra-ai/email-drafting-agent:output",
          currentValue: { subject: "" },
          schemaProperties: ["subject", "body"],
          // Whitespace-only should normalize to null -> messages: undefined.
          lastAssistantMessage: " \n\t ",
        }),
      },
    );

    await POST(req as never, {
      params: Promise.resolve({ templateId: "tpl-1" }),
    } as never);

    expect(orchestrateGenerateMock).toHaveBeenCalledTimes(1);
    const call = orchestrateGenerateMock.mock.calls[0][0];
    // After trim -> empty string -> falsy -> null -> messages: undefined.
    expect(call.messages).toBeUndefined();
  });

  it("trims leading/trailing whitespace from lastAssistantMessage before threading", async () => {
    const req = new Request(
      "http://localhost/api/agents/builder/tpl-1/hitl-assist",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "use those",
          xRenderer: "@cinatra-ai/email-drafting-agent:output",
          currentValue: { subject: "" },
          schemaProperties: ["subject", "body"],
          // Leading/trailing whitespace must be trimmed.
          lastAssistantMessage: "  Subject: Hello\n  ",
        }),
      },
    );

    await POST(req as never, {
      params: Promise.resolve({ templateId: "tpl-1" }),
    } as never);

    expect(orchestrateGenerateMock).toHaveBeenCalledTimes(1);
    const call = orchestrateGenerateMock.mock.calls[0][0];
    // The content must be the trimmed value, not the raw padded string.
    expect(call.messages).toEqual([
      { role: "assistant", content: "Subject: Hello" },
    ]);
  });
});
