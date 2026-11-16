// GET /api/assistants/chat/tool-manifest (cinatra#3487;
// packages/agent-ui-protocol/CONTRACT.md section 5.2).
//
// The route's INPUT READS (session, actor, thread, run access, catalog state,
// assigned skills, skill delivery, external MCP tools, provider adapter) are
// RECORDING fakes. Everything between the route and the turn's write steps is
// REAL: the real runtime module (`@/lib/assistant-runtime/runtime`, with only
// its two input reads replaced), the real registration accessor over the
// skills layer, the real tool assembly (`assembleAssistantTurnTools`), the real
// injection resolver, the real report builder and the real canonical JSON.
// The turn's write entry points themselves are recording spies at the module
// that performs the write (skill registration and retirement, actor token
// mints, lent-action grant, reachability probe, delivery record, stream events,
// `stream()` and the adapter's own model calls, thread and run-window rows);
// they must stay at zero. The fake input reads say nothing about the side
// effects of the real readers (CONTRACT.md section 5.2, "Read only").

import { beforeEach, describe, expect, it, vi } from "vitest";

const SKILLS = ["@cinatra-ai/chat:core", "@cinatra-ai/chat:blog"];
const THREAD_ID = "thread-1";
const RUN_ID = "run-1";

const state = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; role?: string };
    session?: { activeOrganizationId?: string | null };
  },
  registered: true,
  config: {
    skillIdNamespace: "@cinatra-ai/chat",
    skillIds: [] as string[],
    allowedTools: [] as string[],
    modelPrefs: {} as Record<string, unknown>,
  },
  adapter: { provider: "openai", defaultModel: "model-test" } as null | {
    provider: string;
    defaultModel: string;
  },
  adapterError: null as unknown,
  windowUser: { userId: "u1", orgId: "o1", platformRole: "member" },
  windowContextOrgId: "o1",
  delivery: {
    tools: [{ type: "function", name: "skill_file_read", description: "read", parameters: { type: "object" } }] as Array<
      Record<string, unknown>
    >,
    systemContext: "SKILLS_CUE",
    exposure: [] as Array<Record<string, unknown>>,
  },
  deliveryError: null as unknown,
  externalTools: [
    { type: "mcp", serverLabel: "ext", serverUrl: "https://ext.example.test/mcp" },
  ] as Array<Record<string, unknown>>,
  externalError: null as unknown,
  catalogError: null as unknown,
  selfMcpNull: false,
  issuedTokens: [] as string[],
  keyError: null as unknown,
}));

// --- the turn's write steps and model/MCP calls: spies that stay at zero ---
const writes = vi.hoisted(() => ({
  ensureInstalledSkillsRegistered: vi.fn(),
  retireSupersededChatSkillsOnce: vi.fn(),
  issueChatMcpActorToken: vi.fn(),
  issueWidgetMcpActorToken: vi.fn(),
  issueTurnLentActionGrant: vi.fn(),
  checkPublicMcpReachability: vi.fn(),
  stream: vi.fn(),
  recordTurnSkillDelivery: vi.fn(),
  createAssistantThread: vi.fn(),
  appendAssistantTurn: vi.fn(),
  updateAssistantTurn: vi.fn(),
  bindThreadContainerIfUnbound: vi.fn(),
  freezeAssistantThreadAssignmentScopeIfAbsent: vi.fn(),
  appendRunWindowMessage: vi.fn(),
  xaddRunEvent: vi.fn(),
  adapterStream: vi.fn(),
  adapterGenerate: vi.fn(),
}));

// --- reads: recording fakes --------------------------------------------------
const reads = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  requireActorContext: vi.fn(),
  resolveUserContextForUserId: vi.fn(),
  authorizeThreadForTurn: vi.fn(),
  requireRunWindowAccess: vi.fn(),
  areInstalledSkillsRegistered: vi.fn(),
  isSupersededChatSkillRetirementSettled: vi.fn(),
  buildAssistantInjectionPorts: vi.fn(),
  readChatMcpCatalogState: vi.fn(),
  resolveAssistantAssignedSkillIds: vi.fn(),
  resolveProviderAdapter: vi.fn(),
  resolveBoundDefaultAdapter: vi.fn(),
  selectSkillDeliveryAdapter: vi.fn(),
  deliver: vi.fn(),
  deliverInjectedSkillsInline: vi.fn(),
  resolveChatExternalMcpTools: vi.fn(),
  buildLlmMcpServerToolForChat: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => reads.getAuthSession(),
  requireActorContext: () => reads.requireActorContext(),
  resolveUserContextForUserId: (...a: unknown[]) => reads.resolveUserContextForUserId(...a),
  isPlatformAdmin: (session: { user?: { role?: string } } | null) =>
    String(session?.user?.role ?? "").split(",").includes("admin"),
}));

