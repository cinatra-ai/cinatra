/**
 * A tool whose registration declares that it acts outward (cinatra#3745),
 * served through a GUARDED captured leaf on an agent run's frame.
 *
 * The runtime server and the in-process self-invocation hand a guarded leaf's
 * call to the leaf itself: the leaf runs the ordinary boundary and the
 * person-gate consumption. The tool's PLANNED outward declaration must reach
 * that leaf, so a declared tool that the static name set does not list, and
 * whose checker reads the call as read-only, is still held for the person's
 * recorded decision exactly as a tool of the name set is.
 *
 * These cases drive the real `createMcpRuntimeServer` choke point, the real
 * `callHostPrimitive`, the real capability plan, the real guarded leaf
 * (`bindArtifactGuardedMcpHandler` -> `withGuardedRunActionInvocation` ->
 * `withArtifactReviewAction`) and the real `enforceMcpBoundary`. The audit
 * writer, the classification reader, the extension-registry reader, the
 * run-store transaction, the pinned blob and the checker are test doubles.
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
  selfHandlers: new Map<string, { handler: (...args: unknown[]) => unknown; planned: unknown }>(),
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

vi.mock("@cinatra-ai/agents/schema", () => ({
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
vi.mock("@/lib/extension-version-keyed-serving", () => ({
  resolveVersionKeyedCapabilityProviders: () => ({ kind: "refuse" }),
}));
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
vi.mock("@/lib/mcp-server", () => ({
  buildHostSelfPrimitiveHandlers: () => h.selfHandlers,
}));
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
import { createMcpRuntimeServer } from "../../../packages/mcp-server/src/runtime-server";
import { mcpRequestContextStorage, type McpRequestContext } from "../../../packages/mcp-server/src/request-context";
import { planPrimitiveRegistration } from "../../../packages/mcp-server/src/capability-plan";

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

/** The guarded leaf the host binds to the example pack's registered handler. */
async function guardedLeaf() {
  const { bindArtifactGuardedMcpHandler } = await import("@/lib/extension-host-context");
  return bindArtifactGuardedMcpHandler(
    TOOL,
    async (input: unknown) => {
      h.effects.push(TOOL);
      return { content: [{ type: "text", text: `sent to ${(input as { recipient?: string }).recipient}` }] };
    },
    h.identity as never,
  );
}

/** A runtime server holding the guarded leaf, registered with `config`. */
async function viaRuntimeServer(config: Record<string, unknown>) {
  const leaf = await guardedLeaf();
  const runtime = await createMcpRuntimeServer({
    name: "declared-outward-guarded-test",
    version: "0.0.0",
    registerCapabilities: (toolServer) => {
      (toolServer.registerTool as unknown as (n: string, c: unknown, h: (...a: unknown[]) => unknown) => unknown)(
        TOOL, config, leaf);
    },
  });
  const entry = (runtime as unknown as {
    _registeredTools: Record<string, { handler: (...a: unknown[]) => unknown }>;
  })._registeredTools[TOOL];
  if (!entry) throw new Error(`"${TOOL}" is not registered`);
  return (args: unknown, frame: McpRequestContext = runFrame()) =>
    mcpRequestContextStorage.run(frame, () => entry.handler(args, {}));
}

/** The in-process self-invocation over a captured primitive planned from `config`. */
async function viaSelfInvocation(config: Record<string, unknown>) {
  const leaf = await guardedLeaf();
  const planned = planPrimitiveRegistration({
    name: TOOL, config, order: 0,
    host: { packageName: "@example-org/host", version: "1.0.0" },
  });
  h.selfHandlers.set(TOOL, { handler: leaf, planned });
  const { callHostPrimitive, __resetHostSelfPrimitiveHandlers } = await import("@/lib/extension-self-mcp");
  __resetHostSelfPrimitiveHandlers();
  return (args: unknown) => mcpRequestContextStorage.run(runFrame(), () => callHostPrimitive(TOOL, args));
}

const DECLARED = { title: TOOL, description: TOOL, outward: {} };
const PLAIN = { title: TOOL, description: TOOL };

describe("a declared-outward tool on the guarded run path is held for the person's recorded decision", () => {
  let spies: { mockRestore: () => void }[] = [];

  beforeAll(async () => {
    const registry = await vi.importActual<typeof import("@/lib/extension-capabilities-registry")>(
      "@/lib/extension-capabilities-registry");
    h.identity = registry.recordLoadedExtensionIdentity({
      packageName: "@example-org/outward-pack", version: "1.0.0", installId: "install", digest: "f".repeat(64),
    });
  });

  beforeEach(() => {
    h.gateIds = [];
    h.burned.clear();
    h.effects = [];
    h.kind = "read-only";
    h.selfHandlers.clear();
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
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.resetModules();
  });

  it("the runtime server refuses a declared tool its checker reads as read-only when no person approved it, without invoking its handler", async () => {
    const call = await viaRuntimeServer(DECLARED);
    await expect(call({ recipient: "approved" })).rejects.toThrow("action_person_gate_missing");
    expect(h.effects).toEqual([]);
  });

  it("the runtime server serves the declared tool once against one approved person gate, and refuses its replay", async () => {
    h.gateIds = ["gate"];
    const call = await viaRuntimeServer(DECLARED);
    const result = (await call({ recipient: "approved" })) as { content?: { text?: string }[] };
    expect(result.content?.[0]?.text).toBe("sent to approved");
    expect(h.effects).toEqual([TOOL]);
    expect([...h.burned]).toEqual(["gate"]);
    await expect(call({ recipient: "approved" })).rejects.toThrow("action_gate_already_consumed");
    expect(h.effects).toEqual([TOOL]);
  });

  it("the runtime server serves the same tool registered without the declaration as before: read-only, no person gate", async () => {
    const call = await viaRuntimeServer(PLAIN);
    const result = (await call({ recipient: "approved" })) as { content?: { text?: string }[] };
    expect(result.content?.[0]?.text).toBe("sent to approved");
    expect(h.effects).toEqual([TOOL]);
    expect(h.burned.size).toBe(0);
  });

  it("the self-invocation refuses a declared tool its checker reads as read-only when no person approved it, without invoking its handler", async () => {
    const call = await viaSelfInvocation(DECLARED);
    await expect(call({ recipient: "approved" })).rejects.toThrow("action_person_gate_missing");
    expect(h.effects).toEqual([]);
  });

  it("the self-invocation serves the same tool registered without the declaration as before", async () => {
    const call = await viaSelfInvocation(PLAIN);
    await expect(call({ recipient: "approved" })).resolves.toBe("sent to approved");
    expect(h.effects).toEqual([TOOL]);
    expect(h.burned.size).toBe(0);
  });

  it("the declaration a sibling call carried never holds the next call of the same frame", async () => {
    const frame = runFrame();
    const declared = await viaRuntimeServer(DECLARED);
    await expect(declared({ recipient: "approved" }, frame)).rejects.toThrow("action_person_gate_missing");
    const plain = await viaRuntimeServer(PLAIN);
    const result = (await plain({ recipient: "approved" }, frame)) as { content?: { text?: string }[] };
    expect(result.content?.[0]?.text).toBe("sent to approved");
    expect(h.effects).toEqual([TOOL]);
  });
});
