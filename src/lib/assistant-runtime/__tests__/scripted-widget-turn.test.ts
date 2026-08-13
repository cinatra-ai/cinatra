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
//   3. SCOPE — the CMS stand-in is gated to the widget path; a cookie-session
//      `@cinatra` turn (no widget principal) is NEVER short-circuited for it, even
//      with the flag on, so its host-`stream()` scripted seam is unaffected.
//   4. THE `/chat` LIFECYCLE BRANCH (cinatra#2683) — the one cookie-session turn
//      that DOES short-circuit: a lifecycle question the provider itself claims.
//      It drives the real primitives through the chat-bearer dispatcher, and the
//      reserved producer label rides ONLY what that dispatcher reported.
//
// The heavy import graph is mocked; the REAL `@cinatra-ai/llm/scripted-test-provider`
// seam runs (not mocked) so this is a genuine seam test. The widget dispatcher is
// real too — only the CHAT dispatcher is replaced, because its transport is the
// one thing a unit test cannot stand up (a live self-MCP server).

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { WidgetPrincipal } from "../widget-principal";

// --- capture whether the NON-scripted adapter-resolution path was taken ------
const resolveDefaultAdapter = vi.fn(async () => null as unknown);
// S6 exact binding (cinatra#2093): the runtime now resolves through the
// THROWING variant. This test's subject is the scripted short-circuit — it
// asserts the adapter path is never REACHED — so the stub simply records the
// call and throws the named error the real resolver would.
// `vi.hoisted` so the error class exists before the hoisted `vi.mock` factory
// runs, and so the stub throws the SAME class the mock exports (the runtime
// branches on `instanceof` to render its fail-closed frame).
const { BoundDefaultProviderUnavailableError } = vi.hoisted(() => ({
  BoundDefaultProviderUnavailableError: class BoundDefaultProviderUnavailableError extends Error {},
}));
// Mirrors the REAL semantics: resolve the stored provider, and THROW the named
// error only when it is unavailable. Delegating to `resolveDefaultAdapter` keeps
// every existing per-test knob (`mockResolvedValueOnce`, the
// `not.toHaveBeenCalled()` short-circuit assertions) working unchanged.
const resolveBoundDefaultAdapter = vi.fn(async () => {
  const adapter = await resolveDefaultAdapter();
  if (!adapter) throw new BoundDefaultProviderUnavailableError("No LLM provider configured.");
  return adapter;
});
const stream = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));

vi.mock("@/lib/register-host-connector-services", () => ({}));
vi.mock("@/app/api/chat/explicit-dispatch", () => ({
  detectExplicitDispatchDirective: () => "",
  detectExplicitDispatchPackage: () => null,
}));
vi.mock("@/app/api/chat/explicit-dispatch-server", () => ({ serverSideExplicitDispatch: vi.fn() }));
vi.mock("@/app/api/chat/chat-user-context", () => ({ buildChatUserContextSections: vi.fn(async () => []) }));
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
  resolveBoundDefaultAdapter: () => resolveBoundDefaultAdapter(),
  BoundDefaultProviderUnavailableError,
  stream: (...a: unknown[]) => stream(...a),
  // cinatra#2091 S4: skill delivery runs through the provider seam.
  selectSkillDeliveryAdapter: vi.fn(() => ({
    provider: "openai",
    // Realistic OpenAI delivery — see the same note in
    // `execution-provenance-turn.test.ts` (cinatra#2094 F11): a no-vehicle
    // delivery is now refused, so an empty stub would abort the widget turn
    // before the external-MCP surface assertion this file exists for.
    deliver: vi.fn(async () => ({
      tools: [{ type: "function", name: "skill_file_read" }],
      systemContext: "",
      exposure: [],
    })),
  })),
  resolveChatExternalMcpTools: vi.fn(async () => []),
  buildLlmMcpServerToolForChat: vi.fn(async () => ({ type: "mcp", name: "cinatra" })),
  buildLlmMcpServerToolForWidget: vi.fn(async () => ({ type: "mcp", name: "cinatra" })),
}));

// The CHAT dispatcher, replaced. Its widget twin stays REAL (the module is
// imported for real and only this one export is swapped), so the widget scenarios
// below keep constructing the shipped dispatcher exactly as they did.
const { chatDispatchScript, createChatDispatchSpy } = vi.hoisted(() => {
  const chatDispatchScript = {
    /** What the "real" primitive answers, keyed by tool name. */
    answers: {} as Record<string, string>,
    /** Whether the dispatcher REPORTS its answer as genuinely dispatched. */
    report: true,
  };
  const createChatDispatchSpy = vi.fn(
    (params: { onDispatched?: (t: string) => void }) => async (call: { name: string }) => {
      const text = chatDispatchScript.answers[call.name] ?? "{}";
      if (chatDispatchScript.report) params.onDispatched?.(text);
      return text;
    },
  );
  return { chatDispatchScript, createChatDispatchSpy };
});
vi.mock("../scripted-self-mcp-dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../scripted-self-mcp-dispatch")>()),
  createScriptedChatSelfMcpDispatch: (p: { onDispatched?: (t: string) => void }) =>
    createChatDispatchSpy(p),
}));