vi.mock("@/lib/assistant-runtime/ag-ui-stream-route", () => ({
  authorizeThreadForTurn: (...a: unknown[]) => reads.authorizeThreadForTurn(...a),
}));

vi.mock("@/lib/lifecycle/run-window-turn", () => ({
  requireRunWindowAccess: (...a: unknown[]) => reads.requireRunWindowAccess(...a),
}));

vi.mock("@cinatra-ai/agents/run-window-conversation-store", () => ({
  RUN_WINDOW_SURFACES: ["run-page", "step-by-step", "schedule", "armed-trigger", "review"],
  appendRunWindowMessage: writes.appendRunWindowMessage,
}));

vi.mock("@/lib/assistant-runtime/cinatra-assistant-config", () => ({
  buildCinatraAssistantRuntimeConfig: () => ({
    ...state.config,
    systemSkillId: state.config.skillIds[0],
    fallbackPersona: "persona",
  }),
}));

// The REAL runtime module. Only its two input reads are replaced; the
// registration accessor and every write the runtime owns stay real, so a route
// that reached one of them would hit the write spies below.
vi.mock("@/lib/assistant-runtime/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/assistant-runtime/runtime")>();
  return {
    ...actual,
    buildAssistantInjectionPorts: (...a: unknown[]) => reads.buildAssistantInjectionPorts(...a),
    readChatMcpCatalogState: (...a: unknown[]) => reads.readChatMcpCatalogState(...a),
  };
});

// Leaf modules the real runtime imports, stubbed as the runtime's own tests
// stub them (src/lib/assistant-runtime/__tests__/chat-turn-delivery-record.test.ts).
vi.mock("@/lib/register-host-connector-services", () => ({}));
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
vi.mock("@/lib/wizard-staging-store", () => ({ getAllStagedByType: () => [] }));
vi.mock("@/lib/wizard-manifest-registry", () => ({ getAllManifests: vi.fn(async () => []) }));
vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: () => null }));
vi.mock("@/lib/artifacts/attachment-resolver-ports", () => ({
  buildAttachmentResolverPorts: vi.fn(() => ({})),
}));

// The real report builder; only the key creation can be made to throw.
vi.mock("@/lib/assistant-runtime/tool-manifest-report", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/assistant-runtime/tool-manifest-report")>();
  return {
    ...actual,
    createToolManifestHashKey: () => {
      if (state.keyError) throw state.keyError;
      return actual.createToolManifestHashKey();
    },
  };
});

vi.mock("@/lib/assistant-assigned-skills-delivery", () => ({
  resolveAssistantAssignedSkillIds: (...a: unknown[]) => reads.resolveAssistantAssignedSkillIds(...a),
}));

vi.mock("@cinatra-ai/llm", () => {
  class BoundDefaultProviderUnavailableError extends Error {}
  return {
    BoundDefaultProviderUnavailableError,
    resolveProviderAdapter: (...a: unknown[]) => reads.resolveProviderAdapter(...a),
    resolveBoundDefaultAdapter: () => reads.resolveBoundDefaultAdapter(),
    selectSkillDeliveryAdapter: (...a: unknown[]) => reads.selectSkillDeliveryAdapter(...a),
    deliverInjectedSkillsInline: (...a: unknown[]) => reads.deliverInjectedSkillsInline(...a),
    resolveChatExternalMcpTools: (...a: unknown[]) => reads.resolveChatExternalMcpTools(...a),
    buildLlmMcpServerToolForChat: (...a: unknown[]) => reads.buildLlmMcpServerToolForChat(...a),
    buildLlmMcpServerToolForWidget: vi.fn(),
    checkPublicMcpReachability: writes.checkPublicMcpReachability,
    stream: writes.stream,
    hasConfiguredLlmRuntime: vi.fn(async () => true),
    describeLlmRuntimeUnavailability: vi.fn(() => ""),
  };
});

