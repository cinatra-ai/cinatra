// cinatra#2240 — a REAL chat turn leaves exactly one durable delivery record,
// and it matches what went to the wire.
//
// THE GAP (finding F8 of the #2094 S7 acceptance E2E, evidence under
// evidence/2094-s7-acceptance/e2e/): the chat surface delivered skills to the
// provider and wrote no per-run record, so the acceptance's own "assert
// delivery from the run's records" wording was unsatisfiable and the wave99
// evidence had to use the wire-level egress ledger as the record instead.
//
// These cases drive the REAL `runAssistantTurn` (only its leaf dependencies are
// stubbed, in the same shape as `skill-delivery-not-model-gated.test.ts`) and
// assert the record against `stream()`'s OWN input — the closest in-process
// stand-in for the wire. What that proves, and what it does not:
//
//   PROVEN HERE — the record is keyed to the turn identity the chat path mints;
//   it is written exactly ONCE per turn; its delivered set, vehicle, mode and
//   Anthropic container refs equal what the runtime handed `stream()`; a turn
//   that never reaches `stream()` writes NO record; the refusal path writes the
//   refusal record; a repeat write inserts nothing.
//
//   NOT PROVEN HERE — that the provider adapter serialises those tools onto the
//   HTTP request unchanged. That is one layer below `stream()` and only a live
//   E2E with an egress capture (the F8 harness) can settle it.

import { beforeEach, describe, expect, it, vi } from "vitest";

let capturedStreamInput: Record<string, unknown> | null = null;

