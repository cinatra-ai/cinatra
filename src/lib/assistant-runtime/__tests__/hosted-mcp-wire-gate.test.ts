// THE WIRE GATE — the self-MCP catalog reaches every provider as ONE hosted MCP
// reference, never as inline function schemas (cinatra#2776).
//
// WHY THIS EXISTS. The invariant has been re-established repeatedly (#500/#530,
// #1037/#1304, #1699/#1709, #1715/#1972) and nothing in CI asserted it
// END-TO-END. The two guards that looked like they did, do not:
//   · `cinatra-parity.test.ts` asserts the RUNTIME supplies an MCP entry, with
//     both the MCP builder and `stream()` mocked — it never reaches connector
//     serialization;
//   · the connectors' own serialization tests mock the provider SDK module, so
//     they capture the adapter's PRE-SDK request object, not the wire body.
// A serializer that KEPT the MCP entry and ALSO appended flattened function
// schemas passes both. This gate is the one that fails.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SEAM, STATED EXACTLY (what is real here and what is fixtured)
//
// REAL, and the reason this file exists:
//   · `runAssistantTurn` — the real chat/widget turn producer, including the
//     #2776 `capabilityRequired: "native_mcp"` pin and the whole tool assembly;
//   · the PROVIDER ADAPTERS, resolved through the versioned
//     `llm-provider-adapter` capability registry (`getLlmProviderAdapterSurface`,
//     the same fail-closed resolver `packages/llm` uses) — the connectors' real
//     translation code, not a stand-in;
//   · the provider SDKs (`openai`, `@anthropic-ai/sdk`, `@google/genai`) — the
//     bodies asserted below are the JSON those SDKs actually serialized;
//   · the authoritative tool-policy allow sets
//     (`delegatedChatAllowedToolNames()` / `delegatedWidgetAllowedToolNames()`),
//     and the provider capability matrix that parameterizes the cases.
//
// FIXTURED, deliberately, because it is ambient configuration and not the
// subject: the delegated MCP actor tokens + the public MCP URL (the self-MCP
// tool is handed over as the exact `LlmMcpServerTool` shape `mcp-access.ts`
// builds), the skill-delivery vehicle, the DB/session graph, and the connector
// host-deps (bound to inert stubs so no log write or DB read happens).
//
// THE CAPTURE POINT is `globalThis.fetch`. `createClient` in each connector has
// no injectable client/baseURL, and every SDK captures `fetch` AT CONSTRUCTION
// (`options.fetch ?? getDefaultFetch()`), so the interceptor is installed in
// `beforeEach` — BEFORE the runtime runs and therefore before `createAdapter`.
// Mocking the SDK module instead would only re-observe the pre-SDK object.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS ASSERTED (per surface: browser chat, widget/wordpress, widget/drupal)
//   1. exactly ONE self `type:"mcp"` entry (OpenAI) / ONE `mcp_servers[]` entry
//      plus its matching `mcp_toolset` (Anthropic native);
//   2. ZERO function/`input_schema` tools whose name is in the AUTHORITATIVE
//      allowed set for that surface — failures NAME the offending tools;
//   3. the dev-only 424 retry re-issues with NO MCP entry AND no flattened
//      catalog (it REMOVES, it never flattens);
//   4. Anthropic function-tools mode composed = HARD REFUSAL with
//      `native_mcp_capability_required` and ZERO provider/MCP egress;
//   5. Gemini: top-level `tools` ABSENT (asserted, never silently passing);
//   6. NEGATIVE CONTROL: a deliberately flattening serializer, driven through
//      the same real SDK, must make assertion 2 FAIL and name the tools.
// Counting is scoped to the RESERVED self-MCP reference: unrelated external MCP
// references and legitimate non-catalog function tools are permitted.
//
// Prefix stability is a REPORTED diagnostic at the end of this file, not a
// gated assertion (see its comment).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { WidgetPrincipal } from "../widget-principal";

