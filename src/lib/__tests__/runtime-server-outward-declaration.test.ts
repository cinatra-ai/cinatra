/**
 * A tool whose registration declares that it acts outward, called through the
 * runtime server on an agent run's frame (cinatra#3745).
 *
 * The runtime server plans every registration once, and its call-time wrapper
 * hands the boundary `declaresOutward` from that planned entry. On an agent
 * run's frame the boundary then holds a declared tool exactly as it holds a
 * tool of its name list, and the tool's handler is not invoked.
 *
 * These cases drive the real `createMcpRuntimeServer` choke point, the real
 * capability plan and the real `enforceMcpBoundary`. Only the audit writer,
 * the classification reader and the extension-registry reader are test
 * doubles; every double is restored after each case. The server's lazy import
 * of the boundary resolves in this root tier.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionMcpToolConfig } from "@cinatra-ai/sdk-extensions/mcp-contract";
import * as auditModule from "@/lib/authz/audit";
import * as augmentModule from "@/lib/authz/inventory-augment";
import * as extensionRegistryModule from "@/lib/extension-mcp-registry";
import { createMcpRuntimeServer } from "../../../packages/mcp-server/src/runtime-server";
import {
  mcpRequestContextStorage,
  type McpRequestContext,
} from "../../../packages/mcp-server/src/request-context";
import type { CapabilityPlan } from "../../../packages/mcp-server/src/capability-plan";
import {
  planExtensionToolDiscovery,
  type ResolveEdgeBoundExtensionDeps,
} from "@/lib/extension-edge-bound-serving";

const REASON = "outward_effect_requires_recorded_decision";

// An invented tool name outside the rule's name list.
const TOOL = "example_outward_tool";

const FIXTURE_CLASSIFICATION = { resourceType: "agent_run", action: "execute", status: "enforced" } as const;

const runMemberFrame = (): McpRequestContext =>
  ({ orgId: "org-1", userId: "user-1", runId: "run-1" }) as McpRequestContext;

type ToolResult = { content?: Array<{ type?: string; text?: string }>; isError?: boolean };

/**
 * Build a runtime server holding one tool registered with `config`, and return
 * a function that calls it inside `frame` plus the record of handler calls.
 */
async function buildOneTool(config: unknown) {
  const handled: string[] = [];
  const runtime = await createMcpRuntimeServer({
    name: "outward-declaration-test",
    version: "0.0.0",
    registerCapabilities: (toolServer) => {
      (
        toolServer.registerTool as unknown as (
          n: string,
          c: unknown,
          h: (...a: unknown[]) => unknown,
        ) => unknown
      )(TOOL, config, async () => {
        handled.push(TOOL);
        return { content: [{ type: "text", text: "served" }] };
      });
    },
  });
  const registry = (
    runtime as unknown as {
      _registeredTools: Record<string, { handler: (...a: unknown[]) => unknown }>;
    }
  )._registeredTools;
  const entry = registry[TOOL];
  if (!entry) throw new Error(`"${TOOL}" is not registered`);
  return {
    handled,
    call: async (frame: McpRequestContext): Promise<ToolResult> =>
      (await mcpRequestContextStorage.run(frame, () => entry.handler({}, {}))) as ToolResult,
  };
}

