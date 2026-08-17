// THE PER-TURN PREFIX GATE (cinatra#2771).
//
// A chat turn used to ship a fixed ~24k-token prefix — the whole self-MCP tool
// catalog plus the system prompt — on every question, and the prefix was not
// byte-stable, so a provider could not reuse it either. Two levers, both driven
// here through the REAL `runAssistantTurn`:
//
//   LEVER 1 — selective exposure. The hosted self-MCP reference now carries the
//     turn's exposure list. A trivial turn must NOT carry all ~83 primitives,
//     and a turn that raises a topic must still reach that topic's tools.
//   LEVER 2 — a byte-stable, ordering-stable prefix. Two consecutively-built
//     turn payloads for the same conversation must produce a BYTE-IDENTICAL
//     cacheable projection (system string + tool block).
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. It proves what the HOST emits. It
// cannot prove what a provider bills: there is no provider key here and the
// connector adapters are separate extensions. `cached_input_tokens` is a live
// measurement and is stated as such on the PR, never inferred from a green
// test.
//
// The harness mirrors `cinatra-parity.test.ts`: the runtime itself is real,
// its leaf dependencies are stubbed, and `stream()` is captured. The self-MCP
// builder is stubbed so its ALLOWLIST ARGUMENT — the thing lever 1 wires — is
// observable directly.

import { describe, expect, it, vi, beforeEach } from "vitest";

import { delegatedChatAllowedToolNames } from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";

// --- captured seams --------------------------------------------------------
let capturedStreamInput: Record<string, unknown> | null = null;
/** The 4th argument of every `buildLlmMcpServerToolForChat` call. */
const capturedExposures: Array<string[] | null | undefined> = [];

const SYSTEM_BODY = "SYSTEM_PROMPT_BODY";
const CONFIRMATION_POLICY = "\n\nCONFIRMATION_POLICY";

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
vi.mock("@/lib/wizard-manifest-registry", () => ({ getAllManifests: vi.fn(async () => []) }));
// The token issuer is stubbed to a CONSTANT here on purpose: its own
// byte-stability is pinned by `src/lib/__tests__/chat-mcp-actor-token.test.ts`,
// and holding it fixed keeps this file's subject the RUNTIME's contribution to
// the prefix rather than the token's.
vi.mock("@/lib/chat-mcp-actor-token", () => ({
  issueChatMcpActorToken: vi.fn(() => "stable-chat-token"),
}));
vi.mock("@/lib/widget-mcp-actor-token", () => ({
  issueWidgetMcpActorToken: vi.fn(() => "stable-widget-token"),
}));
vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: () => null }));
vi.mock("@/lib/artifacts/attachment-resolver-ports", () => ({
  buildAttachmentResolverPorts: vi.fn(() => ({})),
}));
vi.mock("@/lib/agent-run-skills-used", () => ({
  recordTurnSkillDelivery: vi.fn(async () => 0),
}));
vi.mock("@cinatra-ai/llm", () => ({
  hasConfiguredLlmRuntime: vi.fn(async () => true),
  checkPublicMcpReachability: vi.fn(async () => ({
    status: "reachable",
    url: "https://mcp.example.test/api/mcp",
  })),
  resolveDefaultAdapter: vi.fn(async () => ({ provider: "openai", defaultModel: "gpt-5.5" })),
  resolveBoundDefaultAdapter: vi.fn(async () => ({ provider: "openai", defaultModel: "gpt-5.5" })),
  BoundDefaultProviderUnavailableError: class extends Error {},
  selectSkillDeliveryAdapter: vi.fn(() => ({
    provider: "openai",
    deliver: vi.fn(async () => ({
      tools: [{ type: "function", name: "shell" }],
      systemContext: "",
      exposure: [],
    })),
  })),
  deliverInjectedSkillsInline: vi.fn(async () => ({
    systemContext: "",
    exposure: [],
    dropped: [],
  })),
  resolveChatExternalMcpTools: vi.fn(async () => []),
  buildLlmMcpServerToolForChat: vi.fn(
    async (
      _provider: unknown,
      _actor: unknown,
      issueActorToken: (a: unknown) => string,
      allowedTools?: string[] | null,
    ) => {
      capturedExposures.push(allowedTools);
      // The REAL builder's shape: the exposure list and the bearer both ride
      // the tool, so both land in the cacheable projection below.
      return {
        type: "mcp",
        name: "cinatra",
        serverLabel: "cinatra",
        serverUrl: "https://mcp.example.test/api/mcp",
        headers: { Authorization: `Bearer ${issueActorToken({})}` },
        allowedTools: allowedTools ?? null,
      };
    },
  ),
  buildLlmMcpServerToolForWidget: vi.fn(async () => ({
    type: "mcp",
    name: "cinatra",
    serverLabel: "cinatra",
  })),
  stream: vi.fn(async (input: Record<string, unknown>) => {
    capturedStreamInput = input;
    (input.onTextDelta as (d: string) => void)?.("ok");
  }),
}));

import { runAssistantTurn } from "../runtime";
import { buildCinatraAssistantRuntimeConfig } from "../cinatra-assistant-config";

const ALL_ALLOWED = delegatedChatAllowedToolNames();

function turnArgs(
  send: (event: string, data: unknown) => void,
  contents: string[],
) {
  return {
    messages: contents.map((content, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content,
    })),
    actorContext: { actorType: "user", userId: "u1" } as never,
    userId: "u1",
    platformRole: "member" as const,
    sessionOrgId: null,
    send,
    turnIdentity: { turnId: "turn-2771", runId: "run-2771" },
  };
}

