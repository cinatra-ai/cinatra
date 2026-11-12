// The turn's tool assembly, extracted from `runAssistantTurn`
// (packages/agent-ui-protocol/CONTRACT.md section 5.2, "One source" and
// "Read only").
//
// The function is an async generator: it stops at each point where the turn
// runs a write step of its own and yields that step. Each case drives it the
// way the turn does, with a recording driver, and with the LLM layer's
// builders stubbed, so it can see exactly what the assembly called, in which
// order, at which step, and what it handed back. The real injection contract
// and the real delivery-record builder run.

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InjectionResolverPorts } from "@cinatra-ai/skills/injection";

const state = vi.hoisted(() => ({
  calls: [] as string[],
  deliveredSkillIds: [] as string[][],
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
  // Stands for the persisted catalog that the skill registration repairs: the
  // assigned-skills port reads it, the registration step writes it.
  catalogRepaired: false,
}));

vi.mock("@cinatra-ai/llm", () => ({
  selectSkillDeliveryAdapter: vi.fn((provider: string) => ({
    provider,
    deliver: vi.fn(async (req: { skillIds: string[] }) => {
      state.calls.push("deliver");
      state.deliveredSkillIds.push([...req.skillIds]);
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
  type AssistantTurnToolAssembly,
  type AssistantTurnToolAssemblyInput,
  type AssistantTurnToolAssemblyResume,
  type TurnSelfMcpAdmission,
} from "../turn-tool-assembly";

const SKILLS = ["@cinatra-ai/a:one", "@cinatra-ai/b:two"];
const REPAIRED_SKILL = "@cinatra-ai/c:three";

function injectionPorts(): InjectionResolverPorts {
  return {
    async authorizeAssistantSession() {
      state.calls.push("resolve:authorize");
      return { ok: true, runOwnerUserId: "u1" };
    },
    async resolveAssistantRequiredSkills() {
      state.calls.push("resolve:required");
      return SKILLS.map((skillId) => ({ skillId }));
    },
    async resolveAssistantAssignedSkills() {
      state.calls.push("resolve:assigned");
      return state.catalogRepaired ? [{ skillId: REPAIRED_SKILL }] : [];
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
    ...over,
  };
}

const CHAT_ACTOR = { delegation: "chat", userId: "u1", orgId: "o1", platformRole: "member" };

function chatAdmission(over: Partial<TurnSelfMcpAdmission> = {}): TurnSelfMcpAdmission {
  return {
    kind: "chat",
    actor: CHAT_ACTOR,
    catalogState: undefined,
    lentActionGrant: "grant-1",
    actorToken: { ok: true, token: "minted-chat-token" },
    ...over,
  } as TurnSelfMcpAdmission;
}

const WIDGET_ACTOR = {
  userId: "u1",
  orgId: "o1",
  instanceId: "wp-canonical",
  kind: "wordpress",
  jti: "jti-1",
  parentJti: "cwu-row-1",
  turnRunId: "run-1",
  platformRole: "member",
};

function widgetAdmission(): TurnSelfMcpAdmission {
  return {
    kind: "widget",
    actor: WIDGET_ACTOR,
    lentActionGrant: null,
    actorToken: { ok: true, token: "minted-widget-token" },
  } as TurnSelfMcpAdmission;
}

/**
 * Drives the assembly as the turn does. Each yielded step is recorded in
 * `state.calls`; the registration step runs `onRegister`, the admission step
 * resumes with `admission`, or `"stop"` ends the drive there as the turn does
 * when its probe stops it.
 */
async function drive(
  inp: AssistantTurnToolAssemblyInput,
  opts: { admission?: TurnSelfMcpAdmission | "stop"; onRegister?: () => void } = {},
): Promise<AssistantTurnToolAssembly | "stopped"> {
  const run = assembleAssistantTurnTools(inp);
  let resume: AssistantTurnToolAssemblyResume | undefined;
  for (;;) {
    const step = await run.next(resume);
    if (step.done) return step.value;
    state.calls.push(`step:${step.value.kind}`);
    if (step.value.kind === "register_skills") {
      opts.onRegister?.();
      resume = { kind: "skills_registered" };
      continue;
    }
    if (opts.admission === "stop") return "stopped";
    resume = { kind: "self_mcp_admitted", admission: opts.admission ?? chatAdmission() };
  }
}

function assembled(out: AssistantTurnToolAssembly | "stopped") {
  if (out === "stopped" || out.kind !== "assembled") {
    throw new Error(`expected assembled, got ${out === "stopped" ? out : out.kind}`);
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.calls = [];
  state.deliveredSkillIds = [];
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
  state.catalogRepaired = false;
});

describe("the steps, in the order the turn has always run them", () => {
  it("a tool-capable provider: resolve, register, deliver, admit, self-MCP reference, external tools", async () => {
    await drive(input());
    expect(state.calls).toEqual([
      "resolve:authorize",
      "resolve:required",
      "resolve:assigned",
      "step:register_skills",
      "deliver",
      "step:admit_self_mcp_reference",
      "selfMcpChat",
      "externalTools",
    ]);
  });

  it("the injected skill set is resolved BEFORE the registration, so a catalog the registration repairs does not change this turn", async () => {
    // The concrete case: the registration repairs a catalog row that the
    // assigned-skills resolution reads. Resolved first (as the turn always
    // did), the repaired skill is not part of this turn's delivery.
    await drive(input(), {
      onRegister: () => {
        state.catalogRepaired = true;
      },
    });
    expect(state.deliveredSkillIds).toHaveLength(1);
    expect(state.deliveredSkillIds[0]).not.toContain(REPAIRED_SKILL);
    expect([...state.deliveredSkillIds[0]].sort()).toEqual([...SKILLS].sort());
  });

  it("a conversation-only provider: resolve, register, deliver inline, and no admission step", async () => {
    const out = assembled(await drive(input({ provider: "gemini", defaultModel: "gemini-2.5-pro" })));
    expect(state.calls).toEqual([
      "resolve:authorize",
      "resolve:required",
      "resolve:assigned",
      "step:register_skills",
      "deliverInline",
    ]);
    expect(out.conversationOnly).toBe(true);
    expect(out.tools).toEqual([]);
    expect(out.selfMcpCapabilityRequired).toBeUndefined();
    expect(out.platformMcpLabel).toBeUndefined();
    expect(out.skillSystemContext).toBe("INLINE_BODIES");
  });

  it("refuses to continue when a step is resumed without its write step", async () => {
    const run = assembleAssistantTurnTools(input());
    const first = await run.next();
    expect(first.done).toBe(false);
    await expect(run.next({ kind: "self_mcp_admitted", admission: chatAdmission() })).rejects.toThrow(
      /without the skill registration/,
    );
  });
});

describe("a tool-capable provider", () => {
  it("assembles self-MCP, external tools, skill tools and web_search, in that order", async () => {
    const out = assembled(await drive(input()));
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

  it("builds the chat reference from the admission: its actor, catalog state, grant and minted token", async () => {
    const catalogState = { marker: "catalog" } as unknown as Extract<
      TurnSelfMcpAdmission,
      { kind: "chat" }
    >["catalogState"];
    const out = assembled(
      await drive(input(), {
        admission: chatAdmission({ catalogState, lentActionGrant: "grant-7" } as Partial<TurnSelfMcpAdmission>),
      }),
    );
    const call = vi.mocked(buildLlmMcpServerToolForChat).mock.calls[0];
    expect(call[0]).toBe("openai");
    expect(call[1]).toEqual(CHAT_ACTOR);
    expect(call[3]).toEqual({ catalogState, lentActionGrant: "grant-7" });
    expect(vi.mocked(buildLlmMcpServerToolForWidget)).not.toHaveBeenCalled();
    expect(vi.mocked(resolveChatExternalMcpTools)).toHaveBeenCalledWith("openai", { surface: "chat" });
    expect(JSON.stringify(out.tools[0])).toContain("minted-chat-token");
  });

  it("a widget admission uses the widget builder, its actor and token, and the widget surface", async () => {
    const out = assembled(await drive(input(), { admission: widgetAdmission() }));
    expect(vi.mocked(buildLlmMcpServerToolForChat)).not.toHaveBeenCalled();
    const call = vi.mocked(buildLlmMcpServerToolForWidget).mock.calls[0];
    expect(call[1]).toEqual(WIDGET_ACTOR);
    expect(call[3]).toEqual({ lentActionGrant: null });
    expect(vi.mocked(resolveChatExternalMcpTools)).toHaveBeenCalledWith("openai", {
      surface: "public_site_widget",
    });
    expect(JSON.stringify(out.tools[0])).toContain("minted-widget-token");
  });

  it("a mint that failed is thrown inside the builder's issuer, as when the builder minted itself", async () => {
    const mintError = new Error("signing secret missing");
    let thrown: unknown;
    vi.mocked(buildLlmMcpServerToolForChat).mockImplementationOnce((async (...args: unknown[]) => {
      const issue = args[2] as (actor: unknown) => string;
      try {
        issue(args[1]);
      } catch (err) {
        thrown = err;
      }
      return null;
    }) as never);
    const out = await drive(input(), {
      admission: chatAdmission({ actorToken: { ok: false, error: mintError } }),
    });
    expect(thrown).toBe(mintError);
    expect(out).toEqual({ kind: "self_mcp_unavailable" });
  });

  it("applies the allow-list to named tools only", async () => {
    state.delivery.tools = [
      { type: "function", name: "skill_file_read" },
      { type: "function", name: "other_tool" },
    ];
    const out = assembled(await drive(input({ allowedTools: ["other_tool"] })));
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
    const out = assembled(await drive(input()));
    expect(out.deliveryRows.map((r) => r.skillId).sort()).toEqual([...SKILLS].sort());
    expect(out.deliveryRows.every((r) => r.outcome === "delivered")).toBe(true);
  });
});

describe("the early outcomes", () => {
  it("a delivery with no vehicle refuses before the admission step, with the refusal rows", async () => {
    state.delivery = { tools: [], systemContext: "", exposure: [] };
    const out = await drive(input());
    if (out === "stopped" || out.kind !== "delivery_refused") throw new Error(String(out));
    expect(out.refusalRows.map((r) => r.skillId).sort()).toEqual([...SKILLS].sort());
    for (const row of out.refusalRows) {
      expect(row.outcome).toBe("refused");
      expect(String(row.nonDeliveryReason)).toContain("NO vehicle");
    }
    expect(state.calls).not.toContain("step:admit_self_mcp_reference");
    expect(vi.mocked(buildLlmMcpServerToolForChat)).not.toHaveBeenCalled();
    expect(vi.mocked(resolveChatExternalMcpTools)).not.toHaveBeenCalled();
  });

  it("a turn that does not resume the admission step builds no reference and reads no external tool", async () => {
    const out = await drive(input(), { admission: "stop" });
    expect(out).toBe("stopped");
    expect(vi.mocked(buildLlmMcpServerToolForChat)).not.toHaveBeenCalled();
    expect(vi.mocked(resolveChatExternalMcpTools)).not.toHaveBeenCalled();
  });

  it("no self-MCP reference is its own outcome, and no external tool is read", async () => {
    state.selfMcpNull = true;
    const out = await drive(input());
    expect(out).toEqual({ kind: "self_mcp_unavailable" });
    expect(vi.mocked(resolveChatExternalMcpTools)).not.toHaveBeenCalled();
  });
});

describe("one source, read only", () => {
  const moduleSource = readFileSync(new URL("../turn-tool-assembly.ts", import.meta.url), "utf8");
  const runtimeSource = readFileSync(new URL("../runtime.ts", import.meta.url), "utf8");

  it("the assembly module names none of the turn's write steps, mints nothing and takes no write callback", () => {
    for (const writer of [
      "recordTurnSkillDelivery",
      "persistTurnSkillDelivery",
      "issueTurnLentActionGrant",
      "checkPublicMcpReachability",
      "ensureAssistantSkillsRegistered(",
      "ensureInstalledSkillsRegistered",
      "retireSupersededChatSkillsOnce",
      "issueChatMcpActorToken",
      "issueWidgetMcpActorToken",
      "admitSelfMcpReference",
      "readChatMcpCatalogState",
      "randomUUID",
      "@/lib/chat-mcp-actor-token",
      "@/lib/widget-mcp-actor-token",
    ]) {
      expect(moduleSource, writer).not.toContain(writer);
    }
    // One parameter: the input. No ports object of callbacks.
    expect(moduleSource).toMatch(
      /export async function\* assembleAssistantTurnTools\(\s*input: AssistantTurnToolAssemblyInput,\s*\)/,
    );
  });

  it("the turn runs its write steps at the yielded steps, and assembles its tools through the extracted function only", () => {
    expect(runtimeSource).toContain('from "./turn-tool-assembly"');
    expect(runtimeSource).toContain("assembleAssistantTurnTools({");
    expect(runtimeSource).toContain('step.value.kind === "register_skills"');
    const register = runtimeSource.indexOf('step.value.kind === "register_skills"');
    const registration = runtimeSource.indexOf(
      "await ensureAssistantSkillsRegistered(runtimeConfig.skillIds);",
    );
    const probe = runtimeSource.indexOf("await checkPublicMcpReachability();");
    // The registration exists once, inside the register_skills step, before
    // the admission step's probe.
    expect(
      runtimeSource.split("await ensureAssistantSkillsRegistered(runtimeConfig.skillIds);").length - 1,
    ).toBe(1);
    expect(register).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(register);
    expect(probe).toBeGreaterThan(registration);
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
