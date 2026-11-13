// The tool assembly reads the LLM layer's functions at CALL time, never at
// module load.
//
// Many suites mock "@cinatra-ai/llm" with only the exports their turn calls.
// A native-provider turn never calls `deliverInjectedSkillsInline` (the
// inline vehicle), so such a mock leaves it out. When the module read the
// three functions into a module-level object at load, importing the turn
// threw ("No export is defined on the mock") and the whole suite failed
// before its first case. This suite uses exactly such a mock: no
// `deliverInjectedSkillsInline` export at all.

import { describe, expect, it, vi } from "vitest";
import type { InjectionResolverPorts } from "@cinatra-ai/skills/injection";

const state = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@cinatra-ai/llm", () => ({
  selectSkillDeliveryAdapter: vi.fn((provider: string) => ({
    provider,
    deliver: vi.fn(async () => {
      state.calls.push("deliver");
      return {
        tools: [{ type: "function", name: "skill_file_read" }],
        systemContext: "SKILLS_CUE",
        exposure: [],
      };
    }),
  })),
  resolveChatExternalMcpTools: vi.fn(async () => {
    state.calls.push("externalTools");
    return [];
  }),
  buildLlmMcpServerToolForChat: vi.fn(async () => {
    state.calls.push("selfMcpChat");
    return { type: "mcp", serverLabel: "cinatra", serverUrl: "https://mcp.example.test/api/mcp" };
  }),
  buildLlmMcpServerToolForWidget: vi.fn(async () => null),
}));

function injectionPorts(): InjectionResolverPorts {
  return {
    async authorizeAssistantSession() {
      return { ok: true, runOwnerUserId: "u1" };
    },
    async resolveAssistantRequiredSkills() {
      return [{ skillId: "@cinatra-ai/a:one" }];
    },
    async resolveAssistantAssignedSkills() {
      return [];
    },
  } as InjectionResolverPorts;
}

describe("the assembly's LLM-layer reads are looked up at call time", () => {
  it("the module imports under a mock that lacks deliverInjectedSkillsInline", async () => {
    const mod = await import("../turn-tool-assembly");
    expect(typeof mod.assembleAssistantTurnTools).toBe("function");
  });

  it("a native-provider turn assembles with the mocked real functions, without the inline export", async () => {
    const { assembleAssistantTurnTools } = await import("../turn-tool-assembly");
    state.calls = [];
    const run = assembleAssistantTurnTools({
      provider: "openai",
      defaultModel: "stub-model",
      skillIds: ["@cinatra-ai/a:one"],
      allowedTools: [],
      assistantAgentId: "@cinatra-ai/assistant",
      userId: "u1",
      sessionId: "thread-1",
      injectionPorts: injectionPorts(),
    });
    let step = await run.next(undefined);
    expect(step.done).toBe(false);
    expect(step.value).toEqual({ kind: "register_skills" });
    step = await run.next({ kind: "skills_registered" });
    expect(step.value).toEqual({ kind: "admit_self_mcp_reference" });
    step = await run.next({
      kind: "self_mcp_admitted",
      admission: {
        kind: "chat",
        actor: { delegation: "chat", userId: "u1", orgId: "o1", platformRole: "member" },
        catalogState: undefined,
        lentActionGrant: null,
        actorToken: { ok: true, token: "t" },
      } as never,
    });
    expect(step.done).toBe(true);
    expect(step.value).toMatchObject({ kind: "assembled", skillSystemContext: "SKILLS_CUE" });
    expect(state.calls).toEqual(["deliver", "selfMcpChat", "externalTools"]);
  });
});