async function runTurn(contents: string[]) {
  capturedStreamInput = null;
  await runAssistantTurn(
    buildCinatraAssistantRuntimeConfig(),
    turnArgs(vi.fn(), contents),
  );
  return capturedStreamInput!;
}

/**
 * The CACHEABLE PROJECTION: the ordered system string plus the tool block, and
 * nothing that legitimately differs between turns (the conversation itself, the
 * turn/run ids, the abort signal, the callbacks).
 */
function cacheablePrefix(input: Record<string, unknown>): string {
  return JSON.stringify({
    model: input.model ?? null,
    system: input.system ?? null,
    tools: input.tools ?? null,
  });
}

beforeEach(() => {
  capturedStreamInput = null;
  capturedExposures.length = 0;
});

// ---------------------------------------------------------------------------
// LEVER 1 — selective exposure
// ---------------------------------------------------------------------------
describe("lever 1: a turn pays only for the tools it can plausibly use", () => {
  it("a trivial turn does NOT carry the whole catalog", async () => {
    await runTurn(["hi"]);
    const exposure = capturedExposures.at(-1);
    expect(Array.isArray(exposure)).toBe(true);
    expect(exposure!.length).toBeGreaterThan(0);
    expect(exposure!.length).toBeLessThan(ALL_ALLOWED.length);
    expect(exposure).not.toContain("dashboards_cube_load");
    expect(exposure).not.toContain("crm_contact_search");
    expect(exposure).not.toContain("metric_cost_summary");
  });

  it("the exposure list rides the self-MCP tool the model is handed", async () => {
    const input = await runTurn(["hi"]);
    const tools = input.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: "mcp", serverLabel: "cinatra" });
    expect(tools[0].allowedTools).toEqual(capturedExposures.at(-1));
  });

  it("a trivial turn keeps the discovery + dispatch floor", async () => {
    await runTurn(["which connectors are active?"]);
    const exposure = capturedExposures.at(-1)!;
    for (const name of ["connector_inventory_list", "agent_list", "agent_run", "agent_run_get"]) {
      expect(exposure).toContain(name);
    }
  });

  it("a topical turn reaches that topic's tools (no behavior change)", async () => {
    await runTurn(["build me a dashboard of spend by agent"]);
    const exposure = capturedExposures.at(-1)!;
    expect(exposure).toContain("dashboards_cube_load");
    expect(exposure).toContain("metric_cost_by_agent");
    // and the floor is still there
    expect(exposure).toContain("agent_run");
  });

  it("the FULL catalog is still reachable in one plain-language step", async () => {
    await runTurn(["show me all tools you have"]);
    expect(capturedExposures.at(-1)).toEqual([...ALL_ALLOWED]);
  });

  it("every exposed name is chat-allowed (the list can never widen reach)", async () => {
    const allowed = new Set(ALL_ALLOWED);
    await runTurn(["purge the extension and chart the crm contacts"]);
    for (const name of capturedExposures.at(-1)!) {
      expect(allowed.has(name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// LEVER 2 — a byte-stable, ordering-stable prefix
// ---------------------------------------------------------------------------
describe("lever 2: the cacheable prefix is byte-identical across turns", () => {
  it("two consecutively-built payloads for the same conversation match exactly", async () => {
    const first = cacheablePrefix(await runTurn(["hi"]));
    const second = cacheablePrefix(await runTurn(["hi"]));
    expect(second).toBe(first);
  });

  it("a second turn of the SAME conversation keeps the whole prefix", async () => {
    // Same topic set (none), one more message — the tool block and the system
    // string must not move.
    const first = cacheablePrefix(await runTurn(["hi"]));
    const second = cacheablePrefix(await runTurn(["hi", "Hello!", "thanks"]));
    expect(second).toBe(first);
  });

  it("the stable head survives a turn that adds volatile tail content", async () => {
    const first = (await runTurn(["hi"])).system as string;
    const second = (await runTurn(["hi", "Hello!", "and now the dashboard"]))
      .system as string;
    // The persona + confirmation policy head is byte-identical; only the tail
    // may differ. (Here nothing differs, which is the stronger statement.)
    expect(second.startsWith(SYSTEM_BODY)).toBe(true);
    expect(first.startsWith(SYSTEM_BODY)).toBe(true);
    expect(second.indexOf(CONFIRMATION_POLICY)).toBe(
      first.indexOf(CONFIRMATION_POLICY),
    );
  });

  it("puts the volatile user context AFTER the stable head", async () => {
    const system = (await runTurn(["hi"])).system as string;
    expect(system.indexOf(SYSTEM_BODY)).toBeLessThan(
      system.indexOf(CONFIRMATION_POLICY),
    );
    expect(system.indexOf(CONFIRMATION_POLICY)).toBeLessThan(
      system.indexOf("User context:"),
    );
  });

  it("emits the exposure list in a canonical, sorted order", async () => {
    await runTurn(["chart the crm dashboard"]);
    const exposure = capturedExposures.at(-1)!;
    expect([...exposure]).toEqual([...new Set(exposure)].sort());
  });

  it("two turns on the same topic emit the same tool block bytes", async () => {
    const first = JSON.stringify((await runTurn(["show me a dashboard"])).tools);
    const second = JSON.stringify(
      (await runTurn(["open another dashboard please"])).tools,
    );
    expect(second).toBe(first);
  });
});
