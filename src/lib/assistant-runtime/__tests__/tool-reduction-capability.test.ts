// Exercise the shipped runtime at its LLM stream boundary. Only the adapter
// transport and unrelated I/O are replaced; capability decisions stay in runtime.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamInput } from "@cinatra-ai/sdk-extensions/llm-provider-adapter-contract";

let adapterScript: (input: StreamInput) => void = () => {};
let capturedInput: StreamInput | undefined;
const state = vi.hoisted(() => ({ provider: "openai" as "openai" | "gemini" }));
const SYSTEM_BODY = "SYSTEM_PROMPT_BODY";
const CONFIRMATION_POLICY = "\n\nCONFIRMATION_POLICY";

vi.mock("@/lib/register-host-connector-services", () => ({}));
vi.mock("@/lib/assistant-assigned-skills-delivery", () => ({
  resolveAssistantAssignedSkillIds: vi.fn(async () => []),
}));
vi.mock("@/app/api/chat/chat-user-context", () => ({
  buildChatUserContextSections: vi.fn(async () => []),
}));
vi.mock("@/app/api/chat/extension-confirmation", () => ({
  buildExtensionImplementationConfirmationPolicy: () => CONFIRMATION_POLICY,
}));
vi.mock("@cinatra-ai/skills/mcp-client", () => ({
  createDeterministicSkillsClient: () => ({
    installed: { get: async () => ({ body: SYSTEM_BODY }) },
  }),
}));
vi.mock("@cinatra-ai/skills", () => ({
  ensureInstalledSkillsRegistered: vi.fn(async () => undefined),
  resolveInstalledSkillSourcePath: vi.fn(async () => null),
  retireSupersededChatSkillsOnce: vi.fn(async () => undefined),
}));
vi.mock("@/lib/wizard-staging-store", () => ({ getAllStagedByType: () => [] }));
vi.mock("@/lib/wizard-manifest-registry", () => ({
  getAllManifests: vi.fn(async () => []),
}));
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
  resolveDefaultAdapter: vi.fn(async () => ({ provider: state.provider, defaultModel: "test-model" })),
  resolveBoundDefaultAdapter: vi.fn(async () => ({ provider: state.provider, defaultModel: "test-model" })),
  BoundDefaultProviderUnavailableError: class extends Error {},
  deliverInjectedSkillsInline: vi.fn(async () => ({ systemContext: "", exposure: [], dropped: [] })),
  selectSkillDeliveryAdapter: vi.fn(() => ({
    provider: "openai",
    deliver: vi.fn(async () => ({
      tools: [{ type: "function", name: "shell" }],
      systemContext: "",
      exposure: [],
    })),
  })),
  resolveChatExternalMcpTools: vi.fn(async () => [
    { type: "mcp", serverLabel: "external", serverUrl: "https://external.example.test/mcp" },
  ]),
  buildLlmMcpServerToolForChat: vi.fn(async () => ({
    type: "mcp",
    name: "cinatra",
    serverLabel: "owned-platform-label",
  })),
  stream: vi.fn(async (input: StreamInput) => {
    capturedInput = input;
    adapterScript(input);
  }),
}));

import { runAssistantTurn } from "../runtime";
import { buildCinatraAssistantRuntimeConfig } from "../cinatra-assistant-config";

async function runTurn() {
  const send = vi.fn();
  await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), {
    messages: [{ role: "user", content: "Read this run" }],
    actorContext: { actorType: "user", userId: "u1" } as never,
    userId: "u1",
    platformRole: "member",
    sessionOrgId: null,
    send,
    turnIdentity: { turnId: "turn-tools-reduced", runId: "run-tools-reduced" },
  });
  return send;
}

function lossFrames(send: Awaited<ReturnType<typeof runTurn>>) {
  return send.mock.calls.filter(([event, data]) =>
    event === "turn_capability" && data.platformToolsUnavailable === true,
  );
}

beforeEach(() => {
  adapterScript = () => {};
  capturedInput = undefined;
  state.provider = "openai";
});

