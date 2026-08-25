// Cinatra-assistant runtime PARITY test (cinatra-ai/cinatra#1037 P2a, item 4).
//
// Proves the extracted `runAssistantTurn`, driven with the Cinatra assistant's
// reference `assistant_config` (chat-assistant-core bundle), reproduces the
// pre-extraction `runChatTurn` behaviour byte-for-byte on the covered path:
//   - the exact former CHAT_* constants (skill ids, system skill id, tool-round
//     ceiling) come out of the reference runtime config;
//   - the `stream()` call receives the same system-prompt assembly ORDER, the
//     same tool array (self-MCP + external + skill tools + web_search), the same
//     `skipMcpInjection: true`, and `maxSteps: 24`;
//   - empty allow-lists apply NO tool filter and empty modelPrefs pass NO
//     `model` override (both byte-identical to the legacy chat);
//   - the SSE sink mapping is unchanged (text delta → "text", terminal "done").
//
// The heavy import graph is mocked (the runtime itself is exercised — only its
// leaf dependencies are stubbed), and the single `stream()` input is captured
// and asserted.

import { describe, expect, it, vi, beforeEach } from "vitest";

// --- captured stream input -------------------------------------------------
let capturedStreamInput: Record<string, unknown> | null = null;

// --- known context fragments the runtime concatenates ----------------------
const SYSTEM_BODY = "SYSTEM_PROMPT_BODY";
const CONFIRMATION_POLICY = "\n\nCONFIRMATION_POLICY";

vi.mock("@/lib/register-host-connector-services", () => ({}));

