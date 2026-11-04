/**
 * A caller-pinned RETAINED version served through the name-keyed self-invocation
 * union (cinatra#3745).
 *
 * The in-process self-invocation map is keyed by tool NAME: its entry for a name
 * is planned from the DEFAULT registration, while the bridge behind it serves the
 * version the caller's own edge pins. When that pinned version declares that it
 * acts outward and the default does not, the call is still held for the person's
 * recorded decision, and an approved decision is consumed once.
 *
 * These cases drive the real `buildHostSelfPrimitiveHandlers` name union and its
 * edge-bound version dispatch, the real host-context registration ports (default
 * `registerTool` and the non-default version's retaining `registerTool`), the
 * real version-keyed serving registry, the real `callHostPrimitive`, the real
 * guarded leaf and the real `enforceMcpBoundary`. The host's platform and
 * connector modules register nothing here; the audit writer, the classification
 * reader, the install-row reader, the run-store transaction, the pinned blob and
 * the checker are test doubles.
 */
import "server-only";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  gateIds: [] as string[],
  burned: new Set<string>(),
  effects: [] as string[],
  kind: "read-only" as string,
  raw: JSON.stringify({ recipient: "approved" }),
  identity: undefined as undefined | Record<string, unknown>,
  rows: new Map<string, Record<string, unknown>>(),
  module: () => ({ registerCapabilities: async () => undefined }),
}));

// The checker reads every call of the example tool as read-only, and covers the
// approved recipient with the pinned revision.
const checker = {
  classify: () => ({ kind: h.kind }),
  check: (input: { arguments: unknown; revisions: { representationRevisionId: string; content: unknown }[] }) => ({
    kind: "checked",
    usedRevisionIds: input.revisions.map((r) => r.representationRevisionId),
    actual: input.arguments,
    pinned: input.revisions[0]!.content,
  }),
};

