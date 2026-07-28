// Scripted-test-provider short-circuit for the public-site widget path
// (cinatra#1919 AC3). Proves `runAssistantTurn`:
//   1. REAL SEAM — under the deterministic provider + a widget principal, it
//      streams the deterministic content-editor reply (sentinel text; an edit
//      intent adds a `*_content_editor_run` tool_call + tool_result) through the
//      SAME `send` sink the real turn uses, WITHOUT resolving an adapter — so the
//      widget renders its answer instead of "No LLM provider configured.".
//   2. PROD-MODE CONFORMANCE PIN — with the flag OFF, the widget path is
//      UNCHANGED: it still resolves the default adapter and (when none) fails with
//      "No LLM provider configured." (adapter resolution untouched).
//   3. SCOPE — the short-circuit is gated to the widget path; the cookie-session
//      `@cinatra` path (no widget principal) is NEVER short-circuited even with
//      the flag on, so its host-`stream()` scripted seam is unaffected.
//
// The heavy import graph is mocked; the REAL `@cinatra-ai/llm/scripted-test-provider`
// seam runs (not mocked) so this is a genuine seam test.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { WidgetPrincipal } from "../widget-principal";

// --- capture whether the NON-scripted adapter-resolution path was taken ------
const resolveDefaultAdapter = vi.fn(async () => null as unknown);
const stream = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));

vi.mock("@/lib/register-host-connector-services", () => ({}));
vi.mock("@/app/api/chat/explicit-dispatch", () => ({
  detectExplicitDispatchDirective: () => "",
  detectExplicitDispatchPackage: () => null,
}));
vi.mock("@/app/api/chat/explicit-dispatch-server", () => ({ serverSideExplicitDispatch: vi.fn() }));
vi.mock("@/app/api/chat/chat-user-context", () => ({ buildChatUserContextSections: vi.fn(async () => []) }));
vi.mock("@/app/api/chat/shell-skill-gate", () => ({ shouldDeliverChatShellSkillTools: () => true }));
vi.mock("@/app/api/chat/extension-confirmation", () => ({
  buildExtensionImplementationConfirmationPolicy: () => "",
}));
vi.mock("@cinatra-ai/skills/mcp-client", () => ({
  createDeterministicSkillsClient: () => ({ installed: { get: async () => ({ body: "" }) } }),
}));
vi.mock("@cinatra-ai/skills", () => ({
  ensureInstalledSkillsRegistered: vi.fn(async () => undefined),
  resolveInstalledSkillSourcePath: vi.fn(async () => null),
  retireSupersededChatSkillsOnce: vi.fn(async () => undefined),
}));
vi.mock("@/lib/wizard-staging-store", () => ({ getAllStagedByType: () => [] }));
vi.mock("@/lib/wizard-manifest-registry", () => ({ getAllManifests: vi.fn(async () => []) }));
vi.mock("@/lib/chat-mcp-actor-token", () => ({ issueChatMcpActorToken: vi.fn() }));
vi.mock("@/lib/widget-mcp-actor-token", () => ({ issueWidgetMcpActorToken: vi.fn() }));
vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: () => null }));
vi.mock("@/lib/artifacts/attachment-resolver-ports", () => ({ buildAttachmentResolverPorts: vi.fn(() => ({})) }));
vi.mock("@cinatra-ai/llm", () => ({
  hasConfiguredLlmRuntime: vi.fn(async () => false),
  checkPublicMcpReachability: vi.fn(async () => ({ status: "reachable", url: "https://mcp.example.test/api/mcp" })),
  resolveDefaultAdapter: () => resolveDefaultAdapter(),
  stream: (...a: unknown[]) => stream(...a),
  // cinatra#2091 S4: skill delivery runs through the provider seam.
  selectSkillDeliveryAdapter: vi.fn(() => ({
    provider: "openai",
    deliver: vi.fn(async () => ({ tools: [], systemContext: "", exposure: [] })),
  })),
  resolveChatExternalMcpTools: vi.fn(async () => []),
  buildLlmMcpServerToolForChat: vi.fn(async () => ({ type: "mcp", name: "cinatra" })),
  buildLlmMcpServerToolForWidget: vi.fn(async () => ({ type: "mcp", name: "cinatra" })),
}));

import { runAssistantTurn } from "../runtime";
import { resolveChatExternalMcpTools } from "@cinatra-ai/llm";
import { UAT_SENTINEL } from "@cinatra-ai/llm/scripted-test-provider";
import { buildCinatraAssistantRuntimeConfig } from "../cinatra-assistant-config";

const wpPrincipal: WidgetPrincipal = {
  kind: "public_site_widget",
  userId: "u1",
  orgId: "o1",
  instanceId: "wp-canonical",
  verifiedOrigin: "https://wp.example.test",
  assistantHandle: "wordpress",
  instancesConfigKey: "wordpress_instances",
};

function argsWith(
  send: (event: string, data: unknown) => void,
  widgetPrincipal: WidgetPrincipal | null,
  content: string,
) {
  return {
    messages: [{ role: "user" as const, content }],
    actorContext: { actorType: "user", userId: "u1" } as never,
    userId: "u1",
    platformRole: "member" as const,
    sessionOrgId: "o1",
    send,
    widgetPrincipal,
  };
}