vi.mock("@/app/api/chat/chat-user-context", () => ({
  // The runtime wraps sections into "\n\nUser context:\n<...>"; return no
  // sections here so the wrapper is deterministic and formatting-rule only.
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
vi.mock("@/lib/wizard-staging-store", () => ({
  getAllStagedByType: () => [],
}));
vi.mock("@/lib/wizard-manifest-registry", () => ({
  getAllManifests: vi.fn(async () => []),
}));
vi.mock("@/lib/chat-mcp-actor-token", () => ({
  issueChatMcpActorToken: vi.fn(),
}));
// cinatra#2776: the widget arm below drives the SAME runtime through the
// widget-principal branch, so its token issuer has to be stubbed too.
vi.mock("@/lib/widget-mcp-actor-token", () => ({
  issueWidgetMcpActorToken: vi.fn(),
}));
vi.mock("@/lib/instance-identity-store", () => ({
  // No instance identity → buildInstanceContext returns "".
  readInstanceIdentity: () => null,
}));
vi.mock("@/lib/artifacts/attachment-resolver-ports", () => ({
  buildAttachmentResolverPorts: vi.fn(() => ({})),
}));
vi.mock("@cinatra-ai/llm", () => ({
  hasConfiguredLlmRuntime: vi.fn(async () => true),
  // Dead-ingress guard (#1699): the runtime probes before attaching the MCP
  // tool; parity tests run with a live (reachable) URL.
  checkPublicMcpReachability: vi.fn(async () => ({
    status: "reachable",
    url: "https://mcp.example.test/api/mcp",
  })),
  // S6 exact binding (cinatra#2093): the runtime resolves the STORED provider
  // through `resolveBoundDefaultAdapter`, which THROWS a named error instead of
  // returning null so an unavailable stored provider is a VISIBLE failure.
  resolveDefaultAdapter: vi.fn(async () => ({
    provider: "openai",
    defaultModel: "gpt-4o",
  })),
  resolveBoundDefaultAdapter: vi.fn(async () => ({
    provider: "openai",
    defaultModel: "gpt-4o",
  })),
  BoundDefaultProviderUnavailableError: class BoundDefaultProviderUnavailableError extends Error {},
  // cinatra#2091 S4: the runtime routes skill delivery through the provider
  // seam instead of calling buildSkillTools directly. The stub returns the same
  // single shell tool the previous buildSkillTools stub did, so the assembled
  // tool array stays byte-identical.
  selectSkillDeliveryAdapter: vi.fn(() => ({
    provider: "openai",
    deliver: vi.fn(async () => ({
      tools: [{ type: "function", name: "shell" }],
      systemContext: "",
      exposure: [],
    })),
  })),
  // cinatra#2776: the Gemini (conversation-only) arm below reaches the inline
  // skill mechanism, so the seam has to exist on the mock.
  deliverInjectedSkillsInline: vi.fn(async () => ({
    systemContext: "",
    exposure: [],
    dropped: [],
  })),
  resolveChatExternalMcpTools: vi.fn(async () => []),
  buildLlmMcpServerToolForChat: vi.fn(async () => ({
    type: "mcp",
    name: "cinatra",
    serverLabel: "cinatra",
  })),
  buildLlmMcpServerToolForWidget: vi.fn(async () => ({
    type: "mcp",
    name: "cinatra",
    serverLabel: "cinatra",
  })),
  stream: vi.fn(async (input: Record<string, unknown>) => {
    capturedStreamInput = input;
    // Drive the callbacks the sink maps, exactly as the LLM layer would.
    (input.onTextDelta as (d: string) => void)?.("Hello");
  }),
}));

import { runAssistantTurn } from "../runtime";
import { resolveChatExternalMcpTools, resolveBoundDefaultAdapter } from "@cinatra-ai/llm";
import {
  buildCinatraAssistantRuntimeConfig,
  CINATRA_ASSISTANT_SKILL_BUNDLE,
  CINATRA_ASSISTANT_PERSONA,
} from "../cinatra-assistant-config";

const EXPECTED_SKILL_IDS = CINATRA_ASSISTANT_SKILL_BUNDLE.map(
  (slug) => `@cinatra-ai/chat:${slug}`,
);

function makeArgs(send: (event: string, data: unknown) => void) {
  return {
    messages: [{ role: "user" as const, content: "hi" }],
    actorContext: { actorType: "user", userId: "u1" } as never,
    userId: "u1",
    platformRole: "member" as const,
    sessionOrgId: null,
    send,
    // cinatra#2240 — every chat entry point mints a turn/run pair before the
    // producer runs; the runtime requires it to key the delivery record.
    turnIdentity: { turnId: "turn-parity", runId: "run-parity" },
  };
}

describe("Cinatra reference runtime config reproduces the legacy CHAT_* constants", () => {
  const cfg = buildCinatraAssistantRuntimeConfig();

  it("skillIds == the former CHAT_SKILL_IDS (namespaced chat-assistant bundle)", () => {
    expect(cfg.skillIds).toEqual(EXPECTED_SKILL_IDS);
  });
  it("systemSkillId == the former CHAT_SYSTEM_SKILL_ID", () => {
    expect(cfg.systemSkillId).toBe("@cinatra-ai/chat:chat-assistant-core");
  });
  it("maxToolRounds == the former MAX_TOOL_ROUNDS (24)", () => {
    expect(cfg.maxToolRounds).toBe(24);
  });
  it("fallbackPersona == the former inline system-prompt fallback", () => {
    expect(cfg.fallbackPersona).toBe(CINATRA_ASSISTANT_PERSONA);
  });
  it("carries empty allow-lists + empty modelPrefs (no restriction / default routing)", () => {
    expect(cfg.allowedTools).toEqual([]);
    expect(cfg.allowedAgents).toEqual([]);
    expect(cfg.modelPrefs).toEqual({});
  });
});

describe("runAssistantTurn(cinatra) → stream() byte-parity on the covered path", () => {
  beforeEach(() => {
    capturedStreamInput = null;
  });

  it("passes maxSteps=24, provider from the adapter, and skipMcpInjection", async () => {
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    expect(capturedStreamInput).not.toBeNull();
    expect(capturedStreamInput!.maxSteps).toBe(24);
    expect(capturedStreamInput!.provider).toBe("openai");
    expect(capturedStreamInput!.skipMcpInjection).toBe(true);
  });

  it("omits the `model` field (empty modelPrefs → connection default, byte-parity)", async () => {
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    expect("model" in (capturedStreamInput as object)).toBe(false);
  });

  it("assembles the system prompt stable-head-first (prompt + instanceCtx + policy, then userCtx)", async () => {
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    const system = capturedStreamInput!.system as string;
    // No explicit-dispatch directive (""), no instance identity ("").
    expect(system.startsWith(SYSTEM_BODY)).toBe(true);
    // The formatting-rule user-context wrapper is still present.
    expect(system).toContain("\n\nUser context:\n");
    // cinatra#2771 lever 2 — ORDER CHANGED DELIBERATELY. The user context
    // carries live wizard/staging state that chat tool calls mutate during the
    // same session, so it is a VOLATILE fragment and now follows the stable
    // head (persona → skills → instance namespace → confirmation policy). The
    // fragments themselves are unchanged; only their order is, so a provider
    // can reuse the head across turns instead of re-billing it.
    expect(system.indexOf(SYSTEM_BODY)).toBeLessThan(system.indexOf(CONFIRMATION_POLICY));
    expect(system.indexOf(CONFIRMATION_POLICY)).toBeLessThan(system.indexOf("User context:"));
  });

  it("assembles tools = [self-MCP, ...external, ...skill, web_search] with an empty allow-list (no filter)", async () => {
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    const tools = capturedStreamInput!.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(3);
    expect(tools[0]).toMatchObject({ type: "mcp", name: "cinatra" });
    expect(tools.some((t) => t.name === "shell")).toBe(true);
    expect(tools.some((t) => t.type === "web_search")).toBe(true);
  });

  it("maps the stream callbacks onto the legacy SSE vocabulary (text, done)", async () => {
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    expect(send).toHaveBeenCalledWith("text", { content: "Hello" });
    expect(send).toHaveBeenCalledWith("done", {});
  });

  it("resolves external MCP tools with the chat build context on a cookie-session turn (cinatra#2019 S4)", async () => {
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    // No widget principal ⇒ the surface is "chat" — a surface-gating toolbox
    // may emit here and ONLY here.
    expect(vi.mocked(resolveChatExternalMcpTools)).toHaveBeenCalledWith("openai", {
      surface: "chat",
    });
  });
});

// ---------------------------------------------------------------------------
// cinatra#2776 (owner ruling 2026-08-15) — the self-MCP toolbox is ALWAYS
// dispatched under `capabilityRequired: "native_mcp"`, so a connector that
// cannot deliver the catalog as one hosted MCP reference REFUSES the turn
// instead of flattening it into inline function schemas. The pin rides the
// toolbox: a provider that is never handed the toolbox is never handed the
// requirement either.
// ---------------------------------------------------------------------------
describe("the self-MCP toolbox pins native_mcp on the stream input (cinatra#2776)", () => {
  beforeEach(() => {
    capturedStreamInput = null;
  });

  it("OpenAI: capabilityRequired 'native_mcp' rides beside skipMcpInjection", async () => {
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    expect(capturedStreamInput!.skipMcpInjection).toBe(true);
    expect(capturedStreamInput!.capabilityRequired).toBe("native_mcp");
  });

  it("Anthropic: same pin — the ruling covers every native-MCP provider", async () => {
    vi.mocked(resolveBoundDefaultAdapter).mockResolvedValueOnce({
      provider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
    } as never);
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    expect(capturedStreamInput!.capabilityRequired).toBe("native_mcp");
  });

  it("the WIDGET surface pins it too — both chat surfaces carry the same toolbox", async () => {
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), {
      ...makeArgs(send),
      sessionOrgId: "o1",
      widgetPrincipal: {
        kind: "public_site_widget",
        userId: "u1",
        orgId: "o1",
        parentTokenJti: "cwu-row-1",
        instanceId: "wp-canonical",
        verifiedOrigin: "https://wp.example.test",
        assistantHandle: "wordpress",
        platformRole: "member",
        instancesConfigKey: "wordpress_instances",
        lifecycleRead: false,
      },
    } as never);
    expect(capturedStreamInput!.capabilityRequired).toBe("native_mcp");
  });

  it("Gemini: NO self-MCP toolbox ⇒ NO requirement (the field is absent, not undefined)", async () => {
    vi.mocked(resolveBoundDefaultAdapter).mockResolvedValueOnce({
      provider: "gemini",
      defaultModel: "gemini-2.5-flash",
    } as never);
    const send = vi.fn();
    await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), makeArgs(send));
    // Conversation-only: no tools at all, and the adapter input keeps exactly
    // the field set it had before #2776.
    expect(capturedStreamInput!.tools).toEqual([]);
    expect("capabilityRequired" in (capturedStreamInput as object)).toBe(false);
  });
});