vi.mock("@cinatra-ai/agents/schema", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  agentRuns: { id: "id", orgId: "org" },
  agentRunOutwardActionPolicies: { runId: "run" },
  artifactReviewGates: { id: "gate", runId: "run", orgId: "org", status: "status", disposition: "disposition" },
  artifactReviewActionConsumptions: { gateId: "gate" },
}));
vi.mock("@/lib/extension-capabilities-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/extension-capabilities-registry")>();
  return {
    ...actual,
    resolveCapabilityProviders: () => [{ packageName: "@example-org/outward-pack", impl: checker }],
    capabilityProviderLoadedIdentity: () => h.identity,
  };
});
vi.mock("@/lib/artifacts/local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({
    openByStorageKey: async () => ({
      sizeBytes: Buffer.byteLength(h.raw),
      stream: (async function* () {
        yield Buffer.from(h.raw);
      })(),
    }),
  }),
}));
// The canonical install rows the caller's edge resolves through.
vi.mock("@cinatra-ai/extensions/canonical-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readInstalledExtensionById: async (id: string) => h.rows.get(id) ?? null,
  readInstalledExtensionsByPackageName: async () => [],
}));
// The live transport's mount and auth plugins are not under test.
vi.mock("@cinatra-ai/mcp-server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createMcpServerAuthPlugins: () => ({}),
  createMcpServerMount: () => ({}),
}));
// The host's platform and connector modules register nothing in this test.
vi.mock("@/lib/extensions", () => ({}));
vi.mock("@/lib/register-test-delivery-send-port", () => ({}));
vi.mock("@/lib/mcp-instructions", () => ({ CINATRA_MCP_INSTRUCTIONS: "", CINATRA_MCP_EXPERIMENTAL: {} }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@/lib/auth-session", () => ({ getAuthSession: async () => null }));
vi.mock("@/lib/connector-mcp-registration.server", () => ({ loadConnectorMcpModules: async () => [] }));
vi.mock("@cinatra-ai/objects/module", () => ({ createObjectsModule: h.module }));
vi.mock("@/lib/artifacts/mcp", () => ({ createArtifactsModule: h.module }));
vi.mock("@/lib/memory/mcp", () => ({ createMemoryPromotionModule: h.module }));
vi.mock("@/lib/artifacts/context-mcp", () => ({ createContextModule: h.module }));
vi.mock("@/lib/approvals/approvals-mcp", () => ({ createApprovalsMcpModule: h.module }));
vi.mock("@/lib/lifecycle/lifecycle-pull-mcp", () => ({ createLifecyclePullMcpModule: h.module }));
vi.mock("@/lib/lifecycle/lent-action-mcp", () => ({ createLentActionMcpModule: h.module }));
vi.mock("@/lib/lifecycle/named-agent-start-mcp", () => ({ createNamedAgentStartMcpModule: h.module }));
vi.mock("@/lib/lifecycle/bound-screen-fill-mcp", () => ({ createBoundScreenFillMcpModule: h.module }));
vi.mock("@/lib/lifecycle/schedule-proposal-mcp", () => ({ createScheduleProposalMcpModule: h.module }));
vi.mock("@/lib/project-seam-mcp", () => ({ createProjectSeamMcpModule: h.module }));
vi.mock("@/lib/connector-inventory-mcp", () => ({ createConnectorInventoryMcpModule: h.module }));
vi.mock("@/lib/appointment-schedule-add-mcp", () => ({ createAppointmentScheduleAddMcpModule: h.module }));
vi.mock("@/lib/assistant-mcp", () => ({ createAssistantMcpModule: h.module }));
vi.mock("@cinatra-ai/projects/module", () => ({ createProjectsModule: h.module }));
vi.mock("@/lib/blog/integration/module", () => ({ createBlogContentModule: h.module }));
vi.mock("@cinatra-ai/dashboards/module", () => ({ createDashboardsModule: h.module }));
vi.mock("@cinatra-ai/dashboards/cubes-mcp-module", () => ({ createDashboardCubesMcpModule: h.module }));
vi.mock("@cinatra-ai/permissions/mcp-module", () => ({ createPermissionsModule: h.module }));
vi.mock("@cinatra-ai/skills/mcp-module", () => ({ createSkillsModule: h.module }));
vi.mock("@cinatra-ai/metric-cost-api", () => ({ createMetricsCostModule: h.module }));
vi.mock("@cinatra-ai/metric-cost-api/mcp-module", () => ({ createMetricCostMcpModule: h.module }));
vi.mock("@cinatra-ai/metric-usage-api/mcp-module", () => ({ createMetricUsageMcpModule: h.module }));
vi.mock("@cinatra-ai/trigger/module", () => ({ createTriggerModule: h.module }));
vi.mock("@cinatra-ai/chat/module", () => ({ createChatModule: h.module }));
vi.mock("@cinatra-ai/agents/module", () => ({ createAgentsModule: h.module }));
vi.mock("@cinatra-ai/extensions/mcp-module", () => ({ createExtensionsModule: h.module }));
vi.mock("@cinatra-ai/agents/store", () => ({
  parseRunStepToolPolicy: (p: unknown) => p,
  assertRunStepToolAllowed: () => undefined,
  readRunStepToolPolicy: async () => ({}),
  isRunExecutedSourceCurrent: async () => true,
  withRunActionPolicyTransaction: async (_scope: unknown, fn: (tx: object) => Promise<unknown>) => {
    let select = 0;
    const gate = (id: string) => ({
      id,
      status: "resolved",
      disposition: "approve",
      resolvedBy: "person",
      resolvedAt: new Date(),
      fingerprint: "person:gate",
      pinnedTargets: [{ artifactId: "artifact", representationRevisionId: "revision" }],
    });
    const chain = () => {
      let table: { gateId?: string } | undefined;
      let gateId = "gate";
      let n = -1;
      return {
        from(value: { gateId?: string }) {
          table = value;
          if (!table.gateId) n = select++;
          return this;
        },
        where(condition: Parameters<PgDialect["sqlToQuery"]>[0]) {
          const params = new PgDialect().sqlToQuery(condition).params;
          gateId = String(table?.gateId ? params.at(-1) : params[1]);
          return this;
        },
        for() {
          return Promise.resolve(
            n === 0
              ? [{ status: "running", executionAttemptId: "attempt", a2aContextId: "ctx" }]
              : n === 1
                ? [{ orgId: "org", executionAttemptId: "attempt",
                    policy: { sourceSha256: "a".repeat(64), declarationSourceSha256: "c".repeat(64) } }]
                : h.gateIds.includes(gateId) ? [gate(gateId)] : [],
          );
        },
        orderBy() {
          return Promise.resolve(h.gateIds.map(gate));
        },
        then(resolve: (rows: { gateId: string }[]) => unknown) {
          return Promise.resolve(h.burned.has(gateId) ? [{ gateId }] : []).then(resolve);
        },
      };
    };
    let exec = 0;
    const tx = {
      select: chain,
      execute: async () => {
        const n = exec++;
        if (n === 0) return { rows: [] };
        if ((n - 1) % 3 === 0) return { rows: [{ id: "person" }] };
        if ((n - 1) % 3 === 1) return { rows: [{ id: "artifact", type: "document", deleted_at: null }] };
        return {
          rows: [{
            id: "revision", kind: "blob", form: "file",
            substance_key: "blob:" + createHash("sha256").update(h.raw).digest("hex"),
            metadata: { storageKey: "bound" }, size_bytes: Buffer.byteLength(h.raw),
          }],
        };
      },
      insert: () => ({
        values: (value: { gateId: string }) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              if (h.burned.has(value.gateId)) return [];
              h.burned.add(value.gateId);
              return [{ gateId: value.gateId }];
            },
          }),
        }),
      }),
    };
    return fn(tx);
  },
}));