// The skills layer: the registration and retirement WRITES are spies; the
// read-only accessors the real runtime reads are recording fakes.
vi.mock("@cinatra-ai/skills", () => ({
  ensureInstalledSkillsRegistered: writes.ensureInstalledSkillsRegistered,
  retireSupersededChatSkillsOnce: writes.retireSupersededChatSkillsOnce,
  areInstalledSkillsRegistered: (...a: unknown[]) => reads.areInstalledSkillsRegistered(...a),
  isSupersededChatSkillRetirementSettled: () => reads.isSupersededChatSkillRetirementSettled(),
  resolveInstalledSkillSourcePath: vi.fn(async () => null),
}));
vi.mock("@/lib/chat-mcp-actor-token", () => ({
  issueChatMcpActorToken: writes.issueChatMcpActorToken,
}));
vi.mock("@/lib/widget-mcp-actor-token", () => ({
  issueWidgetMcpActorToken: writes.issueWidgetMcpActorToken,
}));
vi.mock("@/lib/lifecycle/bound-card-binding", () => ({
  issueTurnLentActionGrant: writes.issueTurnLentActionGrant,
}));
vi.mock("@/lib/agent-run-skills-used", () => ({
  recordTurnSkillDelivery: writes.recordTurnSkillDelivery,
}));
vi.mock("@/lib/assistant-thread-store", () => ({
  createAssistantThread: writes.createAssistantThread,
  appendAssistantTurn: writes.appendAssistantTurn,
  updateAssistantTurn: writes.updateAssistantTurn,
  bindThreadContainerIfUnbound: writes.bindThreadContainerIfUnbound,
  freezeAssistantThreadAssignmentScopeIfAbsent: writes.freezeAssistantThreadAssignmentScopeIfAbsent,
  getAssistantThread: vi.fn(() => null),
  touchAssistantThread: vi.fn(),
}));
vi.mock("@cinatra-ai/a2a", () => ({
  xaddRunEvent: writes.xaddRunEvent,
  expireRunStream: vi.fn(),
}));

import { GET } from "../route";

const SURFACES = ["run-page", "step-by-step", "schedule", "armed-trigger", "review"] as const;

function url(query: string): string {
  return `http://localhost/api/assistants/chat/tool-manifest?${query}`;
}

function validQuery(surface = "review"): string {
  return `threadId=${THREAD_ID}&runId=${RUN_ID}&surface=${surface}`;
}

function get(query = validQuery(), headers: Record<string, string> = {}): Promise<Response> {
  return GET(new Request(url(query), { headers }));
}

/** The real buildAssistantInjectionPorts shape, recording what it is asked. */
function fakeInjectionPorts(input: {
  agentId: string;
  userId: string;
  sessionId: string;
  requiredSkillIds: readonly string[];
  resolveAssignedSkillIdsForSession?: (sessionId: string) => Promise<readonly string[]>;
}) {
  return {
    async authorizeAssistantSession(intent: { agentId: string; userId: string; sessionId?: string }) {
      if (intent.agentId !== input.agentId || intent.userId !== input.userId) {
        return { ok: false, reason: "mismatch" };
      }
      if (!intent.sessionId || intent.sessionId !== input.sessionId) {
        return { ok: false, reason: "session" };
      }
      return { ok: true, runOwnerUserId: input.userId };
    },
    async resolveAssistantRequiredSkills() {
      return input.requiredSkillIds.map((skillId) => ({ skillId }));
    },
    async resolveAssistantAssignedSkills(intent: { sessionId?: string }) {
      if (!intent.sessionId || intent.sessionId !== input.sessionId) return [];
      if (!input.resolveAssignedSkillIdsForSession) return [];
      const ids = await input.resolveAssignedSkillIdsForSession(intent.sessionId);
      return ids.map((skillId) => ({ skillId }));
    },
  };
}

function expectZeroWrites() {
  for (const [name, spy] of Object.entries(writes)) {
    expect(spy, name).not.toHaveBeenCalled();
  }
}

/** No store read at all: not even the session read. */
function expectNoStoreRead() {
  expect(reads.getAuthSession).not.toHaveBeenCalled();
  expectNoStoreReadAfterSession();
}