describe("the runtime server hands the boundary the outward declaration of the planned entry", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let classificationSpy: ReturnType<typeof vi.spyOn>;
  let extensionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const realLookup = augmentModule.lookupPrimitiveClassification;
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    classificationSpy = vi
      .spyOn(augmentModule, "lookupPrimitiveClassification")
      .mockImplementation((name: string) => (name === TOOL ? { ...FIXTURE_CLASSIFICATION } : realLookup(name)));
    extensionSpy = vi.spyOn(extensionRegistryModule, "getEffectiveExtensionMcpTool").mockReturnValue(undefined);
  });

  afterEach(() => {
    auditSpy.mockRestore();
    classificationSpy.mockRestore();
    extensionSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("answers a tool whose registration declares outward with the named reason on a run's frame, without invoking its handler", async () => {
    const config = {
      title: TOOL,
      description: TOOL,
      outward: {},
    } satisfies ExtensionMcpToolConfig;
    const built = await buildOneTool(config);
    const result = await built.call(runMemberFrame());
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(REASON);
    expect(built.handled).toEqual([]);
  });

  it("serves the same tool registered without the declaration on a run's frame by the boundary's other rules", async () => {
    const config = { title: TOOL, description: TOOL } satisfies ExtensionMcpToolConfig;
    const built = await buildOneTool(config);
    const result = await built.call(runMemberFrame());
    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text).toBe("served");
    expect(built.handled).toEqual([TOOL]);
  });

  it("answers a tool whose registration declares a value the host cannot read with the named reason on a run's frame", async () => {
    const built = await buildOneTool({ title: TOOL, description: TOOL, outward: "yes" });
    const result = await built.call(runMemberFrame());
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(REASON);
    expect(built.handled).toEqual([]);
  });

  it("decides with the declaration read at registration, whatever a later read of the config answers", async () => {
    let reads = 0;
    const config: Record<string, unknown> = { title: TOOL, description: TOOL };
    Object.defineProperty(config, "outward", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? {} : undefined;
      },
    });
    const built = await buildOneTool(config);
    const result = await built.call(runMemberFrame());
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(REASON);
    expect(built.handled).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The road a `ctx.mcp.registerTool` tool takes to the runtime server: the
// default registry, the per-request discovery plan, the replay's config, then
// the runtime server's one choke point. The outward declaration the
// registration states rides every step unchanged, so the boundary holds the
// replayed tool on a run's frame exactly as it holds a `(name, config,
// handler)` registration that declares outward. Every step is the real one;
// only the audit writer, the classification reader and the extension-registry
// reader are test doubles, restored after each case.
// ---------------------------------------------------------------------------

const REGISTERED_PACKAGE = "@example-org/outward-tools";
const REGISTERED_VERSION = "1.2.0";
const SUBJECT = { artifactId: "itemId", representationRevisionId: "revisionId" };

// No dependent identity: the discovery plan serves every tool from the default
// registry, as for a caller with no resolved edges.
const noIdentityDeps: ResolveEdgeBoundExtensionDeps = {
  getDependentInstallId: () => undefined,
  getVerifiedRunId: () => undefined,
  readInstalledExtensionById: async () => null,
  readAgentRunById: async () => null,
  readAgentTemplateById: async () => null,
  readInstalledExtensionsByPackageName: async () => [],
};

/**
 * Register one tool exactly as `ctx.mcp.registerTool` does, carry it through
 * the discovery plan and the replay with the provenance the host's server
 * build writes for a default entry, and register the replayed config into a
 * runtime server. Returns the planned entry, a function that calls the tool
 * inside a frame, and the record of the registration's handler calls.
 */
async function replayRegisteredTool(outward?: ExtensionMcpToolConfig["outward"]) {
  const handled: string[] = [];
  extensionRegistryModule.registerExtensionMcpTool(
    REGISTERED_PACKAGE,
    {
      name: TOOL,
      handler: async () => {
        handled.push(TOOL);
        return "served";
      },
      ...(outward === undefined ? {} : { outward }),
    },
    { resolvedVersion: REGISTERED_VERSION },
  );
  const discovery = await planExtensionToolDiscovery(
    extensionRegistryModule.listExtensionMcpTools(),
    noIdentityDeps,
  );
  const entry = discovery.entries.find((e) => e.tool.name === TOOL);
  if (entry?.mode !== "default") throw new Error(`"${TOOL}" is not a default discovery entry`);
  const registration = entry.tool;
  const resolvedVersion = registration.resolvedVersion ?? null;
  const config = extensionRegistryModule.buildReplayedExtensionToolConfig(TOOL, registration, {
    ownerPackage: registration.packageName,
    resolvedVersion,
    dispatchTarget: {
      kind: "extension-default",
      packageName: registration.packageName,
      version: resolvedVersion ?? extensionRegistryModule.UNRESOLVED_EXTENSION_VERSION,
      name: TOOL.toLowerCase(),
    },
  });

  let plan: CapabilityPlan | undefined;
  const runtime = await createMcpRuntimeServer({
    name: "outward-declaration-replay-test",
    version: "0.0.0",
    onCapabilityPlan: (p) => {
      plan = p;
    },
    registerCapabilities: (toolServer) => {
      (
        toolServer.registerTool as unknown as (
          n: string,
          c: unknown,
          h: (...a: unknown[]) => unknown,
        ) => unknown
      )(TOOL, config, async (input: unknown) => ({
        content: [{ type: "text", text: String(await registration.handler(input)) }],
      }));
    },
  });
  const planned = plan?.entries.find((p) => p.registeredName === TOOL);
  if (!planned) throw new Error(`"${TOOL}" is not planned`);
  const served = (
    runtime as unknown as {
      _registeredTools: Record<string, { handler: (...a: unknown[]) => unknown }>;
    }
  )._registeredTools[TOOL];
  if (!served) throw new Error(`"${TOOL}" is not registered`);
  return {
    planned,
    handled,
    call: async (frame: McpRequestContext): Promise<ToolResult> =>
      (await mcpRequestContextStorage.run(frame, () => served.handler({}, {}))) as ToolResult,
  };
}

describe("a ctx.mcp.registerTool registration's outward declaration rides the replay to the runtime server's boundary", () => {
  let auditSpy: ReturnType<typeof vi.spyOn>;
  let classificationSpy: ReturnType<typeof vi.spyOn>;
  let extensionSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    extensionRegistryModule._resetExtensionMcpForTests();
    const realLookup = augmentModule.lookupPrimitiveClassification;
    auditSpy = vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
    classificationSpy = vi
      .spyOn(augmentModule, "lookupPrimitiveClassification")
      .mockImplementation((name: string) => (name === TOOL ? { ...FIXTURE_CLASSIFICATION } : realLookup(name)));
    extensionSpy = vi.spyOn(extensionRegistryModule, "getEffectiveExtensionMcpTool").mockReturnValue(undefined);
  });

  afterEach(() => {
    auditSpy.mockRestore();
    classificationSpy.mockRestore();
    extensionSpy.mockRestore();
    vi.restoreAllMocks();
    extensionRegistryModule._resetExtensionMcpForTests();
  });

  it("plans `outward: {}` as outward and answers a call on a run's frame with the named reason, without invoking the handler", async () => {
    const replayed = await replayRegisteredTool({});
    expect(replayed.planned.declaredOutward).toEqual({ subject: null });
    const result = await replayed.call(runMemberFrame());
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(REASON);
    expect(replayed.handled).toEqual([]);
  });

  it("plans a declared subject as exactly that subject and answers a call on a run's frame with the named reason", async () => {
    const replayed = await replayRegisteredTool({ subject: { ...SUBJECT } });
    expect(replayed.planned.declaredOutward).toEqual({ subject: SUBJECT });
    const result = await replayed.call(runMemberFrame());
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(REASON);
    expect(replayed.handled).toEqual([]);
  });

  it("plans no declaration for a registration without one and serves it on a run's frame by the boundary's other rules", async () => {
    const replayed = await replayRegisteredTool();
    expect(replayed.planned.declaredOutward).toBeNull();
    const result = await replayed.call(runMemberFrame());
    expect(result.isError).not.toBe(true);
    expect(result.content?.[0]?.text).toBe("served");
    expect(replayed.handled).toEqual([TOOL]);
  });
});
