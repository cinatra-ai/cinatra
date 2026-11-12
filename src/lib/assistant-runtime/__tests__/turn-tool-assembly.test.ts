// The turn's tool assembly, extracted from `runAssistantTurn`
// (packages/agent-ui-protocol/CONTRACT.md section 5.2, "One source" and
// "Read only").
//
// The function is driven with recording ports and with the LLM layer's
// builders stubbed, so each case can see exactly what it called, in which
// order, and what it handed back. The real injection contract and the real
// delivery-record builder run.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InjectionResolverPorts } from "@cinatra-ai/skills/injection";

const state = vi.hoisted(() => ({
  calls: [] as string[],
  delivery: {
    tools: [{ type: "function", name: "skill_file_read" }] as Array<Record<string, unknown>>,
    systemContext: "SKILLS_CUE",
    exposure: [] as Array<Record<string, unknown>>,
  },
  inline: {
    systemContext: "INLINE_BODIES",
    exposure: [] as Array<Record<string, unknown>>,
    dropped: [] as Array<{ skillId: string; reason: string }>,
  },
  externalTools: [{ type: "mcp", serverLabel: "ext", serverUrl: "https://ext.example.test/mcp" }] as Array<
    Record<string, unknown>
  >,
  selfMcpNull: false,
}));

vi.mock("@cinatra-ai/llm", () => ({
  selectSkillDeliveryAdapter: vi.fn((provider: string) => ({
    provider,
    deliver: vi.fn(async () => {
      state.calls.push("deliver");
      return { ...state.delivery };
    }),
  })),
  deliverInjectedSkillsInline: vi.fn(async () => {
    state.calls.push("deliverInline");
    return { ...state.inline };
  }),
  resolveChatExternalMcpTools: vi.fn(async () => {
    state.calls.push("externalTools");
    return [...state.externalTools];
  }),
  buildLlmMcpServerToolForChat: vi.fn(
    async (_provider: string, _actor: unknown, issue: (a: unknown) => string, options: unknown) => {
      state.calls.push("selfMcpChat");
      if (state.selfMcpNull) return null;
      return {
        type: "mcp",
        serverLabel: "cinatra",
        serverUrl: "https://mcp.example.test/api/mcp",
        headers: { Authorization: `Bearer ${issue(_actor)}` },
        options,
      };
    },
  ),
  buildLlmMcpServerToolForWidget: vi.fn(
    async (_provider: string, _actor: unknown, issue: (a: unknown) => string, options: unknown) => {
      state.calls.push("selfMcpWidget");
      if (state.selfMcpNull) return null;
      return {
        type: "mcp",
        serverLabel: "cinatra",
        serverUrl: "https://mcp.example.test/api/mcp",
        headers: { Authorization: `Bearer ${issue(_actor)}` },
        options,
      };
    },
  ),
}));

import {
  buildLlmMcpServerToolForChat,
  buildLlmMcpServerToolForWidget,
  resolveChatExternalMcpTools,
} from "@cinatra-ai/llm";
import {
  assembleAssistantTurnTools,
  type AssistantTurnToolAssemblyInput,
  type AssistantTurnToolAssemblyPorts,
} from "../turn-tool-assembly";

const SKILLS = ["@cinatra-ai/a:one", "@cinatra-ai/b:two"];

function injectionPorts(): InjectionResolverPorts {
  return {
    async authorizeAssistantSession() {
      return { ok: true, runOwnerUserId: "u1" };
    },
    async resolveAssistantRequiredSkills() {
      return SKILLS.map((skillId) => ({ skillId }));
    },
    async resolveAssistantAssignedSkills() {
      return [];
    },
  } as InjectionResolverPorts;
}

function input(over: Partial<AssistantTurnToolAssemblyInput> = {}): AssistantTurnToolAssemblyInput {
  return {
    provider: "openai",
    defaultModel: "gpt-5.5",
    skillIds: SKILLS,
    allowedTools: [],
    assistantAgentId: "@cinatra-ai/assistant",
    userId: "u1",
    sessionId: "thread-1",
    injectionPorts: injectionPorts(),
    selfMcp: {
      kind: "chat",
      actor: { delegation: "chat", userId: "u1", orgId: "o1", platformRole: "member" },
    } as AssistantTurnToolAssemblyInput["selfMcp"],
    ...over,
  };
}

function recordingPorts(grant: string | null = "grant-1") {
  const chatIssuer = vi.fn(() => "inert-chat-token");
  const widgetIssuer = vi.fn(() => "inert-widget-token");
  const ports: AssistantTurnToolAssemblyPorts = {
    issueChatMcpActorToken: chatIssuer as unknown as AssistantTurnToolAssemblyPorts["issueChatMcpActorToken"],
    issueWidgetMcpActorToken:
      widgetIssuer as unknown as AssistantTurnToolAssemblyPorts["issueWidgetMcpActorToken"],
    readChatMcpCatalogState: vi.fn(async () => {
      state.calls.push("catalogState");
      return undefined;
    }),
    admitSelfMcpReference: vi.fn(async () => {
      state.calls.push("admit");
      return { lentActionGrant: grant };
    }),
  };
  return { ports, chatIssuer, widgetIssuer };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.calls = [];
  state.delivery = {
    tools: [{ type: "function", name: "skill_file_read" }],
    systemContext: "SKILLS_CUE",
    exposure: [],
  };
  state.inline = { systemContext: "INLINE_BODIES", exposure: [], dropped: [] };
  state.externalTools = [
    { type: "mcp", serverLabel: "ext", serverUrl: "https://ext.example.test/mcp" },
  ];
  state.selfMcpNull = false;
});

