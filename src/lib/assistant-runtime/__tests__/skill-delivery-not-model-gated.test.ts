// cinatra#2094 finding F11 — chat skill delivery is NOT model-gated, and a
// delivery that produces no vehicle is LOUD.
//
// THE DEFECT THIS PINS: the runtime used to consult a caller-side gate
// (`src/app/api/chat/shell-skill-gate.ts`) and, for a hosted-shell-incompatible
// OpenAI model, SKIP the delivery seam entirely — shipping the turn with ZERO
// skills behind a `console.warn`. That was a silent no-delivery on a
// configuration the wizard's own free-text model input can produce, and it was
// unnecessary: the provider adapter already degrades such a request to the
// restricted NAMED `skill_file_read` function tool (exec-plane S2's
// singular-native-shell rule, cinatra#1707), so no `type:"shell"` could reach the
// model in the first place.
//
// Two properties are asserted here:
//   1. the delivery seam runs for EVERY model, including gpt-5 / gpt-5-mini, and
//      its tools reach `stream()`;
//   2. a delivery that yields neither a tool nor a system-context fragment
//      REFUSES the turn (an `error` event, no `stream()` call) instead of
//      answering as a silently skill-less assistant.
//
// The heavy import graph is mocked exactly as in `cinatra-parity.test.ts`; only
// the resolved model and the delivery result vary per case.

import { describe, expect, it, vi, beforeEach } from "vitest";

let capturedStreamInput: Record<string, unknown> | null = null;

/** Mutable per-case knobs (hoisted so the vi.mock factories can read them). */
const state = vi.hoisted(() => ({
  defaultModel: "gpt-5-mini",
  deliveryResult: {
    tools: [{ type: "function", name: "skill_file_read" }] as Array<Record<string, unknown>>,
    systemContext: "SKILLS_CUE",
  },
  deliverCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/register-host-connector-services", () => ({}));
vi.mock("@/app/api/chat/explicit-dispatch", () => ({
  detectExplicitDispatchDirective: () => "",
  detectExplicitDispatchPackage: () => null,
}));
vi.mock("@/app/api/chat/explicit-dispatch-server", () => ({
  serverSideExplicitDispatch: vi.fn(),
}));
vi.mock("@/app/api/chat/chat-user-context", () => ({
  buildChatUserContextSections: vi.fn(async () => []),
}));
vi.mock("@/app/api/chat/extension-confirmation", () => ({
  buildExtensionImplementationConfirmationPolicy: () => "",
}));
vi.mock("@cinatra-ai/skills/mcp-client", () => ({
  createDeterministicSkillsClient: () => ({
    installed: { get: async () => ({ body: "SYSTEM" }) },
  }),
}));
vi.mock("@cinatra-ai/skills", () => ({
  ensureInstalledSkillsRegistered: vi.fn(async () => undefined),
  resolveInstalledSkillSourcePath: vi.fn(async () => null),
  retireSupersededChatSkillsOnce: vi.fn(async () => undefined),
}));
vi.mock("@/lib/wizard-staging-store", () => ({ getAllStagedByType: () => [] }));
vi.mock("@/lib/wizard-manifest-registry", () => ({ getAllManifests: vi.fn(async () => []) }));
vi.mock("@/lib/chat-mcp-actor-token", () => ({ issueChatMcpActorToken: vi.fn() }));
vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: () => null }));
vi.mock("@/lib/artifacts/attachment-resolver-ports", () => ({
  buildAttachmentResolverPorts: vi.fn(() => ({})),
}));
vi.mock("@cinatra-ai/llm", () => ({
  hasConfiguredLlmRuntime: vi.fn(async () => true),
  checkPublicMcpReachability: vi.fn(async () => ({
    status: "reachable",
    url: "https://mcp.example.test/api/mcp",
  })),
  resolveDefaultAdapter: vi.fn(async () => ({
    provider: "openai",
    defaultModel: state.defaultModel,
  })),
  resolveBoundDefaultAdapter: vi.fn(async () => ({
    provider: "openai",
    defaultModel: state.defaultModel,
  })),
  BoundDefaultProviderUnavailableError: class extends Error {},
  selectSkillDeliveryAdapter: vi.fn(() => ({
    provider: "openai",
    deliver: vi.fn(async (input: Record<string, unknown>) => {
      state.deliverCalls.push(input);
      return { ...state.deliveryResult, exposure: [] };
    }),
  })),
  resolveChatExternalMcpTools: vi.fn(async () => []),
  buildLlmMcpServerToolForChat: vi.fn(async () => ({
    type: "mcp",
    name: "cinatra",
    serverLabel: "cinatra",
  })),
  stream: vi.fn(async (input: Record<string, unknown>) => {
    capturedStreamInput = input;
    (input.onTextDelta as (d: string) => void)?.("Hi");
  }),
}));

