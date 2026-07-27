/**
 * Toolbox build-context threading through the orchestration entry points
 * (cinatra#2019 S4).
 *
 * Pins the full core-side chain at the ONE seam extension toolboxes observe:
 *
 *   task input (`toolboxBuildContext`)
 *     → `injectMcpTools` (single MCP injection site)
 *       → `resolveMcpToolsForDeclaredIds`
 *         → manifest toolbox `buildTools(provider, context)`
 *
 * Contract under test:
 *   1. ENTRY-POINT DEFAULT — an entry-point caller that supplies no context
 *      still yields `{ surface: "agent_run" }` at the toolbox boundary: the
 *      four orchestration entry points are agent-plane surfaces and each
 *      supplies the default at its own injectMcpTools call site.
 *   2. PASSTHROUGH — a caller-supplied context (the llm-bridge's
 *      `{ surface: "agent_run", connectorInstancePin }` once a resolved run
 *      carries an instance binding) reaches the builder VERBATIM — the pin
 *      is a pure narrowing filter and must never be rewritten in transit.
 *   3. FAIL-CLOSED PASS-THROUGH — the exported `injectMcpTools` itself never
 *      invents a context: a direct caller's absent context stays absent all
 *      the way to the toolbox, which then emits nothing if it surface-gates.
 *
 * The heavy import graph is mocked exactly like personal-skill-injection's
 * harness; the REAL registry (resolveMcpToolsForDeclaredIds) and the REAL
 * toolbox sanitizer run, so the observed call is the genuine seam.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GenerateInput, LlmResponse } from "./types";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the module-under-test is imported
// ---------------------------------------------------------------------------

vi.mock("./mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));

vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));

vi.mock("@/lib/external-mcp-toolbox-loader.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/external-mcp-toolbox-loader.server")>();
  return {
    // Keep the REAL sanitizer so builder output crosses the genuine boundary;
    // only the loader resolution is stubbed per test.
    sanitizeExternalMcpToolboxTools: actual.sanitizeExternalMcpToolboxTools,
    loadExternalMcpToolboxBySlug: vi.fn(async () => null),
  };
});

vi.mock("@/lib/llm-toolbox-providers", () => ({
  // No capability provider serves the declared id — the manifest-toolbox
  // branch (the seam under test) resolves it.
  buildToolboxProviderTools: vi.fn(async () => null),
}));

vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn((providerId: string) =>
    providerId === "openai"
      ? {
          abiVersion: 1 as const,
          providerId: "openai",
          createAdapter: async () => ({
            provider: "openai" as const,
            defaultModel: "mock-model",
            generate: _generateMock,
            stream: vi.fn(async () => undefined),
          }),
        }
      : null,
  ),
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));

vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
}));

// Break the circular workspace self-import (./index → ./tools/skills →
// @cinatra-ai/skills → @cinatra-ai/llm).
vi.mock("./tools/skills", () => ({
  buildSkillTools: vi.fn().mockResolvedValue([]),
  buildSkillContext: vi.fn().mockResolvedValue(""),
  readSkillContent: vi.fn().mockResolvedValue(null),
  createShellTool: vi.fn(),
  createLocalSkillShellTool: vi.fn(),
  createMcpServerTool: vi.fn(),
  createWebSearchTool: vi.fn(),
  buildMcpTools: vi.fn(),
}));

vi.mock("@cinatra-ai/metric-usage-api", () => ({
  emitUsageEvent: vi.fn(),
}));

const _generateMock = vi.fn(
  async (_input: GenerateInput): Promise<LlmResponse> => ({
    text: "mock-response",
    status: null,
    incompleteReason: null,
    rawBody: "",
    usage: undefined,
    model: "mock-model",
  }),
);

import { loadExternalMcpToolboxBySlug } from "@/lib/external-mcp-toolbox-loader.server";
import { buildExternalMcpServerTools } from "./mcp-access";
import {
  injectMcpTools,
  runDeterministicLlmTask,
  runSkillAwareDeterministicLlmTask,
} from "./index";
import { withActorContext } from "./actor-context";
import type { ActorContext } from "@/lib/authz/actor-context";

// The entry points fail-close without an ALS actor frame (requireActorFrame) —
// establish the deterministic dev actor the way every real caller does.
const testActor: ActorContext = {
  principalType: "HumanUser",
  principalId: "u-test",
  organizationId: "org-test",
  authSource: "ui",
  policyVersion: "v2",
};
const runWithActor = <T,>(fn: () => Promise<T>): Promise<T> =>
  Promise.resolve(withActorContext(testActor, fn));

function mockToolboxOnce() {
  const buildTools = vi.fn(async () => []);
  vi.mocked(loadExternalMcpToolboxBySlug).mockResolvedValueOnce({ buildTools });
  return buildTools;
}

beforeEach(() => {
  vi.clearAllMocks();
  _generateMock.mockImplementation(
    async (_input: GenerateInput): Promise<LlmResponse> => ({
      text: "mock-response",
      status: null,
      incompleteReason: null,
      rawBody: "",
      usage: undefined,
      model: "mock-model",
    }),
  );
});

describe("toolbox build-context threading — orchestration entry points (cinatra#2019 S4)", () => {
  it("runSkillAwareDeterministicLlmTask without a context ⇒ the toolbox builder receives the agent_run default", async () => {
    const buildTools = mockToolboxOnce();

    await runWithActor(() =>
      runSkillAwareDeterministicLlmTask({
        provider: "openai",
        system: "s",
        user: "u",
        declaredToolboxIds: ["fixture-toolbox"],
      }),
    );

    expect(buildTools).toHaveBeenCalledWith("openai", { surface: "agent_run" });
  });

  it("runSkillAwareDeterministicLlmTask forwards a caller-supplied context VERBATIM (llm-bridge pin passthrough)", async () => {
    const buildTools = mockToolboxOnce();
    const context = {
      surface: "agent_run" as const,
      connectorInstancePin: { connectorKey: "wordpress", instanceId: "inst-1" },
    };

    await runWithActor(() =>
      runSkillAwareDeterministicLlmTask({
        provider: "openai",
        system: "s",
        user: "u",
        declaredToolboxIds: ["fixture-toolbox"],
        toolboxBuildContext: context,
      }),
    );

    expect(buildTools).toHaveBeenCalledWith("openai", context);
  });

  it("runDeterministicLlmTask defaults and forwards identically", async () => {
    const defaulted = mockToolboxOnce();
    await runWithActor(() =>
      runDeterministicLlmTask({
        provider: "openai",
        system: "s",
        user: "u",
        declaredToolboxIds: ["fixture-toolbox"],
      }),
    );
    expect(defaulted).toHaveBeenCalledWith("openai", { surface: "agent_run" });

    const forwarded = mockToolboxOnce();
    const context = {
      surface: "agent_run" as const,
      connectorInstancePin: { connectorKey: "wordpress", instanceId: "inst-2" },
    };
    await runWithActor(() =>
      runDeterministicLlmTask({
        provider: "openai",
        system: "s",
        user: "u",
        declaredToolboxIds: ["fixture-toolbox"],
        toolboxBuildContext: context,
      }),
    );
    expect(forwarded).toHaveBeenCalledWith("openai", context);
  });

  it("the ALWAYS-INJECT path (no declaredToolboxIds) carries the agent_run default into the buildExternalMcpServerTools options", async () => {
    await runWithActor(() =>
      runSkillAwareDeterministicLlmTask({
        provider: "openai",
        system: "s",
        user: "u",
        // declaredToolboxIds deliberately absent — the legacy always-inject
        // enumeration runs, and the entry-point default must ride its options.
      }),
    );

    expect(vi.mocked(buildExternalMcpServerTools)).toHaveBeenCalledWith("openai", {
      skipRegistryFallback: false,
      context: { surface: "agent_run" },
    });
  });

  it("the exported injectMcpTools is PASS-THROUGH: an absent context stays absent (fail-closed for direct callers)", async () => {
    const buildTools = mockToolboxOnce();

    await injectMcpTools({
      provider: "openai",
      tools: undefined,
      declaredToolboxIds: ["fixture-toolbox"],
      // no toolboxBuildContext — a direct (non-entry-point) caller must NOT
      // have a surface invented for it; the toolbox sees undefined and a
      // surface-gating toolbox emits nothing.
    });

    expect(buildTools).toHaveBeenCalledWith("openai", undefined);
  });
});