// vitest runs with NODE_ENV=test, so assertScriptedProviderNotProduction's
// NODE_ENV!=="production" clause is satisfied; the tests only toggle the enable
// flag + the explicit development runtime-mode gate.
const ORIG_FLAG = process.env.CINATRA_TEST_LLM_PROVIDER;
const ORIG_MODE = process.env.CINATRA_RUNTIME_MODE;

afterEach(() => {
  process.env.CINATRA_TEST_LLM_PROVIDER = ORIG_FLAG;
  process.env.CINATRA_RUNTIME_MODE = ORIG_MODE;
});

describe("runAssistantTurn scripted-provider short-circuit (widget path)", () => {
  beforeEach(() => {
    resolveDefaultAdapter.mockClear();
    stream.mockClear();
  });

  it("REAL SEAM: streams the deterministic sentinel + content-editor tool_call, never resolving an adapter", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    process.env.CINATRA_RUNTIME_MODE = "development";

    const frames: Array<{ event: string; data: unknown }> = [];
    const send = (event: string, data: unknown) => { frames.push({ event, data }); };
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      argsWith(send, wpPrincipal, "Please rewrite the title to be punchier."),
    );

    // The scripted stream answered — the adapter path was NEVER taken.
    expect(resolveDefaultAdapter).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();

    const text = frames.filter((f) => f.event === "text").map((f) => (f.data as { content: string }).content).join("");
    expect(text).toContain(UAT_SENTINEL);
    // No "No LLM provider configured." error frame.
    expect(frames.some((f) => f.event === "error")).toBe(false);
    // An edit intent emits a `*_content_editor_run` tool_call (the widget's content-edit key).
    const toolCall = frames.find((f) => f.event === "tool_call");
    expect((toolCall?.data as { name: string } | undefined)?.name).toBe("wordpress_content_editor_run");
    expect(frames.some((f) => f.event === "tool_result")).toBe(true);
  });

  it("a plain widget prompt streams the sentinel with NO tool_call", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    process.env.CINATRA_RUNTIME_MODE = "development";

    const frames: Array<{ event: string; data: unknown }> = [];
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      argsWith((e, d) => frames.push({ event: e, data: d }), wpPrincipal, "Hello, what can you do here?"),
    );
    const text = frames.filter((f) => f.event === "text").map((f) => (f.data as { content: string }).content).join("");
    expect(text).toContain(UAT_SENTINEL);
    expect(frames.some((f) => f.event === "tool_call")).toBe(false);
    expect(resolveDefaultAdapter).not.toHaveBeenCalled();
  });

  it("PROD-MODE CONFORMANCE PIN: flag OFF → the widget path still resolves the adapter and fails closed when none", async () => {
    delete process.env.CINATRA_TEST_LLM_PROVIDER;
    resolveDefaultAdapter.mockResolvedValueOnce(null);

    const frames: Array<{ event: string; data: unknown }> = [];
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      argsWith((e, d) => frames.push({ event: e, data: d }), wpPrincipal, "Please rewrite the title."),
    );
    // Adapter resolution is UNCHANGED — it ran, and (no adapter) produced the
    // canonical error frame; the scripted branch did NOT leak into prod.
    expect(resolveDefaultAdapter).toHaveBeenCalledTimes(1);
    expect(frames).toContainEqual({ event: "error", data: { message: "No LLM provider configured." } });
  });

  it("a REAL (non-scripted) widget turn resolves external MCP tools with the public_site_widget build context (cinatra#2019 S4)", async () => {
    delete process.env.CINATRA_TEST_LLM_PROVIDER;
    // Let the widget turn proceed past adapter resolution into tool assembly.
    resolveDefaultAdapter.mockResolvedValueOnce({
      provider: "openai",
      defaultModel: "gpt-4o",
    });

    const frames: Array<{ event: string; data: unknown }> = [];
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      argsWith((e, d) => frames.push({ event: e, data: d }), wpPrincipal, "Please rewrite the title."),
    );

    // The widget principal drives the surface — a surface-gating toolbox
    // (trusted-site native read-injection) sees "public_site_widget" and
    // refuses the build fail-closed instead of leaking chat-scoped
    // injections onto public-site widget turns.
    expect(vi.mocked(resolveChatExternalMcpTools)).toHaveBeenCalledWith("openai", {
      surface: "public_site_widget",
    });
  });

  it("SCOPE: the cookie-session path (no widget principal) is NEVER short-circuited, even with the flag on", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    process.env.CINATRA_RUNTIME_MODE = "development";
    resolveDefaultAdapter.mockResolvedValueOnce(null);

    const frames: Array<{ event: string; data: unknown }> = [];
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      argsWith((e, d) => frames.push({ event: e, data: d }), null, "Please rewrite the title."),
    );
    // The @cinatra path resolves the adapter as usual (host stream() owns its own
    // scripted seam); the widget short-circuit did not fire.
    expect(resolveDefaultAdapter).toHaveBeenCalledTimes(1);
    expect(frames.some((f) => f.event === "text")).toBe(false);
  });
});