// ---------------------------------------------------------------------------
// Hoisted mutable state (the mock factories below are hoisted above imports).
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  provider: "openai" as "openai" | "anthropic" | "gemini",
  defaultModel: "gpt-5.5",
  /** The self-MCP tool the runtime is handed — the exact shape
   *  `buildCinatraMcpServerTool` produces in `packages/llm/src/mcp-access.ts`. */
  selfMcpTool: null as Record<string, unknown> | null,
  /** Extra tools the skill-delivery vehicle contributes (legitimate,
   *  non-catalog function tools — they MUST survive to the wire). */
  deliveredTools: [] as Array<Record<string, unknown>>,
  /** The composed `stream()` stand-in's target: resolved per test. */
  streamImpl: null as ((input: Record<string, unknown>) => Promise<void>) | null,
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
vi.mock("@/lib/chat-mcp-actor-token", () => ({ issueChatMcpActorToken: vi.fn(() => "chat-token") }));
vi.mock("@/lib/widget-mcp-actor-token", () => ({
  issueWidgetMcpActorToken: vi.fn(() => "widget-token"),
}));
vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: () => null }));
vi.mock("@/lib/artifacts/attachment-resolver-ports", () => ({
  buildAttachmentResolverPorts: vi.fn(() => ({})),
}));
// The durable per-turn delivery record writes SQL; the record itself is pinned
// by its own suite. Replaced so this gate performs no DB I/O.
vi.mock("@/lib/agent-run-skills-used", () => ({
  recordTurnSkillDelivery: vi.fn(async () => 0),
}));