/** No store read past the session read. */
function expectNoStoreReadAfterSession() {
  expect(reads.requireActorContext).not.toHaveBeenCalled();
  expect(reads.authorizeThreadForTurn).not.toHaveBeenCalled();
  expect(reads.requireRunWindowAccess).not.toHaveBeenCalled();
  expect(reads.resolveUserContextForUserId).not.toHaveBeenCalled();
  expect(reads.readChatMcpCatalogState).not.toHaveBeenCalled();
  expect(reads.resolveAssistantAssignedSkillIds).not.toHaveBeenCalled();
  expect(reads.resolveBoundDefaultAdapter).not.toHaveBeenCalled();
  expect(reads.resolveProviderAdapter).not.toHaveBeenCalled();
}

async function expectError(res: Response, status: number, error: string) {
  expect(res.status).toBe(status);
  expect(await res.json()).toEqual({ error });
}

const HASH = /^hmac-sha256:[0-9a-f]{64}$/;

beforeEach(() => {
  vi.clearAllMocks();
  state.session = { user: { id: "u1", role: "user" }, session: { activeOrganizationId: "o1" } };
  state.registered = true;
  state.config = {
    skillIdNamespace: "@cinatra-ai/chat",
    skillIds: [...SKILLS],
    allowedTools: [],
    modelPrefs: {},
  };
  state.adapter = { provider: "openai", defaultModel: "model-test" };
  state.adapterError = null;
  state.windowUser = { userId: "u1", orgId: "o1", platformRole: "member" };
  state.windowContextOrgId = "o1";
  state.delivery = {
    tools: [
      { type: "function", name: "skill_file_read", description: "read", parameters: { type: "object" } },
    ],
    systemContext: "SKILLS_CUE",
    exposure: [],
  };
  state.deliveryError = null;
  state.externalTools = [{ type: "mcp", serverLabel: "ext", serverUrl: "https://ext.example.test/mcp" }];
  state.externalError = null;
  state.catalogError = null;
  state.selfMcpNull = false;
  state.issuedTokens = [];
  state.keyError = null;

  reads.getAuthSession.mockImplementation(async () => state.session);
  reads.requireActorContext.mockImplementation(async () => ({ userId: "u1", road: "composer" }));
  reads.resolveUserContextForUserId.mockImplementation(async (userId: string) => ({
    actorContext: { userId, road: "window" },
    platformRole: state.windowUser.platformRole,
    sessionOrgId: state.windowContextOrgId,
  }));
  reads.authorizeThreadForTurn.mockReturnValue({ ok: true, mirrorOrgId: "o1", needsStructuredRow: true });
  reads.requireRunWindowAccess.mockImplementation(async () => ({
    actor: { ...state.windowUser, actor: {}, roleHints: {} },
    run: { id: RUN_ID },
    template: null,
  }));
  reads.areInstalledSkillsRegistered.mockImplementation(() => state.registered);
  reads.isSupersededChatSkillRetirementSettled.mockImplementation(() => true);
  reads.buildAssistantInjectionPorts.mockImplementation(fakeInjectionPorts);
  reads.readChatMcpCatalogState.mockImplementation(async () => {
    if (state.catalogError) throw state.catalogError;
    return { servable: [], isHostApproved: () => true, isCapabilityAvailable: () => true };
  });
  reads.resolveAssistantAssignedSkillIds.mockImplementation(async () => []);
  // The adapter carries its model calls as spies: the route must call neither.
  const withModelSpies = () =>
    state.adapter
      ? { ...state.adapter, stream: writes.adapterStream, generate: writes.adapterGenerate }
      : null;
  reads.resolveProviderAdapter.mockImplementation(async () => withModelSpies());
  reads.resolveBoundDefaultAdapter.mockImplementation(async () => {
    if (state.adapterError) throw state.adapterError;
    return withModelSpies();
  });
  reads.deliver.mockImplementation(async () => {
    if (state.deliveryError) throw state.deliveryError;
    return { ...state.delivery };
  });
  reads.selectSkillDeliveryAdapter.mockImplementation((provider: string) => ({
    provider,
    deliver: reads.deliver,
  }));
  reads.deliverInjectedSkillsInline.mockImplementation(async () => ({
    systemContext: "INLINE",
    exposure: [],
    dropped: [],
  }));
  reads.resolveChatExternalMcpTools.mockImplementation(async () => {
    if (state.externalError) throw state.externalError;
    return state.externalTools.map((tool) => ({ ...tool }));
  });
  reads.buildLlmMcpServerToolForChat.mockImplementation(
    async (_provider: string, _actor: unknown, issue: () => string) => {
      if (state.selfMcpNull) return null;
      const token = issue();
      state.issuedTokens.push(token);
      return {
        type: "mcp",
        serverLabel: "cinatra",
        serverUrl: "https://mcp.example.test/api/mcp",
        headers: { Authorization: `Bearer ${token}` },
      };
    },
  );
});