describe("adapter tool loss uses the runtime's own platform identity", () => {
  it("reports platform loss once, before retry text, without claiming conversation-only", async () => {
    adapterScript = (input) => {
      input.onToolsReduced?.({ removed: [{ type: "mcp", serverLabel: "owned-platform-label" }] });
      input.onToolsReduced?.({ removed: [{ type: "mcp", serverLabel: "owned-platform-label" }] });
      input.onTextDelta("The retry returned text");
    };
    const send = await runTurn();
    expect(capturedInput?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "mcp", serverLabel: "owned-platform-label" }),
    ]));
    expect(lossFrames(send)).toEqual([["turn_capability", { platformToolsUnavailable: true }]]);
    expect(send.mock.calls.findIndex(([event, data]) => event === "turn_capability" && data.platformToolsUnavailable))
      .toBeLessThan(send.mock.calls.findIndex(([event]) => event === "text"));
    expect(send).toHaveBeenCalledWith("turn_capability", { conversationOnly: false });
    expect(send).not.toHaveBeenCalledWith("turn_capability", { conversationOnly: true });
  });

  it.each([
    { removed: [{ type: "mcp" as const, serverLabel: "external" }] },
    { removed: [{ type: "mcp" as const, serverLabel: "cinatra" }] },
    { removed: [{ type: "mcp" as const, serverLabel: "owned_platform_label" }] },
    { removed: [{ type: "function" as const, name: "owned-platform-label" }] },
    { removed: [{ type: "web_search" as const }] },
    { removed: [] },
  ])("does not confuse unrelated reductions with platform loss: %j", async ({ removed }) => {
    adapterScript = (input) => {
      input.onToolsReduced?.({ removed });
      input.onTextDelta("The answer still succeeds");
    };
    const send = await runTurn();
    expect(lossFrames(send)).toEqual([]);
    expect(send).toHaveBeenCalledWith("text", { content: "The answer still succeeds" });
  });

  it("can report the platform loss after an earlier unrelated reduction", async () => {
    adapterScript = (input) => {
      input.onToolsReduced?.({ removed: [{ type: "mcp", serverLabel: "external" }] });
      input.onToolsReduced?.({ removed: [{ type: "mcp", serverLabel: "owned-platform-label" }] });
    };
    expect(lossFrames(await runTurn())).toHaveLength(1);
  });

  it("keeps adapters that omit the optional notification unchanged", async () => {
    adapterScript = (input) => input.onTextDelta("Ordinary answer");
    const send = await runTurn();
    expect(lossFrames(send)).toEqual([]);
    expect(send).toHaveBeenCalledWith("text", { content: "Ordinary answer" });
    expect(send.mock.calls.filter(([event]) => event === "done")).toHaveLength(1);
  });

  it("preserves the existing error events when the reduced attempt fails", async () => {
    adapterScript = (input) => input.onError(new Error("Retry failed"));
    const ordinary = await runTurn();
    adapterScript = (input) => {
      input.onToolsReduced?.({ removed: [{ type: "mcp", serverLabel: "owned-platform-label" }] });
      input.onError(new Error("Retry failed"));
    };
    const reduced = await runTurn();
    expect(lossFrames(reduced)).toHaveLength(1);
    const terminals = (send: typeof reduced) => send.mock.calls.filter(
      ([event]) => event === "error" || event === "done",
    );
    expect(terminals(reduced)).toEqual(terminals(ordinary));
    expect(terminals(reduced)[0]?.[0]).toBe("error");
  });

  it("keeps the conversation-only request free of a platform reduction callback", async () => {
    state.provider = "gemini";
    adapterScript = (input) => input.onTextDelta("Conversational answer");
    const send = await runTurn();
    expect(capturedInput).not.toHaveProperty("onToolsReduced");
    expect(capturedInput?.tools).toEqual([]);
    expect(send).toHaveBeenCalledWith("turn_capability", { conversationOnly: true });
    expect(lossFrames(send)).toEqual([]);
  });
});