const state = vi.hoisted(() => ({
  provider: "openai" as "openai" | "anthropic" | "gemini",
  defaultModel: "gpt-5.5",
  deliveryResult: {
    tools: [{ type: "function", name: "skill_file_read" }] as Array<Record<string, unknown>>,
    systemContext: "SKILLS_CUE",
    exposure: [] as Array<Record<string, unknown>>,
    droppedSkillIds: undefined as string[] | undefined,
    selectionReason: undefined as string | undefined,
  },
  inlineResult: {
    systemContext: "",
    exposure: [] as Array<Record<string, unknown>>,
    dropped: [] as Array<{ skillId: string; reason: string }>,
  },
  mcpReachable: true,
  /** Every (turnId, rows) the runtime committed, in order. */
  recorded: [] as Array<{ turnId: string; rows: Array<Record<string, unknown>> }>,
  /** Keys already persisted — reproduces `ON CONFLICT DO NOTHING`. */
  persistedKeys: new Set<string>(),
  /** Throw inside `stream()` BEFORE the provider request is issued. */
  streamFailsBeforeDispatch: false,
  /** Throw AFTER the provider request went out (a provider-side rejection). */
  streamFailsAfterDispatch: false,
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

// The store under observation. The real writer's SQL contract is pinned in
// src/lib/__tests__/assistant-turn-skill-delivery.test.ts; here the stub
// reproduces its OBSERVABLE behaviour (idempotent insert keyed on
// (turn_id, skill_id)) so the runtime's no-double-write property is testable.
vi.mock("@/lib/assistant-turn-skill-delivery", () => ({
  recordTurnSkillDelivery: vi.fn(
    async (input: { turnId: string; rows: Array<Record<string, unknown>> }) => {
      state.recorded.push({ turnId: input.turnId, rows: input.rows });
      let inserted = 0;
      for (const row of input.rows) {
        const key = `${input.turnId}::${String(row.skillId)}`;
        if (state.persistedKeys.has(key)) continue;
        state.persistedKeys.add(key);
        inserted += 1;
      }
      return inserted;
    },
  ),
}));

vi.mock("@cinatra-ai/llm", () => ({
  hasConfiguredLlmRuntime: vi.fn(async () => true),
  checkPublicMcpReachability: vi.fn(async () =>
    state.mcpReachable
      ? { status: "reachable", url: "https://mcp.example.test/api/mcp" }
      : { status: "unreachable", url: "https://mcp.example.test/api/mcp", reason: "ECONNREFUSED" },
  ),
  resolveDefaultAdapter: vi.fn(async () => ({
    provider: state.provider,
    defaultModel: state.defaultModel,
  })),
  resolveBoundDefaultAdapter: vi.fn(async () => ({
    provider: state.provider,
    defaultModel: state.defaultModel,
  })),
  BoundDefaultProviderUnavailableError: class extends Error {},
  selectSkillDeliveryAdapter: vi.fn(() => ({
    provider: state.provider,
    deliver: vi.fn(async () => ({ ...state.deliveryResult })),
  })),
  deliverInjectedSkillsInline: vi.fn(async () => ({ ...state.inlineResult })),
  resolveChatExternalMcpTools: vi.fn(async () => []),
  buildLlmMcpServerToolForChat: vi.fn(async () => ({
    type: "mcp",
    name: "cinatra",
    serverLabel: "cinatra",
  })),
  // Faithful to every shipped provider adapter: `onStepStart` fires at the top
  // of the step loop, immediately BEFORE the provider request goes out. The
  // runtime uses it as the observed dispatch boundary.
  stream: vi.fn(async (input: Record<string, unknown>) => {
    capturedStreamInput = input;
    if (state.streamFailsBeforeDispatch) {
      // Models a throw INSIDE `stream()` but BEFORE `adapter.stream()` —
      // adapter resolution, MCP/execution injection, attachment resolution.
      // Nothing left the process, so nothing may be recorded.
      throw new Error("attachment resolution failed");
    }
    (input.onStepStart as (step: number) => void)?.(1);
    if (state.streamFailsAfterDispatch) {
      // The request WAS sent and the provider rejected it (the issue-#47 400s).
      throw new Error("400 unsupported tool");
    }
    (input.onTextDelta as (d: string) => void)?.("Hi");
  }),
}));

import { runAssistantTurn } from "../runtime";
import { buildCinatraAssistantRuntimeConfig } from "../cinatra-assistant-config";

const TURN = { turnId: "turn-2240", runId: "run-2240" };

function makeArgs(send: (event: string, data: unknown) => void, turnIdentity = TURN) {
  return {
    messages: [{ role: "user" as const, content: "hi" }],
    actorContext: { actorType: "user", userId: "u1" } as never,
    userId: "u1",
    platformRole: "member" as const,
    sessionOrgId: null,
    send,
    turnIdentity,
  };
}

/** The catalog skill set the Cinatra assistant's own bundle resolves. */
function bundleSkillIds(): string[] {
  return [...buildCinatraAssistantRuntimeConfig().skillIds];
}

function onlyRecord() {
  expect(state.recorded).toHaveLength(1);
  return state.recorded[0];
}

beforeEach(() => {
  capturedStreamInput = null;
  state.provider = "openai";
  state.defaultModel = "gpt-5.5";
  state.mcpReachable = true;
  state.recorded = [];
  state.persistedKeys = new Set();
  state.deliveryResult = {
    tools: [{ type: "function", name: "skill_file_read" }],
    systemContext: "SKILLS_CUE",
    exposure: [],
    droppedSkillIds: undefined,
    selectionReason: undefined,
  };
  state.inlineResult = { systemContext: "", exposure: [], dropped: [] };
  state.streamFailsBeforeDispatch = false;
  state.streamFailsAfterDispatch = false;
});

describe("a chat turn writes EXACTLY ONE delivery record, keyed to the turn the chat path minted", () => {
  it("records the OpenAI tool-mount delivery that reached stream()", async () => {
    const ids = bundleSkillIds();
    state.deliveryResult.exposure = ids.map((skillId) => ({
      skillId,
      deliveryMode: "openai_shell",
      invocationAttributable: true,
    }));

    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(vi.fn()));

    // The turn really dispatched...
    expect(capturedStreamInput).not.toBeNull();
    const wireTools = capturedStreamInput!.tools as Array<Record<string, unknown>>;
    expect(wireTools.some((t) => t.name === "skill_file_read")).toBe(true);

    // ...and left one record, keyed to the harness-bound turn id.
    const record = onlyRecord();
    expect(record.turnId).toBe("turn-2240");
    expect(record.rows.map((r) => r.skillId).sort()).toEqual([...ids].sort());
    for (const row of record.rows) {
      expect(row.outcome).toBe("delivered");
      expect(row.vehicle).toBe("tool-mount");
      expect(row.deliveryMode).toBe("openai_shell");
      expect(row.provider).toBe("openai");
    }
  });

  it("records the Anthropic container refs BY VALUE — the same ids+versions handed to stream()", async () => {
    state.provider = "anthropic";
    state.defaultModel = "claude-sonnet-4-5";
    const ids = bundleSkillIds();
    const containerSkills = ids.map((catalogSkillId, i) => ({
      skillId: `skill_ant_${i}`,
      version: String(i + 1),
      catalogSkillId,
    }));
    state.deliveryResult = {
      tools: [{ type: "container_skills", skills: containerSkills }],
      systemContext: "SKILLS_CUE",
      exposure: ids.map((skillId) => ({
        skillId,
        deliveryMode: "anthropic_container",
        invocationAttributable: false,
      })),
      droppedSkillIds: undefined,
      selectionReason: undefined,
    };

    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(vi.fn()));

    // What actually went to the wire, read back off stream()'s input.
    const wireTools = capturedStreamInput!.tools as Array<Record<string, unknown>>;
    const wireContainer = wireTools.find((t) => t.type === "container_skills") as {
      skills: Array<{ skillId: string; version: string; catalogSkillId: string }>;
    };
    expect(wireContainer).toBeDefined();
    // Anthropic's hard per-request maximum — the record can never exceed it
    // because the delivery it mirrors cannot.
    expect(wireContainer.skills.length).toBeLessThanOrEqual(8);

    const record = onlyRecord();
    const recordByCatalogId = new Map(record.rows.map((r) => [String(r.skillId), r]));
    for (const wire of wireContainer.skills) {
      const row = recordByCatalogId.get(wire.catalogSkillId);
      expect(row, `no record row for ${wire.catalogSkillId}`).toBeDefined();
      expect(row!.outcome).toBe("delivered");
      expect(row!.vehicle).toBe("container-skills");
      expect(row!.providerSkillId).toBe(wire.skillId);
      expect(row!.skillVersion).toBe(wire.version);
    }
    expect(record.rows.filter((r) => r.outcome === "delivered")).toHaveLength(
      wireContainer.skills.length,
    );
  });

  it("records the inline (Gemini) vehicle and its budget drops", async () => {
    state.provider = "gemini";
    state.defaultModel = "gemini-2.5-pro";
    const ids = bundleSkillIds();
    const [dropped, ...inlined] = ids;
    state.inlineResult = {
      systemContext: "INLINE_BODIES",
      exposure: inlined.map((skillId) => ({
        skillId,
        deliveryMode: "gemini_inline",
        invocationAttributable: false,
      })),
      dropped: [{ skillId: dropped, reason: "inline_budget_exceeded" }],
    };

    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(vi.fn()));

    expect(capturedStreamInput).not.toBeNull();
    // The conversation-only provider carries NO tools; its vehicle IS the prompt.
    expect(capturedStreamInput!.system as string).toContain("INLINE_BODIES");

    const record = onlyRecord();
    const droppedRow = record.rows.find((r) => r.skillId === dropped)!;
    expect(droppedRow.outcome).toBe("dropped");
    expect(droppedRow.nonDeliveryReason).toBe("inline_budget_exceeded");
    for (const skillId of inlined) {
      const row = record.rows.find((r) => r.skillId === skillId)!;
      expect(row.outcome).toBe("delivered");
      expect(row.vehicle).toBe("inline");
      expect(row.deliveryMode).toBe("gemini_inline");
    }
  });
});