import { runAssistantTurn } from "../runtime";
import { buildCinatraAssistantRuntimeConfig } from "../cinatra-assistant-config";

function makeArgs(send: (event: string, data: unknown) => void) {
  return {
    messages: [{ role: "user" as const, content: "hi" }],
    actorContext: { actorType: "user", userId: "u1" } as never,
    userId: "u1",
    platformRole: "member" as const,
    sessionOrgId: null,
    send,
  };
}

beforeEach(() => {
  capturedStreamInput = null;
  state.deliverCalls = [];
  state.defaultModel = "gpt-5-mini";
  state.deliveryResult = {
    tools: [{ type: "function", name: "skill_file_read" }],
    systemContext: "SKILLS_CUE",
  };
});

describe("chat skill delivery is not gated on the resolved model", () => {
  // Each of these previously produced ZERO delivery: `openAiModelSupportsShell`
  // returns false for them, and the retired gate short-circuited the seam.
  for (const model of ["gpt-5", "gpt-5-mini"]) {
    it(`invokes the delivery seam on the shell-incompatible model "${model}"`, async () => {
      state.defaultModel = model;
      const send = vi.fn();
      await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

      expect(state.deliverCalls).toHaveLength(1);
      expect((state.deliverCalls[0].skillIds as string[]).length).toBeGreaterThan(0);
      expect(state.deliverCalls[0].selectionMode).toBe("general");

      const tools = capturedStreamInput!.tools as Array<Record<string, unknown>>;
      expect(tools.some((t) => t.name === "skill_file_read")).toBe(true);
      expect(send).not.toHaveBeenCalledWith("error", expect.anything());
    });
  }

  it("still delivers on a shell-CAPABLE model (no behaviour change there)", async () => {
    state.defaultModel = "gpt-5.5";
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    expect(state.deliverCalls).toHaveLength(1);
    const tools = capturedStreamInput!.tools as Array<Record<string, unknown>>;
    expect(tools.some((t) => t.name === "skill_file_read")).toBe(true);
  });

  it("carries the delivery's system-context fragment into the system prompt", async () => {
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    expect(capturedStreamInput!.system as string).toContain("SKILLS_CUE");
  });
});

describe("a no-vehicle delivery is LOUD, never a silent skill-less turn", () => {
  it("emits an error naming the provider + model and never calls stream()", async () => {
    state.deliveryResult = { tools: [], systemContext: "" };
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    expect(capturedStreamInput).toBeNull();
    const errorCall = send.mock.calls.find((c) => c[0] === "error");
    expect(errorCall).toBeDefined();
    const message = (errorCall![1] as { message: string }).message;
    expect(message).toContain("openai");
    expect(message).toContain("gpt-5-mini");
    expect(send).not.toHaveBeenCalledWith("done", {});
  });

  it("a delivery with NO tools but a system-context fragment is a VALID inline-style delivery", async () => {
    // Not every mechanism is a tool: a provider whose vehicle is the prompt
    // still delivered. Only "no vehicle at all" is the forbidden outcome.
    state.deliveryResult = { tools: [], systemContext: "SKILLS_CUE" };
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    expect(capturedStreamInput).not.toBeNull();
    expect(capturedStreamInput!.system as string).toContain("SKILLS_CUE");
    expect(send).not.toHaveBeenCalledWith("error", expect.anything());
  });
});