describe("auth", () => {
  it("401 without a session", async () => {
    state.session = null;
    await expectError(await get(), 401, "Unauthorized");
    expect(reads.getAuthSession).toHaveBeenCalledTimes(1);
    expectNoStoreReadAfterSession();
  });

  it("401 for a cit_ bearer even with a valid cookie session, with no session fall back", async () => {
    await expectError(await get(validQuery(), { Authorization: "Bearer cit_abc" }), 401, "Unauthorized");
    expect(reads.getAuthSession).not.toHaveBeenCalled();
    expectNoStoreRead();
  });
});

describe("400 invalid_request reads no store, the session read included", () => {
  const long = "a".repeat(201);
  it.each([
    ["missing threadId", `runId=${RUN_ID}&surface=review`],
    ["missing runId", `threadId=${THREAD_ID}&surface=review`],
    ["missing surface", `threadId=${THREAD_ID}&runId=${RUN_ID}`],
    ["empty threadId", `threadId=&runId=${RUN_ID}&surface=review`],
    ["empty runId", `threadId=${THREAD_ID}&runId=&surface=review`],
    ["empty surface", `threadId=${THREAD_ID}&runId=${RUN_ID}&surface=`],
    ["repeated threadId", `threadId=a&threadId=b&runId=${RUN_ID}&surface=review`],
    ["repeated surface", `${validQuery()}&surface=review`],
    ["an extra parameter", `${validQuery()}&mode=all`],
    ["an over-long threadId", `threadId=${long}&runId=${RUN_ID}&surface=review`],
    ["an over-long runId", `threadId=${THREAD_ID}&runId=${long}&surface=review`],
    ["a non-ASCII threadId", `threadId=thr%C3%A9ad&runId=${RUN_ID}&surface=review`],
    ["a space in runId", `threadId=${THREAD_ID}&runId=run%201&surface=review`],
    ["a control character in threadId", `threadId=t%0A1&runId=${RUN_ID}&surface=review`],
    ["an unknown surface", `threadId=${THREAD_ID}&runId=${RUN_ID}&surface=chat`],
  ])("%s", async (_label, query) => {
    await expectError(await get(query), 400, "invalid_request");
    expectNoStoreRead();
    expectZeroWrites();
  });

  it("400 before 401: a malformed request without a session reads no session", async () => {
    state.session = null;
    await expectError(await get(`threadId=${THREAD_ID}&surface=review`), 400, "invalid_request");
    expectNoStoreRead();
  });

  it("accepts an id of exactly 200 printable characters", async () => {
    const res = await get(`threadId=${"a".repeat(200)}&runId=${RUN_ID}&surface=review`);
    expect(res.status).toBe(200);
  });
});

describe("refusals", () => {
  it("403 when the thread is refused, as the chat route answers it; no window read", async () => {
    reads.authorizeThreadForTurn.mockReturnValue({ ok: false, status: 403, error: "Forbidden" });
    await expectError(await get(), 403, "Forbidden");
    expect(reads.authorizeThreadForTurn).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      callerId: "u1",
      isAdmin: false,
      sessionOrgId: "o1",
    });
    expect(reads.requireRunWindowAccess).not.toHaveBeenCalled();
    expectZeroWrites();
  });

  it.each([
    ["a run that does not exist"],
    ["a run the caller may not read"],
    ["a caller with no bound turn actor"],
  ])("404 not_found, the same body, for %s", async () => {
    reads.requireRunWindowAccess.mockRejectedValue(new Error("Run access denied."));
    await expectError(await get(), 404, "not_found");
    expect(reads.requireRunWindowAccess).toHaveBeenCalledWith(RUN_ID, "read");
    expectZeroWrites();
  });
});