describe("a tool-capable provider", () => {
  it("assembles self-MCP, external tools, skill tools and web_search, in that order", async () => {
    const { ports } = recordingPorts();
    const out = await assembleAssistantTurnTools(input(), ports);
    expect(out.kind).toBe("assembled");
    if (out.kind !== "assembled") return;
    expect(out.conversationOnly).toBe(false);
    expect(out.tools).toEqual([
      expect.objectContaining({ type: "mcp", serverLabel: "cinatra" }),
      expect.objectContaining({ type: "mcp", serverLabel: "ext" }),
      expect.objectContaining({ type: "function", name: "skill_file_read" }),
      { type: "web_search" },
    ]);
    expect(out.selfMcpCapabilityRequired).toBe("native_mcp");
    expect(out.platformMcpLabel).toBe("cinatra");
    expect(out.skillSystemContext).toBe("SKILLS_CUE");
  });

  it("runs the caller's admit step after the delivery and before the self-MCP reference", async () => {
    const { ports } = recordingPorts();
    await assembleAssistantTurnTools(input(), ports);
    expect(state.calls).toEqual([
      "deliver",
      "admit",
      "catalogState",
      "selfMcpChat",
      "externalTools",
    ]);
    expect(ports.admitSelfMcpReference).toHaveBeenCalledTimes(1);
  });

  it("builds the self-MCP reference with the issuer port and the admitted grant", async () => {
    const { ports, chatIssuer, widgetIssuer } = recordingPorts("grant-7");
    const out = await assembleAssistantTurnTools(input(), ports);
    const call = vi.mocked(buildLlmMcpServerToolForChat).mock.calls[0];
    expect(call[0]).toBe("openai");
    expect(call[1]).toEqual({ delegation: "chat", userId: "u1", orgId: "o1", platformRole: "member" });
    expect(call[2]).toBe(ports.issueChatMcpActorToken);
    expect(call[3]).toEqual({ catalogState: undefined, lentActionGrant: "grant-7" });
    expect(chatIssuer).toHaveBeenCalledTimes(1);
    expect(widgetIssuer).not.toHaveBeenCalled();
    expect(vi.mocked(resolveChatExternalMcpTools)).toHaveBeenCalledWith("openai", { surface: "chat" });
    if (out.kind !== "assembled") throw new Error(out.kind);
    expect(JSON.stringify(out.tools[0])).toContain("inert-chat-token");
  });

  it("a widget subject uses the widget builder, the widget issuer and the widget surface", async () => {
    const { ports, chatIssuer, widgetIssuer } = recordingPorts(null);
    const actor = {
      userId: "u1",
      orgId: "o1",
      instanceId: "wp-canonical",
      kind: "wordpress",
      jti: "jti-1",
      parentJti: "cwu-row-1",
      turnRunId: "run-1",
      platformRole: "member",
    };
    await assembleAssistantTurnTools(
      input({ selfMcp: { kind: "widget", actor } as AssistantTurnToolAssemblyInput["selfMcp"] }),
      ports,
    );
    expect(vi.mocked(buildLlmMcpServerToolForChat)).not.toHaveBeenCalled();
    const call = vi.mocked(buildLlmMcpServerToolForWidget).mock.calls[0];
    expect(call[1]).toBe(actor);
    expect(call[2]).toBe(ports.issueWidgetMcpActorToken);
    expect(call[3]).toEqual({ lentActionGrant: null });
    expect(widgetIssuer).toHaveBeenCalledTimes(1);
    expect(chatIssuer).not.toHaveBeenCalled();
    expect(ports.readChatMcpCatalogState).not.toHaveBeenCalled();
    expect(vi.mocked(resolveChatExternalMcpTools)).toHaveBeenCalledWith("openai", {
      surface: "public_site_widget",
    });
  });

  it("applies the allow-list to named tools only", async () => {
    state.delivery.tools = [
      { type: "function", name: "skill_file_read" },
      { type: "function", name: "other_tool" },
    ];
    const { ports } = recordingPorts();
    const out = await assembleAssistantTurnTools(input({ allowedTools: ["other_tool"] }), ports);
    if (out.kind !== "assembled") throw new Error(out.kind);
    expect(out.tools).toEqual([
      expect.objectContaining({ serverLabel: "cinatra" }),
      expect.objectContaining({ serverLabel: "ext" }),
      expect.objectContaining({ name: "other_tool" }),
      { type: "web_search" },
    ]);
  });

  it("returns the delivery rows for the caller to commit", async () => {
    state.delivery.exposure = SKILLS.map((skillId) => ({
      skillId,
      deliveryMode: "openai_shell",
      invocationAttributable: true,
    }));
    const { ports } = recordingPorts();
    const out = await assembleAssistantTurnTools(input(), ports);
    if (out.kind !== "assembled") throw new Error(out.kind);
    expect(out.deliveryRows.map((r) => r.skillId).sort()).toEqual([...SKILLS].sort());
    expect(out.deliveryRows.every((r) => r.outcome === "delivered")).toBe(true);
  });
});