import * as auditModule from "@/lib/authz/audit";
import * as augmentModule from "@/lib/authz/inventory-augment";
import * as extensionRegistryModule from "@/lib/extension-mcp-registry";
import { mcpRequestContextStorage, type McpRequestContext } from "../../../packages/mcp-server/src/request-context";

const PKG = "@example-org/outward-pack";
const CALLER = "@example-org/caller-pack";
// An invented tool name outside the boundary's name list.
const TOOL = "example_outward_tool";
const FIXTURE_CLASSIFICATION = { resourceType: "agent_run", action: "execute", status: "enforced" } as const;
const proof = {
  contextId: "ctx", stepId: "step", executionAttemptId: "attempt",
  sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
};
const runFrame = (): McpRequestContext =>
  ({
    runId: "run", orgId: "org", userId: "person", orgWriteAuthority: {},
    verifiedStepId: "step", verifiedExecutedSource: proof,
  }) as unknown as McpRequestContext;

/**
 * The default version 1.0.0 registers the tool WITHOUT the declaration; the
 * retained version 2.0.0 registers it WITH `outward: {}`. Both go through the
 * host-context registration ports, so each handler is the host's guarded leaf.
 */
async function registerBothVersions() {
  const registry = await vi.importActual<typeof import("@/lib/extension-capabilities-registry")>(
    "@/lib/extension-capabilities-registry");
  const defaultIdentity = registry.recordLoadedExtensionIdentity({
    packageName: PKG, version: "1.0.0", installId: "install-default", digest: "d".repeat(64),
  });
  const retainedIdentity = registry.recordLoadedExtensionIdentity({
    packageName: PKG, version: "2.0.0", installId: "install-retained", digest: "e".repeat(64),
  });
  // The checker is the retained version's own.
  h.identity = retainedIdentity as unknown as Record<string, unknown>;
  const { createExtensionHostContext, createNonDefaultVersionHostContext } = await import(
    "@/lib/extension-host-context");
  createExtensionHostContext(PKG, ["mcp"], {}, {
    installId: "install-default", version: "1.0.0", isDefault: true, loadedActionIdentity: defaultIdentity,
  }).mcp.registerTool({
    name: TOOL, description: TOOL,
    handler: async (input: unknown) => {
      h.effects.push("1.0.0");
      return { sentTo: (input as { recipient?: string }).recipient };
    },
  });
  const { beginVersionKeyedRegistration } = await import("@/lib/extension-version-keyed-serving");
  const sink = beginVersionKeyedRegistration(PKG, "2.0.0");
  createNonDefaultVersionHostContext(PKG, ["mcp"], {}, sink, {
    installId: "install-retained", version: "2.0.0", isDefault: false, loadedActionIdentity: retainedIdentity,
  }).mcp.registerTool({
    name: TOOL, description: TOOL, outward: {},
    handler: async (input: unknown) => {
      h.effects.push("2.0.0");
      return { sentTo: (input as { recipient?: string }).recipient };
    },
  });
  sink.commit();
}