describe("503 codes, each body exactly { error }", () => {
  it("actor_unavailable, not an uncontrolled error, when the session read throws", async () => {
    reads.getAuthSession.mockRejectedValue(new Error("session store down"));
    const res = await get();
    await expectError(res, 503, "actor_unavailable");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expectNoStoreReadAfterSession();
    expectZeroWrites();
  });

  it("actor_unavailable, not an uncontrolled error, when the thread read throws", async () => {
    reads.authorizeThreadForTurn.mockImplementation(() => {
      throw new Error("thread store down");
    });
    const res = await get();
    await expectError(res, 503, "actor_unavailable");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(reads.requireRunWindowAccess).not.toHaveBeenCalled();
    expectZeroWrites();
  });

  it("assembly_failed, not an uncontrolled error, when the hash key cannot be made", async () => {
    state.keyError = new Error("entropy source unavailable");
    const res = await get();
    await expectError(res, 503, "assembly_failed");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expectZeroWrites();
  });

  it("assembly_failed, not an uncontrolled error, when the skill-registration read throws", async () => {
    reads.areInstalledSkillsRegistered.mockImplementation(() => {
      throw new Error("unexpected");
    });
    await expectError(await get(), 503, "assembly_failed");
    expectZeroWrites();
  });

  it("actor_unavailable when requireActorContext fails", async () => {
    reads.requireActorContext.mockRejectedValue(new Error("grants unreadable"));
    await expectError(await get(), 503, "actor_unavailable");
  });

  it("actor_unavailable when resolveUserContextForUserId fails", async () => {
    reads.resolveUserContextForUserId.mockRejectedValue(new Error("user not found"));
    await expectError(await get(), 503, "actor_unavailable");
  });

  it("provider_unavailable when no provider adapter resolves", async () => {
    state.config.modelPrefs = { provider: "openai" };
    state.adapter = null;
    await expectError(await get(), 503, "provider_unavailable");
  });

  it("provider_unavailable on BoundDefaultProviderUnavailableError", async () => {
    const { BoundDefaultProviderUnavailableError } = await import("@cinatra-ai/llm");
    state.adapterError = new BoundDefaultProviderUnavailableError("openai", "exact");
    await expectError(await get(), 503, "provider_unavailable");
  });

  it("skills_not_registered when the accessor says not registered; the assembly never starts", async () => {
    state.registered = false;
    await expectError(await get(), 503, "skills_not_registered");
    expect(reads.areInstalledSkillsRegistered).toHaveBeenCalledWith(SKILLS);
    expect(reads.buildAssistantInjectionPorts).not.toHaveBeenCalled();
    expect(reads.selectSkillDeliveryAdapter).not.toHaveBeenCalled();
    expect(reads.resolveChatExternalMcpTools).not.toHaveBeenCalled();
    expect(reads.readChatMcpCatalogState).not.toHaveBeenCalled();
    expect(reads.resolveBoundDefaultAdapter).not.toHaveBeenCalled();
    expectZeroWrites();
  });

  it("skills_not_registered while the retirement has not settled (the real accessor reads both)", async () => {
    reads.isSupersededChatSkillRetirementSettled.mockImplementation(() => false);
    await expectError(await get(), 503, "skills_not_registered");
    expect(reads.buildAssistantInjectionPorts).not.toHaveBeenCalled();
    expectZeroWrites();
  });

  it("skills_not_synced when the delivery throws its skill-not-synced error", async () => {
    // The delivery errors carry `<provider>_skill_not_synced`; the route reads the suffix.
    state.deliveryError = Object.assign(new Error("not synced"), {
      code: "example_skill_not_synced",
      provider: "example",
    });
    await expectError(await get(), 503, "skills_not_synced");
  });

  it("skill_delivery_refused when the delivery throws its skill-cap error", async () => {
    state.deliveryError = Object.assign(new Error("cap"), {
      code: "example_skill_cap_exceeded",
      provider: "example",
    });
    await expectError(await get(), 503, "skill_delivery_refused");
  });

  it("assembly_failed for any other delivery error", async () => {
    state.deliveryError = Object.assign(new Error("other"), { code: "example_preflight_failed" });
    await expectError(await get(), 503, "assembly_failed");
  });

  it("skill_delivery_refused when the delivery produces no vehicle", async () => {
    state.delivery = { tools: [], systemContext: "", exposure: [] };
    await expectError(await get(), 503, "skill_delivery_refused");
    expectZeroWrites();
  });

  it("tools_unavailable when the self-MCP reference cannot be assembled", async () => {
    state.selfMcpNull = true;
    await expectError(await get(), 503, "tools_unavailable");
  });

  it("catalog_unavailable when the self-MCP catalog state cannot be read", async () => {
    state.catalogError = new Error("inventory unreadable");
    await expectError(await get(), 503, "catalog_unavailable");
  });

  it("external_tools_unavailable when resolveChatExternalMcpTools throws", async () => {
    state.externalError = new Error("registry down");
    await expectError(await get(), 503, "external_tools_unavailable");
  });

  it("tool_unserializable for a non-finite number in a projection", async () => {
    state.delivery = {
      tools: [{ type: "function", name: "f", description: "d", parameters: { max: Number.NaN } }],
      systemContext: "SKILLS_CUE",
      exposure: [],
    };
    await expectError(await get(), 503, "tool_unserializable");
  });

  it("assembly_failed for a tool kind section 5.2 does not list", async () => {
    state.externalTools = [{ type: "code_interpreter", serverLabel: "x" }];
    await expectError(await get(), 503, "assembly_failed");
  });

  it("assembly_failed for any other failure of the assembly", async () => {
    reads.resolveAssistantAssignedSkillIds.mockRejectedValue(new Error("boom"));
    await expectError(await get(), 503, "assembly_failed");
  });
});

