// restoreObjectToVersion deleted/live transition tests.
// This test locks all four transitions, ensuring deleted_at is honored
// rather than always routing through historyAwareUpsert:
// LIVE→LIVE / LIVE→DELETED / DELETED→LIVE / DELETED→DELETED.

import { describe, expect, it, vi, beforeEach } from "vitest";

// vi.mock factories are HOISTED — top-level const captures don't survive
// the lift. Use vi.hoisted to declare shared mocks AND inline them
// inside the factories.

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  softDelete: vi.fn(),
  undelete: vi.fn(),
  readScope: vi.fn(),
  listEvents: vi.fn(),
  resolveFreshness: vi.fn(),
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
  historyAwareUpsert: mocks.upsert,
  historyAwareSoftDelete: mocks.softDelete,
  historyAwareUndelete: mocks.undelete,
}));

vi.mock("../eligibility", () => ({
  loadChangeSet: vi.fn(),
  listEventsForObject: mocks.listEvents,
  readObjectScopeById: mocks.readScope,
  summarizeChangeSetEligibility: vi.fn(),
}));

vi.mock("../freshness/resolve", () => ({
  resolveExternalFreshness: vi.fn(),
  resolveEventFreshness: mocks.resolveFreshness,
}));

vi.mock("../change-set", () => ({
  openChangeSet: vi.fn(() => ({ changeSetId: "cs_new" })),
  closeChangeSet: vi.fn(),
}));

vi.mock("@/lib/database", () => ({
  ensurePostgresSchema: () => {},
  getPostgresConnectionString: () => "test",
  postgresSchema: "test",
}));

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: vi.fn(() => []),
}));

import { restoreObjectToVersion } from "../restore-engine";
import type { ObjectChangeEvent } from "../types";

function makeEvent(overrides: Partial<ObjectChangeEvent>): ObjectChangeEvent {
  return {
    id: "che_target",
    changeSetId: "cs_target",
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
    remoteRevisionRef: null,
    actorId: null,
    actorKind: null,
    runId: null,
    auditEventId: null,
    orgId: "org_1",
    projectId: null,
    ownerLevel: null,
    ownerId: null,
    visibility: null,
    idempotencyKey: "che_target",
    eventChecksum: "ck",
    createdAt: "2026-05-23T10:00:00Z",
    tombstonedAt: null,
    ...overrides,
  };
}

describe("restoreObjectToVersion — deleted/live state transitions", () => {
  beforeEach(() => {
    mocks.upsert.mockReset();
    mocks.softDelete.mockReset();
    mocks.undelete.mockReset();
    mocks.readScope.mockReset();
    mocks.listEvents.mockReset();
    mocks.resolveFreshness.mockReset();
    mocks.upsert.mockReturnValue({
      objectId: "obj_1",
      resultVersion: 5,
      event: { id: "che_new", changeSetId: "cs_new" },
      changeSetId: "cs_new",
      rowSnapshot: {},
    });
    mocks.softDelete.mockReturnValue({
      objectId: "obj_1",
      resultVersion: 5,
      event: { id: "che_new", changeSetId: "cs_new" },
      changeSetId: "cs_new",
      rowSnapshot: {},
    });
    mocks.undelete.mockReturnValue({
      objectId: "obj_1",
      resultVersion: 5,
      event: { id: "che_new", changeSetId: "cs_new" },
      changeSetId: "cs_new",
      rowSnapshot: {},
    });
  });

  it("LIVE → LIVE: calls historyAwareUpsert with target.data", async () => {
    mocks.readScope.mockReturnValue({
      id: "obj_1",
      type: "blog.post",
      orgId: "org_1",
      ownerLevel: "organization",
      ownerId: "org_1",
      visibility: "organization",
      projectId: null,
      version: 4,
      deletedAt: null, // current LIVE
    });
    mocks.listEvents.mockReturnValue([
      makeEvent({
        resultVersion: 2,
        afterSnapshot: {
          payload: { data: { title: "target-live" }, deleted_at: null },
        },
      }),
    ]);
    await restoreObjectToVersion({
      objectId: "obj_1",
      targetVersion: 2,
      actor: { actorId: "user_1", actorKind: "user", orgId: "org_1" },
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.softDelete).not.toHaveBeenCalled();
    expect(mocks.undelete).not.toHaveBeenCalled();
  });

  it("LIVE → DELETED: calls historyAwareSoftDelete", async () => {
    mocks.readScope.mockReturnValue({
      id: "obj_1",
      type: "blog.post",
      orgId: "org_1",
      ownerLevel: "organization",
      ownerId: "org_1",
      visibility: "organization",
      projectId: null,
      version: 4,
      deletedAt: null, // current LIVE
    });
    mocks.listEvents.mockReturnValue([
      makeEvent({
        resultVersion: 2,
        operation: "soft-delete",
        afterSnapshot: {
          payload: {
            data: { title: "target-deleted" },
            deleted_at: "2026-05-23T09:00:00Z",
          },
        },
      }),
    ]);
    await restoreObjectToVersion({
      objectId: "obj_1",
      targetVersion: 2,
      actor: { actorId: "user_1", actorKind: "user", orgId: "org_1" },
    });
    expect(mocks.softDelete).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.undelete).not.toHaveBeenCalled();
  });

  it("DELETED → LIVE: calls historyAwareUndelete with restoredData", async () => {
    mocks.readScope.mockReturnValue({
      id: "obj_1",
      type: "blog.post",
      orgId: "org_1",
      ownerLevel: "organization",
      ownerId: "org_1",
      visibility: "organization",
      projectId: null,
      version: 4,
      deletedAt: "2026-05-23T10:30:00Z", // current DELETED
    });
    mocks.listEvents.mockReturnValue([
      makeEvent({
        resultVersion: 2,
        afterSnapshot: {
          payload: { data: { title: "target-live" }, deleted_at: null },
        },
      }),
    ]);
    await restoreObjectToVersion({
      objectId: "obj_1",
      targetVersion: 2,
      actor: { actorId: "user_1", actorKind: "user", orgId: "org_1" },
    });
    expect(mocks.undelete).toHaveBeenCalledTimes(1);
    expect(mocks.undelete.mock.calls[0][0]).toMatchObject({
      objectId: "obj_1",
      orgId: "org_1",
      restoredData: { title: "target-live" },
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.softDelete).not.toHaveBeenCalled();
  });

  it("DELETED → DELETED: no-op (returns degenerate result)", async () => {
    mocks.readScope.mockReturnValue({
      id: "obj_1",
      type: "blog.post",
      orgId: "org_1",
      ownerLevel: "organization",
      ownerId: "org_1",
      visibility: "organization",
      projectId: null,
      version: 4,
      deletedAt: "2026-05-23T10:30:00Z", // current DELETED
    });
    mocks.listEvents.mockReturnValue([
      makeEvent({
        resultVersion: 2,
        operation: "soft-delete",
        afterSnapshot: {
          payload: {
            data: { title: "target-deleted" },
            deleted_at: "2026-05-23T09:00:00Z",
          },
        },
      }),
    ]);
    const result = await restoreObjectToVersion({
      objectId: "obj_1",
      targetVersion: 2,
      actor: { actorId: "user_1", actorKind: "user", orgId: "org_1" },
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.softDelete).not.toHaveBeenCalled();
    expect(mocks.undelete).not.toHaveBeenCalled();
    expect(result.appliedEventCount).toBe(0);
    expect(result.affectedObjects).toEqual(["obj_1"]);
  });
});
