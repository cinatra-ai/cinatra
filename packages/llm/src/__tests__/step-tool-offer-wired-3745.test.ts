/**
 * cinatra#3745 — the step's tool ceiling as the entry points apply it.
 *
 * A call that brings a step's ceiling is offered only the declared tools, and
 * the ceiling itself never reaches the provider adapter. A call that brings no
 * ceiling inside a run's request frame (a tool handler's own model call) is
 * offered no tool, and its file-input and batch calls refuse: a missing
 * ceiling on a run is never the unrestricted offer. A call with no run frame
 * keeps its offer.
 *
 * The real entry points run; the provider adapter is a capture double and the
 * MCP/registry/database ports are inert doubles (as in
 * entry-point-actor-context.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server/request-context";
import type { ActorContext } from "@/lib/authz/actor-context";

const h = vi.hoisted(() => ({ calls: [] as Array<{ road: string; input: Record<string, unknown> }> }));

vi.mock("../mcp-access", () => ({
  withoutReservedFirstPartyLabelTools: vi.fn((tools: unknown[]) => tools),
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn((providerId: string) =>
    providerId === "openai"
      ? {
          abiVersion: 1 as const,
          providerId: "openai",
          createAdapter: async () => ({
            provider: "openai" as const,
            defaultModel: "mock-model",
            generate: async (input: Record<string, unknown>) => {
              h.calls.push({ road: "generate", input });
              return { text: "", usage: undefined, model: "mock-model" };
            },
            stream: async (input: Record<string, unknown>) => {
              h.calls.push({ road: "stream", input });
            },
            generateWithFileInput: async (input: Record<string, unknown>) => {
              h.calls.push({ road: "file-input", input });
              return { text: "", usage: undefined, model: "mock-model" };
            },
          }),
        }
      : null,
  ),
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));
vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
}));
vi.mock("../tools/skills", () => ({
  buildSkillTools: vi.fn().mockResolvedValue([]),
  buildSkillContext: vi.fn().mockResolvedValue(""),
  readSkillContent: vi.fn().mockResolvedValue(null),
  createShellTool: vi.fn(),
  createLocalSkillShellTool: vi.fn(),
  createMcpServerTool: vi.fn(),
  createWebSearchTool: vi.fn(),
  buildMcpTools: vi.fn(),
}));
import { generate, generateWithFileInput, orchestrateSubmitBatchV2, stream } from "../index";

const actorContext: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-1",
  authSource: "ui",
  policyVersion: "v2",
};
const fn = (name: string) => ({ type: "function", name, description: name, parameters: { type: "object", properties: {} } });
const OFFER = [fn("mail_send"), fn("wordpress_publish")];
const inRunFrame = <T>(body: () => Promise<T>): Promise<T> =>
  mcpRequestContextStorage.run({ orgId: "org-1", runId: "run-1" }, body);
const streamInput = (extra: Record<string, unknown>) =>
  ({ provider: "openai", system: "s", messages: [], onTextDelta: () => undefined, actorContext, ...extra }) as never;

function adapterInput(road: string): Record<string, unknown> {
  const call = h.calls.find((c) => c.road === road);
  if (!call) throw new Error(`the ${road} adapter was not called`);
  return call.input;
}

beforeEach(() => {
  h.calls.length = 0;
});

describe("the entry points apply a step's tool ceiling", () => {
  it("stream offers only the declared tools and never hands the ceiling to the provider adapter", async () => {
    await stream(streamInput({ tools: OFFER, stepToolPolicy: { kind: "declared", tools: ["mail_send"] } }));
    const input = adapterInput("stream");
    expect(input).not.toHaveProperty("stepToolPolicy");
    expect(input.tools).toEqual([fn("mail_send")]);
  });

  it("a run frame's generate that brings no ceiling is offered no tool; without a run frame it keeps its offer", async () => {
    await generate({ provider: "openai", system: "s", prompt: "u", tools: OFFER, actorContext } as never);
    expect(adapterInput("generate").tools).toEqual(OFFER);
    h.calls.length = 0;
    await inRunFrame(() => generate({ provider: "openai", system: "s", prompt: "u", tools: OFFER, actorContext } as never));
    expect(adapterInput("generate").tools).toBeUndefined();
  });

  it("a run frame's stream that brings no ceiling is offered no tool", async () => {
    await inRunFrame(() => stream(streamInput({ tools: OFFER })));
    expect(adapterInput("stream").tools).toBeUndefined();
  });

  it("a run frame's file-input call that brings no ceiling refuses before the adapter", async () => {
    await expect(inRunFrame(() => generateWithFileInput({ provider: "openai", fileRef: { provider: "openai", fileId: "f-1" },
      prompt: "u" } as never))).rejects.toThrow("step_tool_file_input_abi_unavailable");
    expect(h.calls).toHaveLength(0);
  });

  it("a run frame's batch submission that brings no ceiling refuses before any provider is resolved", async () => {
    await expect(inRunFrame(() => orchestrateSubmitBatchV2({ provider: "openai", requests: [] } as never)))
      .rejects.toThrow("step_tool_batch_abi_unavailable");
  });
});