// The orchestration package. `stream()` is the ONE member replaced with a
// composed stand-in: it resolves the REAL adapter through the capability
// registry and forwards the runtime's input verbatim, exactly as
// `orchestrateStreamImpl` does for a `skipMcpInjection: true` chat turn (its
// MCP-injection step is a documented passthrough under that flag). Everything
// downstream of it — adapter, SDK, wire — is real.
vi.mock("@cinatra-ai/llm", () => ({
  hasConfiguredLlmRuntime: vi.fn(async () => true),
  describeLlmRuntimeUnavailability: vi.fn(async () => null),
  checkPublicMcpReachability: vi.fn(async () => ({
    status: "reachable",
    url: "https://mcp.example.test/api/mcp",
  })),
  resolveDefaultAdapter: vi.fn(async () => ({
    provider: state.provider,
    defaultModel: state.defaultModel,
  })),
  resolveBoundDefaultAdapter: vi.fn(async () => ({
    provider: state.provider,
    defaultModel: state.defaultModel,
  })),
  resolveProviderAdapter: vi.fn(async () => ({
    provider: state.provider,
    defaultModel: state.defaultModel,
  })),
  BoundDefaultProviderUnavailableError: class extends Error {},
  selectSkillDeliveryAdapter: vi.fn(() => ({
    provider: state.provider,
    deliver: vi.fn(async () => ({
      tools: state.deliveredTools,
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
  buildLlmMcpServerToolForChat: vi.fn(async () => state.selfMcpTool),
  buildLlmMcpServerToolForWidget: vi.fn(async () => state.selfMcpTool),
  stream: vi.fn(async (input: Record<string, unknown>) => {
    if (!state.streamImpl) throw new Error("no composed stream target installed");
    await state.streamImpl(input);
  }),
}));

import { runAssistantTurn } from "../runtime";
import { buildCinatraAssistantRuntimeConfig } from "../cinatra-assistant-config";
import {
  registerCapabilityProvider,
  invalidateProvidersForPackage,
} from "@/lib/extension-capabilities-registry";
import { getLlmProviderAdapterSurface } from "@/lib/llm-provider-surfaces";
import { BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS } from "@cinatra-ai/agents/llm-provider-policy";
import { delegatedChatAllowedToolNames } from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";
import { delegatedWidgetAllowedToolNames } from "@cinatra-ai/mcp-server/delegated-widget-tool-policy";
// The connectors' REAL adapter factories. Imported by path (the packages'
// `exports` maps do not publish the adapter module) — this file is a test, so
// the core→extension import ban's `__tests__` exemption applies.
import { createOpenAIProviderAdapter } from "../../../../extensions/cinatra-ai/openai-connector/src/adapter/openai-adapter";
import { registerOpenAIConnector } from "../../../../extensions/cinatra-ai/openai-connector/src/deps";
import { createAnthropicProviderAdapter } from "../../../../extensions/cinatra-ai/anthropic-connector/src/adapter/anthropic-adapter";
import { registerAnthropicConnector } from "../../../../extensions/cinatra-ai/anthropic-connector/src/deps";
import { createGeminiProviderAdapter } from "../../../../extensions/cinatra-ai/gemini-connector/src/adapter/gemini-adapter";
import { registerGeminiConnector } from "../../../../extensions/cinatra-ai/gemini-connector/src/deps";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLIC_MCP_URL = "https://mcp.example.test/api/mcp";

/** The self-MCP tool EXACTLY as `mcp-access.ts` builds it for chat/widget. */
function selfMcpToolFixture(): Record<string, unknown> {
  return {
    type: "mcp",
    serverLabel: "cinatra",
    serverUrl: PUBLIC_MCP_URL,
    headers: { Authorization: "Bearer delegated-actor-token" },
    serverDescription: "Cinatra enterprise intelligence MCP",
    allowedTools: null,
    approval: "auto_execute",
    transport: "streamable-http",
  };
}

/** An UNRELATED external MCP reference — permitted, and must not be miscounted
 *  as the reserved self-MCP one. */
function externalMcpToolFixture(): Record<string, unknown> {
  return {
    type: "mcp",
    serverLabel: "acme-crm",
    serverUrl: "https://mcp.acme.test/mcp",
    headers: { Authorization: "Bearer external" },
    serverDescription: "Acme CRM",
    allowedTools: null,
    approval: "auto_execute",
    transport: "streamable-http",
  };
}

/** A LEGITIMATE non-catalog function tool (the skill-delivery vehicle's). Its
 *  name is deliberately NOT in either allowed set, so it must survive. */
const LEGIT_FUNCTION_TOOL = {
  type: "function",
  name: "skill_file_read",
  description: "Read one staged skill file",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
} as const;

const WIDGET_PRINCIPALS: Record<"wordpress" | "drupal", WidgetPrincipal> = {
  wordpress: {
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
  drupal: {
    kind: "public_site_widget",
    userId: "u1",
    orgId: "o1",
    parentTokenJti: "cwu-row-2",
    instanceId: "dr-canonical",
    verifiedOrigin: "https://drupal.example.test",
    assistantHandle: "drupal",
    platformRole: "member",
    instancesConfigKey: "drupal_instances",
    lifecycleRead: false,
  },
};

type Surface =
  | { id: "browser chat"; widgetPrincipal: null; allowed: readonly string[] }
  | {
      id: "widget/wordpress" | "widget/drupal";
      widgetPrincipal: WidgetPrincipal;
      allowed: readonly string[];
    };

function surfaces(): Surface[] {
  return [
    { id: "browser chat", widgetPrincipal: null, allowed: delegatedChatAllowedToolNames() },
    {
      id: "widget/wordpress",
      widgetPrincipal: WIDGET_PRINCIPALS.wordpress,
      allowed: delegatedWidgetAllowedToolNames("wordpress"),
    },
    {
      id: "widget/drupal",
      widgetPrincipal: WIDGET_PRINCIPALS.drupal,
      allowed: delegatedWidgetAllowedToolNames("drupal"),
    },
  ];
}

function turnArgs(send: (event: string, data: unknown) => void, surface: Surface) {
  return {
    messages: [{ role: "user" as const, content: "hi" }],
    actorContext: { actorType: "user", userId: "u1" } as never,
    userId: "u1",
    platformRole: "member" as const,
    sessionOrgId: "o1",
    send,
    turnIdentity: { turnId: "turn-2776", runId: "run-2776" },
    widgetPrincipal: surface.widgetPrincipal,
  };
}

// ---------------------------------------------------------------------------
// The fetch interceptor — the wire boundary.
// ---------------------------------------------------------------------------

type CapturedRequest = { url: string; body: Record<string, unknown> };

const captured: CapturedRequest[] = [];
let responder: (req: CapturedRequest, callIndex: number) => Response = () => {
  throw new Error("no responder installed");
};
const REAL_FETCH = globalThis.fetch;

function installFetchInterceptor() {
  captured.length = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const rawBody =
      init?.body ??
      (typeof input === "object" && input !== null && "body" in (input as Request)
        ? await (input as Request).clone().text()
        : undefined);
    let body: Record<string, unknown> = {};
    if (typeof rawBody === "string") {
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        body = { __unparsed: rawBody };
      }
    }
    const req: CapturedRequest = { url, body };
    const index = captured.length;
    captured.push(req);
    return responder(req, index);
  }) as typeof globalThis.fetch;
}

function sse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Minimal, complete OpenAI Responses SSE: one final message, no tool calls. */
function openAiSse(): Response {
  const completed = {
    type: "response.completed",
    response: {
      id: "resp_2776",
      object: "response",
      status: "completed",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  };
  return sse([
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_2776", object: "response", status: "in_progress", output: [] } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
  ]);
}

/** OpenAI's hosted-MCP tool-list 424 (#500) — the shape the adapter classifies
 *  (`isHostedMcpToolListError` requires BOTH the 424 status and an MCP token). */
function openAiMcp424(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "Error retrieving tool list from MCP server: 'cinatra'",
        type: "external_connector_error",
        code: "http_error",
      },
    }),
    { status: 424, headers: { "content-type": "application/json" } },
  );
}

/** Minimal, complete Anthropic messages SSE: one text block, `end_turn`. */
function anthropicSse(): Response {
  const j = (o: unknown) => JSON.stringify(o);
  return sse([
    `event: message_start\ndata: ${j({ type: "message_start", message: { id: "msg_2776", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
    `event: content_block_start\ndata: ${j({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${j({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
    `event: content_block_stop\ndata: ${j({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${j({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`,
    `event: message_stop\ndata: ${j({ type: "message_stop" })}\n\n`,
  ]);
}

/** Minimal Gemini streamGenerateContent SSE. */
function geminiSse(): Response {
  const chunk = {
    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  };
  return sse([`data: ${JSON.stringify(chunk)}\r\n\r\n`]);
}

// ---------------------------------------------------------------------------
// Adapter resolution THROUGH the capability registry.
// ---------------------------------------------------------------------------

const TEST_PACKAGE = "@cinatra-ai/wire-gate-test-binding";
const LLM_PROVIDER_ADAPTER_CAPABILITY = "llm-provider-adapter";

type AdapterFactory = () => Promise<unknown>;

/** Register ONE provider's adapter factory under the versioned capability, the
 *  same channel `packages/llm` resolves through. `createAdapter` is where the
 *  connector's REAL factory is called (with a synthetic connection). */
function registerAdapterSurface(providerId: string, createAdapter: AdapterFactory) {
  registerCapabilityProvider(LLM_PROVIDER_ADAPTER_CAPABILITY, {
    packageName: TEST_PACKAGE,
    impl: { abiVersion: 1, providerId, createAdapter },
  });
}

type MinimalAdapter = { stream: (input: Record<string, unknown>) => Promise<void> };

/** The composed `stream()` stand-in: registry resolution + a verbatim forward. */
async function composedStream(input: Record<string, unknown>): Promise<void> {
  const surface = getLlmProviderAdapterSurface(String(input.provider));
  if (!surface) throw new Error(`no adapter surface registered for ${String(input.provider)}`);
  const adapter = (await surface.createAdapter()) as unknown as MinimalAdapter | null;
  if (!adapter) throw new Error("adapter surface returned no adapter");
  const {
    provider: _provider,
    actorContext: _actorContext,
    attachmentResolverPorts: _ports,
    onUsageData: _usage,
    executionSession: _session,
    executionAvailability: _availability,
    executionExecutor: _executor,
    executionEnvironment: _environment,
    ...rest
  } = input;
  await adapter.stream(rest);
}

// ---------------------------------------------------------------------------
// The assertions (shared, so the negative control drives the SAME code).
// ---------------------------------------------------------------------------

/** The reserved self-MCP references in an OpenAI Responses body. */
function openAiSelfMcpEntries(body: Record<string, unknown>) {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [];
  return tools.filter((t) => t.type === "mcp" && t.server_label === "cinatra");
}

function openAiFunctionToolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [];
  return tools
    .filter((t) => t.type === "function")
    .map((t) => String(t.name ?? ""))
    .filter(Boolean);
}

function anthropicInputSchemaToolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? (body.tools as Array<Record<string, unknown>>) : [];
  return tools
    .filter((t) => "input_schema" in t)
    .map((t) => String(t.name ?? ""))
    .filter(Boolean);
}

/**
 * THE assertion the gate exists for. Fails with the OFFENDING NAMES so a
 * regression is diagnosable from the CI log alone, with no local repro.
 */
function assertNoFlattenedCatalog(
  where: string,
  toolNames: readonly string[],
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const offenders = toolNames.filter((name) => allowedSet.has(name));
  if (offenders.length > 0) {
    throw new Error(
      `[hosted-mcp wire gate] ${where}: the self-MCP catalog was FLATTENED into ` +
        `${offenders.length} inline function tool(s) — the catalog must reach the ` +
        `model as ONE hosted MCP reference. Offending tool names: ${offenders.join(", ")}. ` +
        `(cinatra#2776)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Connector host-deps — inert stubs so no log write / DB read happens.
// ---------------------------------------------------------------------------

function registerInertConnectorDeps() {
  registerOpenAIConnector({
    // openai logging: unset ⇒ OFF, so the writer no-ops.
    readOpenAIConnectionFromDatabase: () => null,
    readConnectorConfigFromDatabase: <T,>(_id: string, fallback: T) => fallback,
    isAppDevelopmentMode: () => false,
  } as never);
  registerAnthropicConnector({
    // anthropic logging defaults ON (`enabled !== false`) — turn it OFF here.
    readConnectorConfigFromDatabase: <T,>(id: string, fallback: T) =>
      (id === "anthropic-logging" ? ({ enabled: false } as unknown as T) : fallback),
    readAnthropicConnectionFromDatabase: () => null,
    isAppDevelopmentMode: () => false,
  } as never);
  registerGeminiConnector({
    readConnectorConfigFromDatabase: <T,>(_id: string, fallback: T) => fallback,
    isAppDevelopmentMode: () => false,
    // Folded into every Gemini request's headers by
    // `buildGeminiRequestHeaders`; empty here (the host's self-client headers
    // are not part of what this gate measures).
    buildAppMcpSelfClientHeaders: () => ({}),
  } as never);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const ORIGINAL_RUNTIME_MODE = process.env.CINATRA_RUNTIME_MODE;

beforeEach(() => {
  invalidateProvidersForPackage(TEST_PACKAGE);
  registerInertConnectorDeps();
  state.selfMcpTool = selfMcpToolFixture();
  state.deliveredTools = [{ ...LEGIT_FUNCTION_TOOL }];
  state.streamImpl = composedStream;
  // Installed BEFORE any turn runs, therefore before adapter construction.
  installFetchInterceptor();
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  invalidateProvidersForPackage(TEST_PACKAGE);
  if (ORIGINAL_RUNTIME_MODE === undefined) delete process.env.CINATRA_RUNTIME_MODE;
  else process.env.CINATRA_RUNTIME_MODE = ORIGINAL_RUNTIME_MODE;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The provider matrix is the parameterization source (NOT the adapter
// registry): native-MCP capability is declared THERE
// (packages/agents/src/llm-provider-policy.ts), so a provider added to the
// matrix without a case here fails this suite loudly instead of being skipped.
// ---------------------------------------------------------------------------

const COVERED_PROVIDERS = new Set(["openai", "anthropic", "gemini"]);

describe("provider coverage is driven by the declared capability matrix", () => {
  it("every provider in the matrix has a case in this gate", () => {
    const declared = Object.keys(BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS);
    const uncovered = declared.filter((p) => !COVERED_PROVIDERS.has(p));
    expect(
      uncovered,
      `providers declared in the capability matrix with no wire-gate case: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("the matrix still classifies the three providers this gate encodes", () => {
    const m = BUILD_KNOWN_LLM_PROVIDER_DECLARATIONS;
    expect(m.openai.capabilities.native_mcp).toMatchObject({ status: "native" });
    expect(m.anthropic.capabilities.native_mcp).toMatchObject({ status: "native" });
    expect(m.gemini.capabilities.native_mcp).toMatchObject({ status: "unsupported" });
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe("OpenAI — the self-MCP catalog is ONE hosted reference at the wire", () => {
  beforeEach(() => {
    state.provider = "openai";
    state.defaultModel = "gpt-5.5";
    registerAdapterSurface("openai", async () =>
      createOpenAIProviderAdapter({ apiKey: "sk-wire-gate-test" }),
    );
    responder = () => openAiSse();
  });

  for (const surface of surfaces()) {
    it(`${surface.id}: exactly one self type:"mcp" entry and ZERO policy-allowed function tools`, async () => {
      const send = vi.fn();
      await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), turnArgs(send, surface));

      const errorFrames = send.mock.calls.filter((c) => c[0] === "error");
      expect(errorFrames, `unexpected error frame: ${JSON.stringify(errorFrames)}`).toEqual([]);
      expect(captured.length, "no provider request reached the wire").toBeGreaterThan(0);

      const body = captured[0].body;
      expect(captured[0].url).toContain("/responses");
      expect(openAiSelfMcpEntries(body)).toHaveLength(1);
      assertNoFlattenedCatalog(
        `openai / ${surface.id}`,
        openAiFunctionToolNames(body),
        surface.allowed,
      );
      // The legitimate non-catalog function tool is PERMITTED and survives.
      expect(openAiFunctionToolNames(body)).toContain("skill_file_read");
    });
  }

  it("an unrelated external MCP reference is permitted and never miscounted", async () => {
    const send = vi.fn();
    const llm = await import("@cinatra-ai/llm");
    vi.mocked(llm.resolveChatExternalMcpTools).mockResolvedValueOnce([
      externalMcpToolFixture(),
    ] as never);

    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      turnArgs(send, surfaces()[0]),
    );

    const body = captured[0].body;
    const allMcp = (body.tools as Array<Record<string, unknown>>).filter((t) => t.type === "mcp");
    expect(allMcp).toHaveLength(2);
    // Only the RESERVED self reference is counted.
    expect(openAiSelfMcpEntries(body)).toHaveLength(1);
  });

  it("the dev-only 424 retry REMOVES the MCP entry and flattens NOTHING", async () => {
    process.env.CINATRA_RUNTIME_MODE = "development";
    responder = (_req, index) => (index === 0 ? openAiMcp424() : openAiSse());

    const send = vi.fn();
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      turnArgs(send, surfaces()[0]),
    );

    expect(captured.length, "the dev retry did not re-issue the request").toBeGreaterThan(1);
    const retryBody = captured[captured.length - 1].body;
    // The fallback REMOVES; it never flattens.
    expect(openAiSelfMcpEntries(retryBody)).toHaveLength(0);
    expect(
      (retryBody.tools as Array<Record<string, unknown>>).filter((t) => t.type === "mcp"),
    ).toHaveLength(0);
    assertNoFlattenedCatalog(
      "openai / dev-424 retry",
      openAiFunctionToolNames(retryBody),
      delegatedChatAllowedToolNames(),
    );
  });

  // NEGATIVE CONTROL — a serializer forced to flatten, driven through the SAME
  // real SDK to the SAME wire. Proves the assertion fires AND names the tools.
  it("NEGATIVE CONTROL: a flattening serializer fails the gate and NAMES the tools", async () => {
    const flattened = delegatedChatAllowedToolNames().slice(0, 3);
    expect(flattened.length, "the chat allow-list is empty — the control is vacuous").toBe(3);

    invalidateProvidersForPackage(TEST_PACKAGE);
    registerAdapterSurface("openai", async () => {
      const real = createOpenAIProviderAdapter({ apiKey: "sk-wire-gate-test" }) as unknown as {
        stream: (input: Record<string, unknown>) => Promise<void>;
      };
      return {
        ...real,
        // The exact regression class: keep the MCP entry AND append the
        // catalog as inline function schemas.
        stream: (input: Record<string, unknown>) =>
          real.stream({
            ...input,
            tools: [
              ...(input.tools as unknown[]),
              ...flattened.map((name) => ({
                type: "function",
                name,
                description: `flattened ${name}`,
                parameters: { type: "object", properties: {} },
              })),
            ],
          }),
      };
    });

    const send = vi.fn();
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      turnArgs(send, surfaces()[0]),
    );

    const body = captured[0].body;
    // The one hosted reference is still there — which is exactly why the
    // MCP-entry count alone would MISS this regression.
    expect(openAiSelfMcpEntries(body)).toHaveLength(1);

    let thrown: Error | null = null;
    try {
      assertNoFlattenedCatalog(
        "openai / negative control",
        openAiFunctionToolNames(body),
        delegatedChatAllowedToolNames(),
      );
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown, "the gate did NOT fire on a flattened catalog").not.toBeNull();
    for (const name of flattened) expect(thrown!.message).toContain(name);
  });
});

// ---------------------------------------------------------------------------
// Anthropic — native mode
// ---------------------------------------------------------------------------

describe("Anthropic native — one mcp_servers entry + one matching mcp_toolset", () => {
  beforeEach(() => {
    state.provider = "anthropic";
    state.defaultModel = "claude-sonnet-4-6";
    registerAdapterSurface("anthropic", async () =>
      createAnthropicProviderAdapter({ apiKey: "sk-ant-wire-gate", mcpMode: "native" } as never),
    );
    responder = () => anthropicSse();
  });

  for (const surface of surfaces()) {
    it(`${surface.id}: hosted MCP reference present, ZERO policy-allowed input_schema tools`, async () => {
      const send = vi.fn();
      await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), turnArgs(send, surface));

      const errorFrames = send.mock.calls.filter((c) => c[0] === "error");
      expect(errorFrames, `unexpected error frame: ${JSON.stringify(errorFrames)}`).toEqual([]);
      expect(captured.length, "no provider request reached the wire").toBeGreaterThan(0);

      const body = captured[0].body;
      // Tested through the BETA stream endpoint (the only one carrying
      // `mcp_servers`) — the correction the plan makes explicit.
      expect(captured[0].url).toContain("/v1/messages");
      expect(body.stream).toBe(true);

      const servers = (body.mcp_servers ?? []) as Array<Record<string, unknown>>;
      const selfServers = servers.filter((s) => s.name === "cinatra");
      expect(selfServers).toHaveLength(1);

      const toolsets = ((body.tools ?? []) as Array<Record<string, unknown>>).filter(
        (t) => t.type === "mcp_toolset",
      );
      expect(toolsets.filter((t) => t.mcp_server_name === "cinatra")).toHaveLength(1);

      assertNoFlattenedCatalog(
        `anthropic / ${surface.id}`,
        anthropicInputSchemaToolNames(body),
        surface.allowed,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Anthropic — function-tools mode, composed: HARD REFUSAL, zero egress
// ---------------------------------------------------------------------------

describe("Anthropic function-tools mode is a HARD REFUSAL on chat + widget", () => {
  beforeEach(() => {
    state.provider = "anthropic";
    state.defaultModel = "claude-sonnet-4-6";
    registerAdapterSurface("anthropic", async () =>
      createAnthropicProviderAdapter({
        apiKey: "sk-ant-wire-gate",
        mcpMode: "function-tools",
      } as never),
    );
    responder = () => {
      throw new Error("EGRESS: a refused turn must not reach the network");
    };
  });

  for (const surface of surfaces()) {
    it(`${surface.id}: refuses with native_mcp_capability_required and ZERO egress`, async () => {
      const send = vi.fn();
      await runAssistantTurn(buildCinatraAssistantRuntimeConfig(), turnArgs(send, surface));

      // No provider request, and no MCP `tools/list` fetch either.
      expect(captured, `egress on a refused turn: ${JSON.stringify(captured)}`).toEqual([]);

      const errorFrames = send.mock.calls.filter((c) => c[0] === "error");
      expect(errorFrames).toHaveLength(1);
      const frame = errorFrames[0][1] as { code?: string; message?: string };
      expect(frame.code).toBe("native_mcp_capability_required");
      expect(frame.message).toBe(
        "This chat requires Anthropic native MCP, but the connector is configured " +
          "for function-tools or the native MCP request failed. Switch the Anthropic " +
          "MCP mode to native or re-run AI setup, then retry.",
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Gemini — conversation-only: top-level `tools` ABSENT
// ---------------------------------------------------------------------------

describe("Gemini — conversation-only, with NO tools block on the wire", () => {
  beforeEach(() => {
    state.provider = "gemini";
    state.defaultModel = "gemini-2.5-flash";
    registerAdapterSurface("gemini", async () => createGeminiProviderAdapter("gemini-wire-gate"));
    responder = () => geminiSse();
  });

  it("the request carries NO top-level tools key (asserted, not silently passing)", async () => {
    const send = vi.fn();
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      turnArgs(send, surfaces()[0]),
    );

    const errorFrames = send.mock.calls.filter((c) => c[0] === "error");
    expect(errorFrames, `unexpected error frame: ${JSON.stringify(errorFrames)}`).toEqual([]);
    expect(captured.length, "no provider request reached the wire").toBeGreaterThan(0);

    const body = captured[0].body;
    expect(captured[0].url).toContain("streamGenerateContent");
    // The degraded shape is ABSENCE, not an empty container: a
    // `"tools":[{"functionDeclarations":[]}]` block is a real defect
    // (cinatra#2776 item 4) and fails here.
    expect(Object.keys(body)).not.toContain("tools");
    expect(JSON.stringify(body)).not.toContain("functionDeclarations");
  });

  it("Gemini is never handed the self-MCP toolbox nor the native_mcp requirement", async () => {
    const send = vi.fn();
    const llm = await import("@cinatra-ai/llm");
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      turnArgs(send, surfaces()[0]),
    );
    expect(vi.mocked(llm.buildLlmMcpServerToolForChat)).not.toHaveBeenCalled();
    const streamInput = vi.mocked(llm.stream).mock.calls[0][0] as Record<string, unknown>;
    expect("capabilityRequired" in streamInput).toBe(false);
    expect(streamInput.tools).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PREFIX STABILITY — a REPORTED diagnostic, NOT a gated assertion.
//
// The prompt-cache precondition (#2771 lever 2) is byte-equality of the
// cacheable PREFIX across two identical-config turns. It is reported, never
// gated: a log-only comparison must not be dressed up as a passing assertion,
// and provider-side cache accounting cannot be established against a fake
// endpoint. The projection is canonical and credential-free — headers'
// Authorization / authorization_token redacted, conversation input and
// turn/run ids excluded.
// ---------------------------------------------------------------------------

function redactAuth(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuth);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "Authorization" || k === "authorization" || k === "authorization_token") {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = redactAuth(v);
    }
    return out;
  }
  return value;
}

/** The cacheable prefix: the ordered system prompt + tool block, nothing else. */
function cacheablePrefixProjection(body: Record<string, unknown>): string {
  return JSON.stringify({
    model: body.model ?? null,
    system: body.instructions ?? body.system ?? null,
    tools: redactAuth(body.tools ?? null),
    mcp_servers: redactAuth(body.mcp_servers ?? null),
  });
}

describe("prefix stability (REPORTED diagnostic — not a gate)", () => {
  beforeEach(() => {
    state.provider = "openai";
    state.defaultModel = "gpt-5.5";
    registerAdapterSurface("openai", async () =>
      createOpenAIProviderAdapter({ apiKey: "sk-wire-gate-test" }),
    );
    responder = () => openAiSse();
  });

  it("reports byte-equality of the cacheable projection across two identical turns", async () => {
    const send = vi.fn();
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      turnArgs(send, surfaces()[0]),
    );
    const first = cacheablePrefixProjection(captured[0].body);

    captured.length = 0;
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      turnArgs(send, surfaces()[0]),
    );
    const second = cacheablePrefixProjection(captured[0].body);

    // REPORT — deliberately not an equality assertion.
    console.info(
      `[hosted-mcp wire gate] prefix-stability diagnostic: ` +
        `${first === second ? "STABLE" : "UNSTABLE"} ` +
        `(${first.length} vs ${second.length} bytes)`,
    );
    // The only thing asserted is that the diagnostic actually ran on two real
    // captured prefixes — never that they matched.
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
  });
});