describe("200", () => {
  it("answers both reports in the contract shape, no-store, keyed hashes, no tool fields beyond ref", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(["composer", "manifestVersion", "window"]);
    expect(body.manifestVersion).toBe(1);
    expect(Object.keys(body.composer).sort()).toEqual([
      "conversationOnly",
      "manifestHash",
      "threadId",
      "tools",
    ]);
    expect(Object.keys(body.window).sort()).toEqual([
      "conversationOnly",
      "manifestHash",
      "runId",
      "surface",
      "tools",
    ]);
    expect(body.composer.threadId).toBe(THREAD_ID);
    expect(body.window.runId).toBe(RUN_ID);
    expect(body.window.surface).toBe("review");
    expect(body.composer.conversationOnly).toBe(false);
    expect(body.composer.tools.map((t: { ref: unknown }) => t.ref)).toEqual([
      { type: "mcp", serverLabel: "cinatra" },
      { type: "mcp", serverLabel: "ext" },
      { type: "function", name: "skill_file_read" },
      { type: "web_search" },
    ]);
    for (const report of [body.composer, body.window]) {
      expect(report.manifestHash).toMatch(HASH);
      for (const tool of report.tools) {
        expect(Object.keys(tool).sort()).toEqual(["ref", "schemaHash"]);
        expect(tool.schemaHash).toMatch(HASH);
      }
    }
    // Equal inputs, equal reports.
    expect(body.composer.manifestHash).toBe(body.window.manifestHash);
    // The reference's headers and the inert token never leave the route.
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain(state.issuedTokens[0]);
  });

  it("makes a new hash key for each response", async () => {
    const first = await (await get()).json();
    const second = await (await get()).json();
    expect(first.composer.tools.map((t: { ref: unknown }) => t.ref)).toEqual(
      second.composer.tools.map((t: { ref: unknown }) => t.ref),
    );
    expect(first.composer.manifestHash).not.toBe(second.composer.manifestHash);
    expect(first.composer.tools[0].schemaHash).not.toBe(second.composer.tools[0].schemaHash);
  });

  it("echoes the surface and selects nothing: all five surfaces give the same tools", async () => {
    const refsBySurface: unknown[] = [];
    for (const surface of SURFACES) {
      const body = await (await get(validQuery(surface))).json();
      expect(body.window.surface).toBe(surface);
      expect(body.window.manifestHash).toBe(body.composer.manifestHash);
      refsBySurface.push(body.window.tools.map((t: { ref: unknown }) => t.ref));
    }
    for (const refs of refsBySurface) expect(refs).toEqual(refsBySurface[0]);
  });

  it("a conversation-only provider answers empty tool lists and reads no catalog", async () => {
    state.adapter = { provider: "gemini", defaultModel: "gemini-test" };
    const body = await (await get()).json();
    expect(body.composer.conversationOnly).toBe(true);
    expect(body.composer.tools).toEqual([]);
    expect(body.window.tools).toEqual([]);
    expect(reads.readChatMcpCatalogState).not.toHaveBeenCalled();
    expect(reads.resolveChatExternalMcpTools).not.toHaveBeenCalled();
  });
});