describe("the loud no-vehicle REFUSAL is durable, not just a log line", () => {
  it("records every resolved skill as refused, and never dispatches", async () => {
    state.deliveryResult = {
      tools: [],
      systemContext: "",
      exposure: [],
      droppedSkillIds: undefined,
      selectionReason: undefined,
    };
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    expect(capturedStreamInput).toBeNull();
    expect(send).toHaveBeenCalledWith("error", expect.anything());

    const record = onlyRecord();
    expect(record.turnId).toBe("turn-2240");
    expect(record.rows.map((r) => r.skillId).sort()).toEqual([...bundleSkillIds()].sort());
    for (const row of record.rows) {
      expect(row.outcome).toBe("refused");
      expect(row.vehicle).toBeNull();
      expect(String(row.nonDeliveryReason)).toContain("NO vehicle");
    }
  });
});

describe("the record never OVERCLAIMS", () => {
  it("a turn that dies INSIDE stream() before the provider request writes NO record", () => {
    // Reaching the `stream()` call is not proof of dispatch: adapter
    // resolution, MCP/execution injection and attachment resolution all run
    // first. A record committed on arrival would leave permanent `delivered`
    // rows for a turn that never dispatched — and because the write is an
    // idempotent insert, a retry could not repair it.
    state.streamFailsBeforeDispatch = true;
    state.deliveryResult.exposure = bundleSkillIds().map((skillId) => ({
      skillId,
      deliveryMode: "openai_shell",
      invocationAttributable: true,
    }));

    const send = vi.fn();
    return runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send)).then(() => {
      expect(send).toHaveBeenCalledWith("error", expect.anything());
      expect(state.recorded).toEqual([]);
    });
  });

  it("a request the PROVIDER rejected IS recorded — that is the run an operator must audit", () => {
    state.streamFailsAfterDispatch = true;
    state.deliveryResult.exposure = bundleSkillIds().map((skillId) => ({
      skillId,
      deliveryMode: "openai_shell",
      invocationAttributable: true,
    }));

    const send = vi.fn();
    return runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send)).then(() => {
      expect(send).toHaveBeenCalledWith("error", expect.anything());
      const record = onlyRecord();
      expect(record.turnId).toBe("turn-2240");
      expect(record.rows.every((r) => r.outcome === "delivered")).toBe(true);
    });
  });

  it("a turn that returns before dispatch (dead public MCP ingress) writes NO record", async () => {
    // Delivery preparation succeeded, but the turn is refused at the
    // reachability guard and nothing ever reaches a provider. A record written
    // at deliver()-time would assert a delivery that did not happen.
    state.mcpReachable = false;
    state.deliveryResult.exposure = bundleSkillIds().map((skillId) => ({
      skillId,
      deliveryMode: "openai_shell",
      invocationAttributable: true,
    }));

    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    expect(capturedStreamInput).toBeNull();
    expect(send).toHaveBeenCalledWith("error", expect.anything());
    expect(state.recorded).toEqual([]);
  });
});

