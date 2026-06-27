/**
 * agent_source_review handler tests.
 *
 * Locks the full contract for the primitive:
 *   - Schema entry exists in AGENT_BUILDER_TOOL_META.
 *   - Zod schema accepts { packageSlug | content, reviewMode: "deterministic" | "advisory" }
 *     and rejects mutual-exclusion violations, missing-both, and unsupported "design" mode.
 *   - Deterministic-only path returns { blockers, warnings, suggestions, ranAdvisoryAgents }
 *     and emits no advisory markers.
 *   - Deterministic blocker path (literal sk- credential) surfaces with source="deterministic".
 *   - Advisory mode is deferred: emits one advisory_dispatch_deferred suggestion per
 *     helper that would have run, and returns ranAdvisoryAgents: [] (no real dispatch —
 *     agent_run queues asynchronously via BullMQ and cannot return findings inline).
 *   - Triviality predicate: trivial OAS omits the agent-planner deferred marker; non-trivial
 *     bumpers (HITL, FlowNode subflow, A2AAgent, external MCPToolBox, ≥2 LLM steps) emit it.
 *   - Advisory short-circuits with no deferred markers when deterministic blockers exist.
 *   - OutputMessageNode is structural — doesn't count toward executable quota.
 *   - Idempotence over byte-identical inputs.
 *   - Handler accepts the typed actor envelope without auth-seam casts (no downstream dispatch
 *     to forward; live forwarding should be exercised when synchronous helper execution lands).
 *
 * Invocation surface: createAgentBuilderPrimitiveHandlers() factory; the
 * agent_source_* family lives there, not on createAgentsPrimitiveHandlers.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/agent-source-review-handler.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @cinatra-ai/mcp-client. The handler does NOT call invokePrimitive
// (advisory dispatch is deferred — agent_run queues
// asynchronously via BullMQ and cannot return findings inline). The mock
// is retained because the module is still imported by other tests in this
// file's transitive graph. Tests 4, 5, and 8 assert the advisory_dispatch_deferred
// suggestion-marker contract instead.
//
// vi.hoisted() guarantees these refs exist before vi.mock factories run.
// ---------------------------------------------------------------------------

const { enteredHelpers, resolvers, mockInvokePrimitive, mockCreateInProcessPrimitiveTransport } =
  vi.hoisted(() => {
    return {
      enteredHelpers: [] as string[],
      resolvers: [] as Array<() => void>,
      mockInvokePrimitive: vi.fn(),
      mockCreateInProcessPrimitiveTransport: vi.fn(() => ({
        invoke: vi.fn(),
      })),
    };
  });

vi.mock("@cinatra-ai/mcp-client", () => ({
  invokePrimitive: mockInvokePrimitive,
  createInProcessPrimitiveTransport: mockCreateInProcessPrimitiveTransport,
  // The handler may reference these types; provide stub values so the import
  // does not break at module load.
  PrimitiveInvocationError: class PrimitiveInvocationError extends Error {},
}));

// Some downstream modules touch heavy host-app deps; stub at the same level
// as other tests in this package.
vi.mock("@cinatra-ai/llm", () => ({
  getActorContext: () => null,
  getActorContextOrThrow: () => {
    throw new Error("not used");
  },
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
  resolveProviderAdapter: () => null,
  ANTHROPIC_API_LOG_DIRECTORY: "/tmp",
  setAnthropicLoggingEnabled: () => {},
}));

// ---------------------------------------------------------------------------
// Mock the heavy transitive dependency chain that handlers.ts pulls in. The
// agent_source_review handler we're locking does not use most of these — they
// only need to be loadable so the static import of handlers.ts succeeds.
// Mirrors the surface from mcp-run-create-execute-gate.test.ts.
// ---------------------------------------------------------------------------
vi.mock("@cinatra-ai/skills", () => ({
  upsertSkill: vi.fn(),
  parseFrontmatter: vi.fn(),
  readLocalPackageSkillContent: vi.fn(),
}));
vi.mock("@cinatra-ai/registries", () => ({ isSafePathSegment: (s: unknown): boolean => typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s), assertSafePathSegment: (s: unknown, label = "path segment"): void => { const ok = typeof s === "string" && s !== "." && s !== ".." && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s); if (!ok) throw new Error("unsafe " + label + ": " + JSON.stringify(s)); }, listAgentPackages: vi.fn() }));
vi.mock("@cinatra-ai/objects", () => ({
  createDeterministicObjectsClient: vi.fn(() => ({})),
}));
vi.mock("../compiler", () => ({ compileWorkflow: vi.fn() }));
vi.mock("../wayflow-url", () => ({
  resolveWayflowUrl: vi.fn(),
  AGENT_RUN_TIMEOUT_MAX_SECONDS: 86_400,
}));
vi.mock("../verdaccio/client", () => ({
  deleteAgentPackageVersion: vi.fn(),
  deprecateAgentPackageVersion: vi.fn(),
  publishAgentPackage: vi.fn(),
  publishAgentPackageFromGitDir: vi.fn(),
}));
vi.mock("../verdaccio/publish-metadata", () => ({
  derivePublishMetadataFromSnapshot: vi.fn(),
}));
vi.mock("../install-from-package", () => ({ installAgentFromPackage: vi.fn() }));
vi.mock("../review-task-actions", () => ({
  approveReviewTaskInternal: vi.fn(),
}));
vi.mock("../trigger-service", () => ({
  setRunTriggerForActor: vi.fn(),
  getRunTriggerForActor: vi.fn(),
  deleteRunTriggerForActor: vi.fn(),
}));
vi.mock("../agent-install-path", () => ({ resolveAgentInstallDir: vi.fn() }));
vi.mock("../zip-helpers", () => ({ createZipBuffer: vi.fn() }));
vi.mock("../oas-compiler", () => ({ compileOasAgentJson: vi.fn() }));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: vi.fn(async () => undefined),
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "agent_builder_execution" },
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: vi.fn(() => ({})),
}));
vi.mock("@/lib/mcp-pagination", () => ({
  decodeCursor: vi.fn(() => 0),
  buildListPage: vi.fn(() => ({ items: [], nextCursor: null })),
}));
vi.mock("@/lib/better-auth-db", () => ({
  readTeamsForUser: vi.fn(async () => []),
  readProjectsForUser: vi.fn(async () => []),
  readUserById: vi.fn(async () => null),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: vi.fn(async () => null),
  isPlatformAdmin: vi.fn(() => false),
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({
  logAuditEvent: vi.fn(async () => undefined),
  POLICY_VERSION: "1.0",
  AuthzError: class extends Error {
    statusCode = 403;
    reason = "denied";
  },
}));
vi.mock("../auth-policy", () => ({
  enforceRunAccess: vi.fn(async () => undefined),
}));
vi.mock("../store", () => ({
  resolveDefaultOrgId: vi.fn(async () => "org-1"),
}));

// ---------------------------------------------------------------------------
// Module under test — import AFTER vi.mock declarations so the mocks land.
// ---------------------------------------------------------------------------

// Note: use the public factory, not a private import. The
// `agent_source_*` family (compile, publish, validate, write) lives on
// `createAgentBuilderPrimitiveHandlers()`. The similarly named
// `createAgentsPrimitiveHandlers()` but that factory only exposes
// `agents_list`; the `agent_source_review` handler is registered on
// the *AgentBuilder* factory alongside its peers. Both factories are public,
// satisfying the "factory not private import" contract.
import { createAgentBuilderPrimitiveHandlers } from "../mcp/handlers";
import { AGENT_BUILDER_TOOL_META } from "../mcp/schemas";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type OasFixture = Record<string, unknown>;

function buildTrivialOas(): OasFixture {
  // Start → ApiNode → End. No HITL, no FlowNode, no A2A.
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "trivial-flow",
    name: "Trivial",
    description: "Trivial single-ApiNode OAS",
    metadata: { cinatra: { type: "node" } },
    nodes: [
      { $component_ref: "start" },
      { $component_ref: "api_step" },
      { $component_ref: "end" },
    ],
    start_node: { $component_ref: "start" },
    control_flow_connections: [
      {
        component_type: "ControlFlowEdge",
        name: "s_to_a",
        from_node: { $component_ref: "start" },
        to_node: { $component_ref: "api_step" },
      },
      {
        component_type: "ControlFlowEdge",
        name: "a_to_e",
        from_node: { $component_ref: "api_step" },
        to_node: { $component_ref: "end" },
      },
    ],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      end: { component_type: "EndNode", id: "end" },
      api_step: {
        component_type: "ApiNode",
        id: "api_step",
        url: "{{CINATRA_BASE_URL}}/api/echo",
        method: "POST",
        body: { hello: "world" },
      },
    },
  };
}

function buildNonTrivialOas(): OasFixture {
  // Start → ApiNode → AgentNode (Agent with system_prompt) → A2AAgent → End.
  // Contains both ApiNode AND a second LLM/A2A step → non-trivial.
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "non-trivial-flow",
    name: "NonTrivial",
    description: "Multi-step flow",
    metadata: { cinatra: { type: "node" } },
    nodes: [
      { $component_ref: "start" },
      { $component_ref: "api_step" },
      { $component_ref: "agent_step" },
      { $component_ref: "a2a_step" },
      { $component_ref: "end" },
    ],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      end: { component_type: "EndNode", id: "end" },
      api_step: {
        component_type: "ApiNode",
        id: "api_step",
        url: "{{CINATRA_BASE_URL}}/api/echo",
        method: "POST",
      },
      agent_step: {
        component_type: "AgentNode",
        id: "agent_step",
        agent: { $component_ref: "inner_agent" },
      },
      inner_agent: {
        component_type: "Agent",
        id: "inner_agent",
        system_prompt: "You are an assistant.",
      },
      a2a_step: {
        component_type: "A2AAgent",
        id: "a2a_step",
        agent_url: "{{CINATRA_BASE_URL}}/api/a2a",
      },
    },
  };
}

function buildOasWithLiteralSecret(): OasFixture {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "leaky-flow",
    name: "Leaky",
    description: "Has a literal credential",
    metadata: { cinatra: { type: "node" } },
    nodes: [],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      api_step: {
        component_type: "ApiNode",
        id: "api_step",
        url: "{{CINATRA_BASE_URL}}/api/echo",
        method: "POST",
        body: {
          Authorization: "Bearer sk-1234567890abcdef1234567890abcdef",
        },
      },
    },
  };
}

function buildOasWithOutputMessageNodeOnly(): OasFixture {
  // Start → OutputMessageNode → ApiNode → End. OutputMessageNode
  // is structural and does NOT count toward the executable-step quota,
  // so this remains trivial.
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "structural-only-flow",
    name: "Structural Only",
    description: "OutputMessageNode + ApiNode",
    metadata: { cinatra: { type: "node" } },
    nodes: [
      { $component_ref: "start" },
      { $component_ref: "say_hi" },
      { $component_ref: "api_step" },
      { $component_ref: "end" },
    ],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      end: { component_type: "EndNode", id: "end" },
      say_hi: {
        component_type: "OutputMessageNode",
        id: "say_hi",
        message: "Hello",
      },
      api_step: {
        component_type: "ApiNode",
        id: "api_step",
        url: "{{CINATRA_BASE_URL}}/api/echo",
        method: "POST",
      },
    },
  };
}

function buildOasWithHitlInputMessageNode(): OasFixture {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "hitl-flow",
    name: "HITL",
    description: "Has an InputMessageNode",
    metadata: { cinatra: { type: "node" } },
    nodes: [],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      end: { component_type: "EndNode", id: "end" },
      ask: { component_type: "InputMessageNode", id: "ask", prompt: "?" },
    },
  };
}

function buildOasWithFlowNodeSubflow(): OasFixture {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "subflow-parent",
    name: "Has FlowNode",
    description: "Embeds a subflow",
    metadata: { cinatra: { type: "node" } },
    nodes: [],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      end: { component_type: "EndNode", id: "end" },
      sub: {
        component_type: "FlowNode",
        id: "sub",
        flow: { $component_ref: "embedded" },
      },
      embedded: {
        component_type: "Flow",
        id: "embedded",
      },
    },
  };
}

function buildOasWithA2AAgentNode(): OasFixture {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "a2a-flow",
    name: "A2A",
    description: "Has A2AAgent",
    metadata: { cinatra: { type: "node" } },
    nodes: [],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      end: { component_type: "EndNode", id: "end" },
      a2a: {
        component_type: "A2AAgent",
        id: "a2a",
        agent_url: "{{CINATRA_BASE_URL}}/api/a2a",
      },
    },
  };
}

function buildOasWithExternalMcpToolbox(): OasFixture {
  // `metadata.cinatra.external: true` does not escape the
  // url-trust scan. Use a relative URL so the URL
  // scan passes, while keeping the `id` as a non-`cinatra-` string so the
  // triviality predicate still flags it as external (`isTrivialOas` treats an
  // external MCPToolBox as one whose id/name doesn't start with "cinatra-").
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "ext-mcp-flow",
    name: "External MCP",
    description: "Has external MCPToolBox",
    metadata: { cinatra: { type: "node" } },
    nodes: [],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      end: { component_type: "EndNode", id: "end" },
      ext_mcp: {
        component_type: "MCPToolBox",
        id: "ext_mcp",
        url: "/api/mcp",
      },
    },
  };
}

function buildOasWithTwoLlmSteps(): OasFixture {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "two-llm-flow",
    name: "Two LLM",
    description: "Two executable LLM steps",
    metadata: { cinatra: { type: "node" } },
    nodes: [],
    start_node: { $component_ref: "start" },
    control_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start" },
      end: { component_type: "EndNode", id: "end" },
      agent1: {
        component_type: "AgentNode",
        id: "agent1",
        agent: { $component_ref: "a1" },
      },
      agent2: {
        component_type: "AgentNode",
        id: "agent2",
        agent: { $component_ref: "a2" },
      },
      a1: { component_type: "Agent", id: "a1", system_prompt: "first" },
      a2: { component_type: "Agent", id: "a2", system_prompt: "second" },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(input: Record<string, unknown>) {
  return {
    primitiveName: "agent_source_review",
    input,
    actor: {
      actorType: "user",
      source: "ui",
      userId: "u-test",
    },
    mode: "deterministic",
  };
}

function getReviewHandler(): (req: unknown) => Promise<unknown> {
  const handlers = createAgentBuilderPrimitiveHandlers();
  return handlers["agent_source_review"];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("agent_source_review — schema registration", () => {
  it("AGENT_BUILDER_TOOL_META has an agent_source_review entry", () => {
    expect(AGENT_BUILDER_TOOL_META["agent_source_review"]).toBeDefined();
  });

  it("Zod schema accepts { packageSlug, reviewMode: 'deterministic' }", () => {
    const meta = AGENT_BUILDER_TOOL_META["agent_source_review"];
    expect(() =>
      meta.inputSchema.parse({
        packageSlug: "email-test-delivery-agent",
        reviewMode: "deterministic",
      }),
    ).not.toThrow();
  });

  it("Zod schema accepts { content, reviewMode: 'advisory' }", () => {
    const meta = AGENT_BUILDER_TOOL_META["agent_source_review"];
    expect(() =>
      meta.inputSchema.parse({
        content: JSON.stringify(buildTrivialOas()),
        reviewMode: "advisory",
      }),
    ).not.toThrow();
  });

  it("Zod schema rejects unsupported reviewMode: 'design'", () => {
    const meta = AGENT_BUILDER_TOOL_META["agent_source_review"];
    // Locks: meta entry exists AND its parse() throws on "design".
    expect(meta).toBeDefined();
    expect(() =>
      meta.inputSchema.parse({
        packageSlug: "x",
        reviewMode: "design",
      }),
    ).toThrow();
  });

  it("Zod schema rejects mutual-exclusion violation (both packageSlug AND content)", () => {
    const meta = AGENT_BUILDER_TOOL_META["agent_source_review"];
    expect(meta).toBeDefined();
    expect(() =>
      meta.inputSchema.parse({
        packageSlug: "x",
        content: "y",
        reviewMode: "advisory",
      }),
    ).toThrow();
  });

  it("Zod schema rejects missing-both (neither packageSlug nor content)", () => {
    const meta = AGENT_BUILDER_TOOL_META["agent_source_review"];
    expect(meta).toBeDefined();
    expect(() =>
      meta.inputSchema.parse({ reviewMode: "deterministic" }),
    ).toThrow();
  });
});

describe("agent_source_review — handler matrix", () => {
  beforeEach(() => {
    enteredHelpers.length = 0;
    resolvers.length = 0;
    mockInvokePrimitive.mockReset();
  });

  it("Test 2 (deterministic-only): clean OAS → empty arrays, no advisory dispatch", async () => {
    const handler = getReviewHandler();
    expect(typeof handler).toBe("function");
    const result = (await handler(
      buildRequest({
        content: JSON.stringify(buildTrivialOas()),
        reviewMode: "deterministic",
      }),
    )) as {
      blockers: unknown[];
      warnings: unknown[];
      suggestions: unknown[];
      ranAdvisoryAgents: string[];
    };
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.suggestions).toEqual([]);
    expect(result.ranAdvisoryAgents).toEqual([]);
    expect(mockInvokePrimitive).not.toHaveBeenCalled();
  });

  it("Test 3 (deterministic blocker): literal sk- credential → blocker, no advisory dispatch", async () => {
    const handler = getReviewHandler();
    const result = (await handler(
      buildRequest({
        content: JSON.stringify(buildOasWithLiteralSecret()),
        reviewMode: "deterministic",
      }),
    )) as {
      blockers: Array<{ source: string; message: string }>;
      ranAdvisoryAgents: string[];
    };
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.blockers[0].source).toBe("deterministic");
    expect(
      result.blockers.some((b) =>
        /literal credential|literal secret/i.test(b.message),
      ),
    ).toBe(true);
    expect(mockInvokePrimitive).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // Advisory dispatch is deferred. The handler
  // does NOT call invokePrimitive — agent_run queues asynchronously and
  // cannot return helper findings inline. Instead it emits one
  // `advisory_dispatch_deferred` suggestion per helper that WOULD have
  // been dispatched, and returns `ranAdvisoryAgents: []` (honest about
  // what actually executed).
  //
  // Tests 4, 5, and 8 below assert the deferred-marker
  // contract. Tests 6 (short-circuit on blockers) and 9 (idempotence)
  // verify the deterministic path. Test 10
  // (actor passthrough) has no downstream dispatch, so there is no
  // downstream actor to inspect; the deterministic path receives the
  // actor in the request envelope unchanged, which the type system
  // already enforces.
  // ─────────────────────────────────────────────────────────────────────
  it("Test 4 (advisory deferred — non-trivial): suggestions contain 3 deferred markers", async () => {
    const handler = getReviewHandler();
    const result = (await handler(
      buildRequest({
        content: JSON.stringify(buildNonTrivialOas()),
        reviewMode: "advisory",
      }),
    )) as {
      blockers: unknown[];
      warnings: unknown[];
      suggestions: Array<{ code: string; source: string }>;
      ranAdvisoryAgents: string[];
    };

    // No real dispatch — invokePrimitive is not called.
    expect(mockInvokePrimitive).not.toHaveBeenCalled();
    // ranAdvisoryAgents is empty (nothing actually executed).
    expect(result.ranAdvisoryAgents).toEqual([]);
    // suggestions has one deferred marker per helper (3 for non-trivial OAS).
    const deferred = result.suggestions.filter(
      (s) => s.code === "advisory_dispatch_deferred",
    );
    expect(deferred).toHaveLength(3);
    const deferredSources = deferred.map((s) => s.source).sort();
    expect(deferredSources).toEqual([
      "agent-code-reviewer",
      "agent-planner",
      "agent-security-reviewer",
    ]);
  });

  it("Test 5 (advisory deferred — trivial): suggestions contain 2 deferred markers (planner skipped)", async () => {
    const handler = getReviewHandler();
    const result = (await handler(
      buildRequest({
        content: JSON.stringify(buildTrivialOas()),
        reviewMode: "advisory",
      }),
    )) as {
      suggestions: Array<{ code: string; source: string }>;
      ranAdvisoryAgents: string[];
    };

    expect(mockInvokePrimitive).not.toHaveBeenCalled();
    expect(result.ranAdvisoryAgents).toEqual([]);
    const deferred = result.suggestions.filter(
      (s) => s.code === "advisory_dispatch_deferred",
    );
    expect(deferred).toHaveLength(2);
    const sources = deferred.map((s) => s.source);
    expect(sources).toContain("agent-security-reviewer");
    expect(sources).toContain("agent-code-reviewer");
    expect(sources).not.toContain("agent-planner");
  });

  it("Test 6 (short-circuit on blockers): advisory with deterministic blocker → empty ranAdvisoryAgents", async () => {
    const handler = getReviewHandler();
    const result = (await handler(
      buildRequest({
        content: JSON.stringify(buildOasWithLiteralSecret()),
        reviewMode: "advisory",
      }),
    )) as {
      blockers: unknown[];
      ranAdvisoryAgents: string[];
    };
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.ranAdvisoryAgents).toEqual([]);
    expect(mockInvokePrimitive).not.toHaveBeenCalled();
  });

  it("Test 7 (OutputMessageNode is structural): Start → OutputMessageNode → ApiNode → End is trivial", async () => {
    const handler = getReviewHandler();
    const result = (await handler(
      buildRequest({
        content: JSON.stringify(buildOasWithOutputMessageNodeOnly()),
        reviewMode: "advisory",
      }),
    )) as {
      suggestions: Array<{ code: string; source: string }>;
    };

    // Deferred contract: trivial OAS produces 2 deferred markers,
    // NOT 3 (planner skipped). Verify by absence of planner in deferred.
    const plannerDeferred = result.suggestions.filter(
      (s) =>
        s.code === "advisory_dispatch_deferred" && s.source === "agent-planner",
    );
    expect(plannerDeferred).toHaveLength(0);
  });

  it.each([
    { name: "HITL InputMessageNode", build: buildOasWithHitlInputMessageNode },
    { name: "FlowNode subflow", build: buildOasWithFlowNodeSubflow },
    { name: "A2AAgent", build: buildOasWithA2AAgentNode },
    { name: "External MCPToolBox", build: buildOasWithExternalMcpToolbox },
    { name: "Two LLM steps", build: buildOasWithTwoLlmSteps },
  ])(
    "Test 8 (triviality bumper — $name): non-trivial → agent-planner deferred (would dispatch)",
    async ({ build }) => {
      const handler = getReviewHandler();
      const result = (await handler(
        buildRequest({
          content: JSON.stringify(build()),
          reviewMode: "advisory",
        }),
      )) as {
        suggestions: Array<{ code: string; source: string }>;
      };

      // Deferred contract: non-trivial OAS produces 3 deferred
      // markers including planner. Verify planner deferred marker is present.
      const plannerDeferred = result.suggestions.filter(
        (s) =>
          s.code === "advisory_dispatch_deferred" &&
          s.source === "agent-planner",
      );
      expect(plannerDeferred).toHaveLength(1);
    },
  );

  it("Test 9 (idempotence): two consecutive deterministic invocations → byte-identical blockers", async () => {
    const handler = getReviewHandler();
    const r1 = (await handler(
      buildRequest({
        content: JSON.stringify(buildOasWithLiteralSecret()),
        reviewMode: "deterministic",
      }),
    )) as { blockers: unknown[] };
    const r2 = (await handler(
      buildRequest({
        content: JSON.stringify(buildOasWithLiteralSecret()),
        reviewMode: "deterministic",
      }),
    )) as { blockers: unknown[] };
    expect(JSON.stringify(r1.blockers)).toEqual(JSON.stringify(r2.blockers));
  });

  it("Test 10 (no auth-seam cast): handler accepts the actor envelope and returns successfully", async () => {
    // Deferred contract: advisory dispatch is stubbed, so there
    // are no downstream dispatch calls to inspect for actor forwarding. This
    // test verifies the handler accepts a typed actor envelope without
    // throwing (no `as never` / `as unknown` casts at the auth seam — see
    // the auth seam cast guard). The static type system
    // already enforces that request.actor flows unchanged through the
    // handler's local scope; this is a runtime smoke check that the handler
    // path through deterministic + deferred-stub does not require any
    // auth-seam erasure to compile.
    const handler = getReviewHandler();
    const result = await handler({
      primitiveName: "agent_source_review",
      input: {
        content: JSON.stringify(buildTrivialOas()),
        reviewMode: "advisory",
      },
      actor: {
        actorType: "user",
        source: "ui",
        userId: "u-test",
      },
      mode: "deterministic",
    });

    expect(result).toMatchObject({
      blockers: expect.any(Array),
      warnings: expect.any(Array),
      suggestions: expect.any(Array),
      ranAdvisoryAgents: [],
    });
  });
});