describe("the route's read boundary (CONTRACT.md section 5.2, \"Read only\")", () => {
  it("performs none of the turn's write steps: every write entry point spy stays at zero", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    // Registration, retirement, token mints, lent-action grant, reachability
    // probe, delivery record, stream events, thread and run-window rows.
    expectZeroWrites();
    // The self-MCP reference was built with the inert issuer: one fixed value,
    // the same for both roads, and no actor-token mint.
    expect(state.issuedTokens.length).toBe(2);
    expect(new Set(state.issuedTokens).size).toBe(1);
    // No lent-action grant on either road.
    for (const call of reads.buildLlmMcpServerToolForChat.mock.calls) {
      expect((call[3] as { lentActionGrant: unknown }).lentActionGrant).toBeNull();
    }
  });

  it("calls no model and no MCP endpoint itself", async () => {
    // The input reads are fakes here, so any fetch would be the route's own.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const res = await get();
      expect(res.status).toBe(200);
      expect(writes.stream).not.toHaveBeenCalled();
      expect(writes.adapterStream).not.toHaveBeenCalled();
      expect(writes.adapterGenerate).not.toHaveBeenCalled();
      expect(writes.checkPublicMcpReachability).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("one snapshot", () => {
  it("equal inputs: each read happens once and both roads share it", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(reads.areInstalledSkillsRegistered).toHaveBeenCalledTimes(1);
    expect(reads.resolveBoundDefaultAdapter).toHaveBeenCalledTimes(1);
    expect(reads.resolveChatExternalMcpTools).toHaveBeenCalledTimes(1);
    expect(reads.resolveChatExternalMcpTools).toHaveBeenCalledWith("openai", { surface: "chat" });
    expect(reads.deliver).toHaveBeenCalledTimes(1);
    expect(reads.readChatMcpCatalogState).toHaveBeenCalledTimes(1);
  });

  it("the window passes no sessionId: the injected skill set is read once per distinct session", async () => {
    await get();
    const sessions = reads.resolveAssistantAssignedSkillIds.mock.calls.map(
      (call) => (call[0] as { sessionId: string }).sessionId,
    );
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toBe(THREAD_ID);
    expect(sessions[1]).not.toBe(THREAD_ID);
    expect(sessions[1]).toMatch(/^assistant-turn:/);
  });

  it("different inputs on the two roads give two reads and reports that differ", async () => {
    // Only the thread carries an assignment, so the two roads resolve two
    // different catalog id lists.
    reads.resolveAssistantAssignedSkillIds.mockImplementation(
      async ({ sessionId }: { sessionId: string }) =>
        sessionId === THREAD_ID ? ["@cinatra-ai/chat:assigned"] : [],
    );
    reads.deliver.mockImplementation(async (request: { skillIds: string[] }) => ({
      tools: [
        {
          type: "function",
          name: request.skillIds.includes("@cinatra-ai/chat:assigned") ? "with_assigned" : "without",
          description: "read",
          parameters: { type: "object" },
        },
      ],
      systemContext: "SKILLS_CUE",
      exposure: [],
    }));
    const body = await (await get()).json();
    expect(reads.deliver).toHaveBeenCalledTimes(2);
    expect(reads.deliver.mock.calls[0][0].skillIds).toContain("@cinatra-ai/chat:assigned");
    expect(reads.deliver.mock.calls[1][0].skillIds).not.toContain("@cinatra-ai/chat:assigned");
    expect(body.composer.manifestHash).not.toBe(body.window.manifestHash);
  });

  it("a different organization on the window road reads the catalog state once per distinct subject", async () => {
    state.windowContextOrgId = "o2";
    state.windowUser = { userId: "u1", orgId: "o2", platformRole: "member" };
    await get();
    expect(reads.readChatMcpCatalogState).toHaveBeenCalledTimes(2);
    expect(reads.resolveChatExternalMcpTools).toHaveBeenCalledTimes(1);
  });
});