describe("NO DOUBLE WRITE on a retry within the same turn", () => {
  it("re-running the same turn identity inserts nothing the second time", async () => {
    state.deliveryResult.exposure = bundleSkillIds().map((skillId) => ({
      skillId,
      deliveryMode: "openai_shell",
      invocationAttributable: true,
    }));

    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(vi.fn()));
    const afterFirst = state.persistedKeys.size;
    expect(afterFirst).toBe(bundleSkillIds().length);

    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(vi.fn()));
    // The writer was called again (the runtime does not track history) but the
    // idempotent insert added NO new rows — the durable record is unchanged.
    expect(state.recorded).toHaveLength(2);
    expect(state.persistedKeys.size).toBe(afterFirst);
  });

  it("a FRESH turn identity is a fresh record (a user retry mints a new turn)", async () => {
    state.deliveryResult.exposure = bundleSkillIds().map((skillId) => ({
      skillId,
      deliveryMode: "openai_shell",
      invocationAttributable: true,
    }));

    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(vi.fn()));
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      makeArgs(vi.fn(), { turnId: "turn-retry", runId: "run-retry" }),
    );
    expect(state.persistedKeys.size).toBe(bundleSkillIds().length * 2);
    expect(state.recorded.map((r) => r.turnId)).toEqual(["turn-2240", "turn-retry"]);
  });
});

describe("a delivery ledger failure never fails the user's turn", () => {
  it("the turn still streams and completes when the record write throws", async () => {
    const store = await import("@/lib/assistant-turn-skill-delivery");
    vi.mocked(store.recordTurnSkillDelivery).mockRejectedValueOnce(
      new Error("relation does not exist"),
    );
    state.deliveryResult.exposure = bundleSkillIds().map((skillId) => ({
      skillId,
      deliveryMode: "openai_shell",
      invocationAttributable: true,
    }));

    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));

    expect(capturedStreamInput).not.toBeNull();
    expect(send).toHaveBeenCalledWith("done", {});
    expect(send).not.toHaveBeenCalledWith("error", expect.anything());
  });
});
