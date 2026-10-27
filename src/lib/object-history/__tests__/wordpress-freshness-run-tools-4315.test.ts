/**
 * The three core tools that reach the WordPress freshness read on an agent run
 * (cinatra#4315): change_set_undo, object_version_restore and
 * freshness_check_for_change_set. Each handler runs in the run frame with no
 * guarded owner, as a core tool does. With the host-derived owner the read is
 * served once and its verdict follows the stub payload; without it the read
 * fails closed and object_version_restore refuses with external-source-changed.
 *
 * Drives the real handlers, the real freshness sweep, the real adapter, the
 * real invoker and the real run guard. The change-set and object reads, the
 * writer, the access check, the run store, the audit writer, the trusted-actor
 * resolution and the invoker's injected deps (wire, endpoint, catalog) are
 * doubles.
 */
import "server-only";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const h = vi.hoisted(() => ({
  deps: undefined as unknown,
  loadChangeSet: vi.fn(),
  listEventsForObject: vi.fn(),
  readObjectScopeById: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({
  parseRunStepToolPolicy: (p: unknown) => p,
  readRunStepToolPolicy: async () => ({}),
  assertRunStepToolAllowed: () => ({ kind: "declared" }),
  isRunExecutedSourceCurrent: async () => true,
  withRunActionPolicyTransaction: async () => {
    throw new Error("no person-gate consumption in these cases");
  },
}));
vi.mock("@/lib/register-host-connector-services", () => ({
  buildConnectorInstanceInvokerDeps: () => h.deps,
}));
vi.mock("@/lib/connector-instance-write-authority", () => ({
  resolveTrustedWriteActor: async () => ({
    actor: { principalType: "HumanUser", principalId: "person", organizationId: "org" },
    userId: "person",
    orgId: "org",
  }),
}));
vi.mock("@/lib/authz/enforce-resource-access", () => ({
  enforceResourceAccess: async () => undefined,
}));
// The restore engine's schema check is the only database touch on these
// paths; its leaf module has this one export.
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
// The change-set reads, the writer and the change-set store, as the
// version-restore test doubles them (version-restore-deleted-state.test.ts).
vi.mock("../eligibility", () => ({
  loadChangeSet: h.loadChangeSet,
  listEventsForObject: h.listEventsForObject,
  readObjectScopeById: h.readObjectScopeById,
  summarizeChangeSetEligibility: vi.fn(),
}));
vi.mock("../canonical-writer", () => ({
  __internals: {
    hashInputData: () => "h",
    computeChecksum: () => "ck",
    eligibilityForEffect: () => ({ eligible: true, reason: null }),
    readObjectRowForSnapshot: () => null,
    getNextEventSequence: () => 1,
    SUPPORTED_SCHEMA_VERSIONS: new Set(["v1"]),
  },
  __statementBuilders: {
    create: () => ({ text: "", values: [] }),
    update: () => ({ text: "", values: [] }),
    softDelete: () => ({ text: "", values: [] }),
    undelete: () => ({ text: "", values: [] }),
  },
  historyAwareUpsert: h.upsert,
  historyAwareSoftDelete: vi.fn(),
  historyAwareUndelete: vi.fn(),
}));
vi.mock("../change-set", () => ({
  openChangeSet: vi.fn(() => ({ changeSetId: "cs_new" })),
  closeChangeSet: vi.fn(),
}));

import * as auditModule from "@/lib/authz/audit";
import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server/request-context";
import * as hostContext from "@/lib/extension-host-context";
import type { ConnectorInstanceInvokerDeps } from "@/lib/connector-instance-invoker";
import {
  createInMemoryConnectorInstanceCatalogCache,
  CATALOG_DEFAULT_SERVER_ID,
  type CatalogServerSnapshot,
} from "@/lib/connector-instance-catalog-cache";
import * as restoreEngine from "../restore-engine";
import { RestoreNotEligibleError } from "../restore-engine";
import type { ObjectChangeEvent } from "../types";
import { createObjectHistoryPrimitiveHandlers } from "../../../../packages/objects/src/mcp/object-history-handlers";

const INSTANCE = "wp_instance_1";
const CAPTURED = "2026-05-23T10:00:00";
const CHANGED = "2026-06-01T08:00:00";
const proof = {
  contextId: "ctx", stepId: "step", executionAttemptId: "attempt",
  sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: "c".repeat(64),
};
const runFrame = () =>
  ({ runId: "run", orgId: "org", userId: "person", verifiedStepId: "step", verifiedExecutedSource: proof }) as unknown as McpRequestContext;

function fixture(modifiedGmt: string) {
  const tool = (name: string) =>
    ({ name, serverId: CATALOG_DEFAULT_SERVER_ID, inputSchema: {}, rawAnnotations: { readOnlyHint: true, destructiveHint: false } });
  const snapshot: CatalogServerSnapshot = {
    serverId: CATALOG_DEFAULT_SERVER_ID,
    exposureMode: "triad-only",
    tools: [tool("ewpa/get-post"), tool("ewpa/get-page")],
    catalogRevision: "rev",
    fetchedAtMs: 0,
  };
  const cache = createInMemoryConnectorInstanceCatalogCache();
  cache.set(INSTANCE, snapshot);
  const wire = vi.fn(async () => ({ success: true, data: { post_modified_gmt: modifiedGmt, post_content: "body" } }));
  h.deps = {
    requireUse: async () => {},
    ensureDefaultOpenPolicy: async () => ({ created: false }),
    resolveInstanceEndpoint: async () => ({ endpoint: "https://site.invalid/mcp", authHeader: "Basic native-test" }),
    cache,
    loadServerSnapshot: async () => snapshot,
    callWireTool: wire,
    readPolicy: async () => ({ connectorKey: "wordpress", instanceId: INSTANCE, mode: "open", updatedBy: "person", updatedAt: new Date(0).toISOString() }),
    audit: async () => {},
  } as ConnectorInstanceInvokerDeps;
  return { wire };
}

function wordpressEvent(): ObjectChangeEvent {
  return {
    id: "che_1",
    changeSetId: "cs_1",
    sequence: 1,
    objectId: "obj_1",
    objectType: "blog.post",
    operation: "update",
    historyEffect: "reversible-internal",
    beforeSnapshot: { payload: { data: { title: "before" } } },
    afterSnapshot: { payload: { data: { title: "target" }, deleted_at: null } },
    baseVersion: 1,
    resultVersion: 2,
    objectSchemaVersion: "v1",
    restoreEligible: true,
    restoreIneligibleReason: null,
    compensatingTemplateId: null,
    remoteRevisionRef: {
      connector: "wordpress",
      kind: "wordpress-post",
      remoteId: "42",
      modifiedAt: CAPTURED,
      extra: { instanceId: INSTANCE },
    },
    actorId: null,
    actorKind: null,
    runId: null,
    auditEventId: null,
    orgId: "org",
    projectId: null,
    ownerLevel: "organization",
    ownerId: "org",
    visibility: "organization",
    idempotencyKey: "che_1",
    eventChecksum: "ck",
    createdAt: "2026-05-23T10:00:00Z",
    tombstonedAt: null,
  } as unknown as ObjectChangeEvent;
}
const loaded = () => ({
  changeSet: {
    id: "cs_1", restorable: true, restorableReason: null, effectRollup: "reversible-internal", orgId: "org",
    openedAt: "2026-05-23T10:00:00Z", closedAt: "2026-05-23T10:00:01Z", closureReason: "single-mutation-close",
  },
  events: [wordpressEvent()],
});
const scope = {
  id: "obj_1", type: "blog.post", orgId: "org", ownerLevel: "organization", ownerId: "org",
  visibility: "organization", projectId: null, version: 4, deletedAt: null,
};

let restoreChangeSet: MockInstance;

type Handler = (request: { input: unknown; actor: unknown; mode: string; primitiveName: string }) => Promise<unknown>;
function run(name: "change_set_undo" | "object_version_restore" | "freshness_check_for_change_set", input: unknown) {
  const handler = (createObjectHistoryPrimitiveHandlers() as unknown as Record<string, Handler>)[name]!;
  const actor = { actorType: "model", source: "agent", orgId: "org", userId: "person", runId: "run",
    orgWriteAuthority: { orgId: "org", can: () => true } };
  return mcpRequestContextStorage.run(runFrame(), () => handler({ input, actor, mode: "write", primitiveName: name }));
}

beforeEach(() => {
  vi.spyOn(auditModule, "logAuditEvent").mockResolvedValue(undefined);
  h.loadChangeSet.mockReset().mockImplementation(() => loaded());
  h.listEventsForObject.mockReset().mockImplementation(() => [wordpressEvent()]);
  h.readObjectScopeById.mockReset().mockImplementation(() => ({ ...scope }));
  h.upsert.mockReset().mockReturnValue({ objectId: "obj_1", resultVersion: 5, event: { id: "che_new", changeSetId: "cs_new" }, changeSetId: "cs_new", rowSnapshot: {} });
  // change_set_undo hands its freshness map to the restore; the restore itself is out of scope here.
  restoreChangeSet = vi.spyOn(restoreEngine, "restoreChangeSet").mockReturnValue({ restoreChangeSetId: "cs_restore", appliedEventCount: 1, affectedObjects: ["obj_1"] } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("cinatra#4315 item 1: without the host-derived owner the read fails closed on a run", () => {
  it("object_version_restore on a WordPress-tagged object refuses with external-source-changed and no wire call", async () => {
    if (typeof (hostContext as Record<string, unknown>).withWordPressFreshnessReadOwner === "function") {
      vi.spyOn(hostContext, "withWordPressFreshnessReadOwner").mockImplementation(
        ((_read: unknown, effect: (toolName: string) => Promise<unknown>) => effect("ewpa/get-post")) as typeof hostContext.withWordPressFreshnessReadOwner,
      );
    }
    const { wire } = fixture(CAPTURED);
    const call = run("object_version_restore", { objectId: "obj_1", targetVersion: 2 });
    await expect(call).rejects.toBeInstanceOf(RestoreNotEligibleError);
    await expect(call).rejects.toMatchObject({ reasons: ["external-source-changed"] });
    expect(wire).toHaveBeenCalledTimes(0);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe("cinatra#4315 item 3: each core tool's read is served on a run", () => {
  it.each([
    ["fresh", CAPTURED],
    ["changed", CHANGED],
  ] as const)("freshness_check_for_change_set serves one wire call and reports %s", async (state, modified) => {
    const { wire } = fixture(modified);
    const result = (await run("freshness_check_for_change_set", { changeSetId: "cs_1" })) as {
      ok: true; results: { objectId: string; freshness: { state: string } }[];
    };
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.freshness.state).toBe(state);
    expect(wire).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["fresh", CAPTURED],
    ["changed", CHANGED],
  ] as const)("change_set_undo serves one wire call and hands a %s verdict to the restore", async (state, modified) => {
    const { wire } = fixture(modified);
    await expect(run("change_set_undo", { changeSetId: "cs_1" })).resolves.toMatchObject({ ok: true });
    expect(wire).toHaveBeenCalledTimes(1);
    expect(restoreChangeSet).toHaveBeenCalledTimes(1);
    const map = (restoreChangeSet.mock.calls[0]![0] as { externalFreshness: Map<string, { state: string }> }).externalFreshness;
    expect(map.get("obj_1")?.state).toBe(state);
  });

  it("object_version_restore serves one wire call and restores on a fresh verdict", async () => {
    const { wire } = fixture(CAPTURED);
    await expect(run("object_version_restore", { objectId: "obj_1", targetVersion: 2 })).resolves.toMatchObject({ ok: true });
    expect(wire).toHaveBeenCalledTimes(1);
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it("object_version_restore serves one wire call and refuses with external-source-changed on a changed verdict", async () => {
    const { wire } = fixture(CHANGED);
    const call = run("object_version_restore", { objectId: "obj_1", targetVersion: 2 });
    await expect(call).rejects.toBeInstanceOf(RestoreNotEligibleError);
    await expect(call).rejects.toMatchObject({ reasons: ["external-source-changed"] });
    expect(wire).toHaveBeenCalledTimes(1);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});
