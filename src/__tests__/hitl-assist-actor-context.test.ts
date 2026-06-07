/**
 * hitl-assist-actor-context regression test.
 *
 * Root cause: POST /api/agents/builder/[templateId]/hitl-assist calls
 * generate without passing actorContext. requireActorFrame is a
 * fail-closed gate, so the call throws ACTOR_CONTEXT_MISSING, which the route's
 * catch block swallows as { suggestions: {} }. The client sees empty
 * suggestions and fires the "No suggestions generated." toast error.
 *
 * The route must pass actorContext so the client receives generated suggestions
 * instead of the empty fallback.
 *
 * Run:
 *   pnpm exec vitest run --reporter=verbose src/__tests__/hitl-assist-actor-context.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";

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
vi.mock("@cinatra/agent-builder", () => ({
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

const FAKE_SESSION = { user: { id: "admin-1", role: "admin" }, session: { activeOrganizationId: undefined } };
const FAKE_ACTOR_CONTEXT: ActorContext = {
  principalType: "HumanUser",
  principalId: "admin-1",
  platformRole: "platform_admin",
  orgRole: "member",
  authSource: "ui",
  policyVersion: "v2",
};

describe("POST /api/agents/builder/[templateId]/hitl-assist actorContext gate", () => {
  beforeEach(() => {
    orchestrateGenerateMock.mockReset();
    readAgentTemplateByIdMock.mockReset();
    requireAdminSessionMock.mockReset();
    buildActorContextMock.mockReset();

    requireAdminSessionMock.mockResolvedValue(FAKE_SESSION);
    buildActorContextMock.mockReturnValue(FAKE_ACTOR_CONTEXT);
    readAgentTemplateByIdMock.mockResolvedValue({
      id: "tpl-1",
      hitlScreens: ["@cinatra-ai/email-drafting-agent:output"],
    });
    orchestrateGenerateMock.mockResolvedValue({
      text: '{"suggestions":{"subject":"Hello world"},"message":"Filled subject."}',
      status: "ok",
      incompleteReason: null,
      rawBody: "{}",
    });
  });

  it("passes actorContext to generate so the fail-closed actor gate is satisfied", async () => {
    const req = new Request(
      "http://localhost/api/agents/builder/tpl-1/hitl-assist",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "fill with sample values",
          xRenderer: "@cinatra-ai/email-drafting-agent:output",
          currentValue: { subject: "" },
          schemaProperties: ["subject", "body"],
        }),
      },
    );

    const res = await POST(req as never, {
      params: Promise.resolve({ templateId: "tpl-1" }),
    } as never);

    // The route must call generate (not silently fail).
    expect(orchestrateGenerateMock).toHaveBeenCalledTimes(1);

    // The call must include a non-null actorContext so requireActorFrame
    // can establish an ALS frame without throwing ACTOR_CONTEXT_MISSING.
    const call = orchestrateGenerateMock.mock.calls[0][0];
    expect(call.actorContext).toBeDefined();
    expect(call.actorContext).toEqual(FAKE_ACTOR_CONTEXT);

    // The response must contain real suggestions (not empty {}).
    const json = await res.json() as { suggestions?: Record<string, unknown>; message?: string };
    expect(Object.keys(json.suggestions ?? {})).toHaveLength(1);
    expect(json.suggestions?.subject).toBe("Hello world");
  });

  it("returns { suggestions: {} } and does NOT call generate when admin session is missing", async () => {
    requireAdminSessionMock.mockRejectedValue(new Error("Not authorized"));

    const req = new Request(
      "http://localhost/api/agents/builder/tpl-1/hitl-assist",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "fill with sample values",
          xRenderer: "@cinatra-ai/email-drafting-agent:output",
          currentValue: {},
          schemaProperties: ["subject"],
        }),
      },
    );

    const res = await POST(req as never, {
      params: Promise.resolve({ templateId: "tpl-1" }),
    } as never);

    expect(res.status).toBe(401);
    expect(orchestrateGenerateMock).not.toHaveBeenCalled();
  });
});