describe("the early outcomes", () => {
  it("a delivery with no vehicle refuses before the admit step, with the refusal rows", async () => {
    state.delivery = { tools: [], systemContext: "", exposure: [] };
    const { ports } = recordingPorts();
    const out = await assembleAssistantTurnTools(input(), ports);
    expect(out.kind).toBe("delivery_refused");
    if (out.kind !== "delivery_refused") return;
    expect(out.refusalRows.map((r) => r.skillId).sort()).toEqual([...SKILLS].sort());
    for (const row of out.refusalRows) {
      expect(row.outcome).toBe("refused");
      expect(String(row.nonDeliveryReason)).toContain("NO vehicle");
    }
    expect(ports.admitSelfMcpReference).not.toHaveBeenCalled();
    expect(vi.mocked(buildLlmMcpServerToolForChat)).not.toHaveBeenCalled();
    expect(vi.mocked(resolveChatExternalMcpTools)).not.toHaveBeenCalled();
  });

  it("an admit step that stops the turn ends the assembly there", async () => {
    const { ports } = recordingPorts();
    vi.mocked(ports.admitSelfMcpReference).mockResolvedValueOnce(null);
    const out = await assembleAssistantTurnTools(input(), ports);
    expect(out).toEqual({ kind: "stopped" });
    expect(vi.mocked(buildLlmMcpServerToolForChat)).not.toHaveBeenCalled();
    expect(ports.readChatMcpCatalogState).not.toHaveBeenCalled();
    expect(vi.mocked(resolveChatExternalMcpTools)).not.toHaveBeenCalled();
  });

  it("no self-MCP reference is its own outcome, and no external tool is read", async () => {
    state.selfMcpNull = true;
    const { ports } = recordingPorts();
    const out = await assembleAssistantTurnTools(input(), ports);
    expect(out).toEqual({ kind: "self_mcp_unavailable" });
    expect(vi.mocked(resolveChatExternalMcpTools)).not.toHaveBeenCalled();
  });
});

describe("a conversation-only provider", () => {
  it("assembles no tools, delivers inline and never calls a tool port", async () => {
    const { ports, chatIssuer, widgetIssuer } = recordingPorts();
    const out = await assembleAssistantTurnTools(
      input({ provider: "gemini", defaultModel: "gemini-2.5-pro" }),
      ports,
    );
    expect(out.kind).toBe("assembled");
    if (out.kind !== "assembled") return;
    expect(out.conversationOnly).toBe(true);
    expect(out.tools).toEqual([]);
    expect(out.selfMcpCapabilityRequired).toBeUndefined();
    expect(out.platformMcpLabel).toBeUndefined();
    expect(out.skillSystemContext).toBe("INLINE_BODIES");
    expect(state.calls).toEqual(["deliverInline"]);
    expect(ports.admitSelfMcpReference).not.toHaveBeenCalled();
    expect(ports.readChatMcpCatalogState).not.toHaveBeenCalled();
    expect(chatIssuer).not.toHaveBeenCalled();
    expect(widgetIssuer).not.toHaveBeenCalled();
  });
});

describe("one source, read only", () => {
  const moduleSource = readFileSync(new URL("../turn-tool-assembly.ts", import.meta.url), "utf8");
  const runtimeSource = readFileSync(new URL("../runtime.ts", import.meta.url), "utf8");

  it("the assembly module imports none of the turn's write steps", () => {
    for (const writer of [
      "recordTurnSkillDelivery",
      "persistTurnSkillDelivery",
      "issueTurnLentActionGrant",
      "checkPublicMcpReachability",
      "ensureInstalledSkillsRegistered",
      "retireSupersededChatSkillsOnce",
      "@/lib/chat-mcp-actor-token",
      "@/lib/widget-mcp-actor-token",
    ]) {
      expect(moduleSource, writer).not.toContain(writer);
    }
  });

  it("the turn assembles its tools through the extracted function only", () => {
    expect(runtimeSource).toContain('from "./turn-tool-assembly"');
    expect(runtimeSource).toContain("await assembleAssistantTurnTools(");
    for (const assemblyStep of [
      "resolveInjectedSkillSet(",
      "selectSkillDeliveryAdapter(",
      "deliverInjectedSkillsInline(",
      "resolveChatExternalMcpTools(",
      "buildLlmMcpServerToolForChat(",
      "buildLlmMcpServerToolForWidget(",
      "isAllowedByList(",
    ]) {
      expect(runtimeSource, assemblyStep).not.toContain(assemblyStep);
    }
  });
});