import { runAssistantTurn } from "../runtime";
import { resolveChatExternalMcpTools, buildLlmMcpServerToolForWidget } from "@cinatra-ai/llm";
import { UAT_SENTINEL } from "@cinatra-ai/llm/scripted-test-provider";
import { buildCinatraAssistantRuntimeConfig } from "../cinatra-assistant-config";

const wpPrincipal: WidgetPrincipal = {
  kind: "public_site_widget",
  userId: "u1",
  orgId: "o1",
  // cinatra#2687 — the `cwu_` row the turn authenticated against; the OBO mint
  // seals it as `pjti`.
  parentTokenJti: "cwu-row-1",
  instanceId: "wp-canonical",
  verifiedOrigin: "https://wp.example.test",
  assistantHandle: "wordpress",
  // cinatra#2674 — the tier is a required, server-resolved field now. `member`
  // is the ordinary value; the elevated case is covered by the parity suites.
  platformRole: "member",
  instancesConfigKey: "wordpress_instances",
  // cinatra#2577 — a widget turn whose sign-in granted no lifecycle read.
  lifecycleRead: false,
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
    // cinatra#2240 — required turn/run identity (see runtime RunChatTurnArgs).
    turnIdentity: { turnId: "turn-widget", runId: "run-widget" },
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
    resolveBoundDefaultAdapter.mockClear();
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

  it("SEALS THE OBO TOKEN to the parent cwu_ row and to THIS turn (cinatra#2687)", async () => {
    // The mint is the only place both facts are in hand: the principal carries
    // the `cwu_` row the turn authenticated against, and the harness-bound
    // identity carries the run id of the turn being served. Before #2687 the
    // mint passed neither, so the token it produced could not be checked
    // against anything and worked for its whole 120 seconds.
    delete process.env.CINATRA_TEST_LLM_PROVIDER;
    resolveDefaultAdapter.mockResolvedValueOnce({ provider: "openai", defaultModel: "gpt-4o" });
    vi.mocked(buildLlmMcpServerToolForWidget).mockClear();

    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      argsWith(() => {}, wpPrincipal, "Please rewrite the title."),
    );

    expect(vi.mocked(buildLlmMcpServerToolForWidget)).toHaveBeenCalledTimes(1);
    const [, actor] = vi.mocked(buildLlmMcpServerToolForWidget).mock.calls[0];
    expect(actor).toMatchObject({
      userId: "u1",
      orgId: "o1",
      instanceId: "wp-canonical",
      kind: "wordpress",
      // The two seals, both taken from values this turn already holds.
      parentJti: "cwu-row-1",
      turnRunId: "run-widget",
    });
    // The per-turn nonce is still minted fresh and is NOT the binding.
    expect(typeof (actor as { jti: unknown }).jti).toBe("string");
    expect((actor as { jti: string }).jti).not.toBe("run-widget");
  });

  it("SCOPE: a cookie-session turn the provider does NOT claim is never short-circuited, even with the flag on", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    process.env.CINATRA_RUNTIME_MODE = "development";
    resolveDefaultAdapter.mockResolvedValueOnce(null);

    const frames: Array<{ event: string; data: unknown }> = [];
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      argsWith((e, d) => frames.push({ event: e, data: d }), null, "Please rewrite the title."),
    );
    // An edit request is not a lifecycle question, so the @cinatra path resolves
    // the adapter as usual (host stream() owns its own scripted seam) — neither
    // short-circuit fired, and no chat dispatcher was even built.
    expect(resolveDefaultAdapter).toHaveBeenCalledTimes(1);
    expect(createChatDispatchSpy).not.toHaveBeenCalled();
    expect(frames.some((f) => f.event === "text")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE `/chat` LIFECYCLE BRANCH (cinatra#2683, epic #2564 S8f).
// ---------------------------------------------------------------------------
const LIST_TOOL = "artifact_review_gates_list";
const RENDER_TOOL = "artifact_review_gate_render";
const REAL_LIST_ANSWER = JSON.stringify({ refs: ["REF-ONE"] });
const REAL_ENVELOPE = JSON.stringify({
  $cinatraLifecycleView: 1,
  viewType: "artifact_review_gate",
  ref: "REF-ONE",
});

describe("runAssistantTurn scripted-provider short-circuit (/chat lifecycle branch)", () => {
  beforeEach(() => {
    resolveDefaultAdapter.mockClear();
    resolveBoundDefaultAdapter.mockClear();
    stream.mockClear();
    createChatDispatchSpy.mockClear();
    chatDispatchScript.answers = {
      [LIST_TOOL]: REAL_LIST_ANSWER,
      [RENDER_TOOL]: REAL_ENVELOPE,
    };
    chatDispatchScript.report = true;
  });

  it("REAL SEAM: a lifecycle question drives the real primitives with the SESSION's own identity, never resolving an adapter", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    process.env.CINATRA_RUNTIME_MODE = "development";

    const frames: Array<{ event: string; data: unknown }> = [];
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      argsWith(
        (e, d) => frames.push({ event: e, data: d }),
        null,
        "Which reviews are waiting for me right now?",
      ),
    );

    expect(resolveDefaultAdapter).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    // The bearer is minted for THIS session's user, org and role — passed
    // through, never floored, widened or invented by the branch.
    expect(createChatDispatchSpy).toHaveBeenCalledTimes(1);
    expect(createChatDispatchSpy.mock.calls[0][0]).toMatchObject({
      userId: "u1",
      orgId: "o1",
      platformRole: "member",
    });
    // The pull the producer prescribes: LIST, then RENDER one listed ref.
    const toolCalls = frames
      .filter((f) => f.event === "tool_call")
      .map((f) => (f.data as { name: string }).name);
    expect(toolCalls).toEqual([LIST_TOOL, RENDER_TOOL]);
    const results = frames
      .filter((f) => f.event === "tool_result")
      .map((f) => f.data as { name: string; result: string; serverLabel?: string });
    expect(results.map((r) => r.result)).toEqual([REAL_LIST_ANSWER, REAL_ENVELOPE]);
    // THE LABEL IS EARNED: it rides the results the dispatcher reported.
    expect(results.every((r) => r.serverLabel === "cinatra")).toBe(true);
  });

  it("ANTI-FABRICATION: a result the dispatcher never reported reaches the sink UNLABELLED", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    process.env.CINATRA_RUNTIME_MODE = "development";
    // The same bytes — a perfectly-formed envelope — with the one thing that
    // cannot be forged missing: this frame's own record that a real dispatch
    // returned it. The sink's recognizer then refuses it and no card mints.
    chatDispatchScript.report = false;

    const frames: Array<{ event: string; data: unknown }> = [];
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      argsWith(
        (e, d) => frames.push({ event: e, data: d }),
        null,
        "Which reviews are waiting for me right now?",
      ),
    );

    const results = frames
      .filter((f) => f.event === "tool_result")
      .map((f) => f.data as { result: string; serverLabel?: string });
    expect(results).toHaveLength(2);
    expect(results.some((r) => r.result === REAL_ENVELOPE)).toBe(true);
    expect(results.every((r) => r.serverLabel === undefined)).toBe(true);
  });

  it("THE REFUSAL TRAVELS: an empty list ends the turn with no card and no invention", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    process.env.CINATRA_RUNTIME_MODE = "development";
    chatDispatchScript.answers = { [LIST_TOOL]: JSON.stringify({ refs: [] }) };

    const frames: Array<{ event: string; data: unknown }> = [];
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      argsWith(
        (e, d) => frames.push({ event: e, data: d }),
        null,
        "Which reviews are waiting for me right now?",
      ),
    );

    const results = frames.filter((f) => f.event === "tool_result");
    expect(results).toHaveLength(1);
    expect((results[0].data as { result: string }).result).toBe(JSON.stringify({ refs: [] }));
  });

  it("PROD-MODE CONFORMANCE PIN: flag OFF → a lifecycle question resolves the adapter like any other chat turn", async () => {
    delete process.env.CINATRA_TEST_LLM_PROVIDER;
    resolveDefaultAdapter.mockResolvedValueOnce(null);

    const frames: Array<{ event: string; data: unknown }> = [];
    await runAssistantTurn(
      buildCinatraAssistantRuntimeConfig(),
      argsWith(
        (e, d) => frames.push({ event: e, data: d }),
        null,
        "Which reviews are waiting for me right now?",
      ),
    );

    expect(createChatDispatchSpy).not.toHaveBeenCalled();
    expect(resolveDefaultAdapter).toHaveBeenCalledTimes(1);
    expect(frames).toContainEqual({
      event: "error",
      data: { message: "No LLM provider configured." },
    });
  });

  it("THE PRODUCTION FENCE COVERS THIS BRANCH: the flag set outside a development runtime fails LOUD", async () => {
    process.env.CINATRA_TEST_LLM_PROVIDER = "scripted";
    process.env.CINATRA_RUNTIME_MODE = "production";

    // The same throw `stream()` already raises for a scripted flag outside
    // development — now raised BEFORE the branch can be entered, so no scripted
    // frame can precede it on either path.
    await expect(
      runAssistantTurn(
        buildCinatraAssistantRuntimeConfig(),
        argsWith(() => {}, null, "Which reviews are waiting for me right now?"),
      ),
    ).rejects.toThrow(/must NEVER run outside development/);
    expect(createChatDispatchSpy).not.toHaveBeenCalled();
  });
});