describe("runAssistantTurn honours the runtime config (parameterization is real)", () => {
  beforeEach(() => {
    capturedStreamInput = null;
  });

  it("a non-default maxToolRounds flows through to stream.maxSteps", async () => {
    const send = vi.fn();
    const cfg = { ...buildCinatraAssistantRuntimeConfig(), maxToolRounds: 7 };
    await runAssistantTurn(cfg, makeArgs(send));
    expect(capturedStreamInput!.maxSteps).toBe(7);
  });

  it("a modelPrefs.model override is passed to stream", async () => {
    const send = vi.fn();
    const cfg = {
      ...buildCinatraAssistantRuntimeConfig(),
      modelPrefs: { model: "gpt-5-mini" },
    };
    await runAssistantTurn(cfg, makeArgs(send));
    expect(capturedStreamInput!.model).toBe("gpt-5-mini");
  });

  it("a non-empty allowedTools filters named tools (self-MCP kept, unlisted named tool dropped)", async () => {
    const send = vi.fn();
    const cfg = {
      ...buildCinatraAssistantRuntimeConfig(),
      allowedTools: ["cinatra"], // allow only the self-MCP by name
    };
    await runAssistantTurn(cfg, makeArgs(send));
    const tools = capturedStreamInput!.tools as Array<Record<string, unknown>>;
    // "shell" is a named tool NOT in the allow-list → filtered out.
    expect(tools.some((t) => t.name === "shell")).toBe(false);
    // The self-MCP (name "cinatra") is kept; web_search has no name → kept.
    expect(tools.some((t) => t.name === "cinatra")).toBe(true);
    expect(tools.some((t) => t.type === "web_search")).toBe(true);
  });
});