/** A run-frame self-invocation by a caller whose edge pins the retained version. */
async function viaPinnedCaller() {
  const { callHostPrimitive, __resetHostSelfPrimitiveHandlers } = await import("@/lib/extension-self-mcp");
  __resetHostSelfPrimitiveHandlers();
  const { runWithExtensionCtxIdentity } = await import("@/lib/extension-ctx-dependent-identity");
  return (args: unknown) =>
    mcpRequestContextStorage.run(runFrame(), () =>
      runWithExtensionCtxIdentity(
        { packageName: CALLER, installId: "install-caller", version: "1.0.0", isDefault: true },
        () => callHostPrimitive(TOOL, args),
      ));
}

describe("a caller-pinned retained version that declares outward is held under a default that does not", () => {
  let spies: { mockRestore: () => void }[] = [];

  beforeAll(async () => {
    h.rows.set("install-caller", {
      id: "install-caller", packageName: CALLER, status: "active", isDefault: true, version: "1.0.0",
      dependencyEdges: [{ packageName: PKG, resolvedInstallId: "install-retained" }],
    });
    h.rows.set("install-retained", {
      id: "install-retained", packageName: PKG, status: "active", isDefault: false, version: "2.0.0",
      dependencyEdges: [],
    });
    await registerBothVersions();
  });

  beforeEach(() => {
    h.gateIds = [];
    h.burned.clear();
    h.effects = [];
    h.kind = "read-only";
    const realLookup = augmentModule.lookupPrimitiveClassification;
    spies = [
      vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined),
      vi.spyOn(augmentModule, "lookupPrimitiveClassification").mockImplementation((name: string) =>
        name === TOOL ? { ...FIXTURE_CLASSIFICATION } : realLookup(name)),
      vi.spyOn(extensionRegistryModule, "getEffectiveExtensionMcpTool").mockReturnValue(undefined),
    ];
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  afterAll(async () => {
    (await import("@/lib/extension-version-keyed-serving")).__resetVersionKeyedServingForTests();
    extensionRegistryModule.removeExtensionMcpToolsForPackage(PKG);
    vi.resetModules();
  });

  it("refuses the retained version's call its checker reads as read-only when no person approved it, without invoking either handler", async () => {
    const call = await viaPinnedCaller();
    await expect(call({ recipient: "approved" })).rejects.toThrow("action_person_gate_missing");
    expect(h.effects).toEqual([]);
    expect(h.burned.size).toBe(0);
  });

  it("serves the retained version once against one approved person gate, consumes it, and refuses its replay", async () => {
    h.gateIds = ["gate"];
    const call = await viaPinnedCaller();
    await expect(call({ recipient: "approved" })).resolves.toEqual({ sentTo: "approved" });
    expect(h.effects).toEqual(["2.0.0"]);
    expect([...h.burned]).toEqual(["gate"]);
    await expect(call({ recipient: "approved" })).rejects.toThrow("action_gate_already_consumed");
    expect(h.effects).toEqual(["2.0.0"]);
  });
});
