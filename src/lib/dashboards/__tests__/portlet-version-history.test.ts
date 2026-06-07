/**
 * PORT-07 artifact-version-history loader. Proves it reads the field from the
 * CanonicalSnapshot's `payload.data` (not the snapshot root) and returns ONLY
 * events that changed `parentObjectField` — create included iff the field went
 * absent→value; unchanged updates dropped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  eventsSpy: vi.fn(() => [] as unknown[]),
  getByIdSpy: vi.fn(() => ({ id: "obj1", data: {}, orgId: "sess-org", ownerLevel: "organization", ownerId: "sess-org", visibility: "organization" })),
}));

vi.mock("@/lib/dashboards/portlet-authz", () => ({
  resolvePortletAuthz: vi.fn(async () => ({
    orgId: "sess-org",
    primitiveActor: { actorType: "human", source: "ui", userId: "u" },
    roleHints: { orgRole: "org_admin" },
    actorContext: { principalType: "HumanUser", principalId: "u" },
  })),
  objectResourceCheck: (row: { id: string }) => ({ resourceType: "object", resourceId: row.id }),
  canReadObject: vi.fn(async () => true),
}));
vi.mock("@/lib/objects-store", () => ({ listObjectsByFilter: vi.fn(() => []), getObjectById: h.getByIdSpy }));
vi.mock("@/lib/artifacts/artifact-service", () => ({ listArtifacts: vi.fn(() => []), getArtifact: vi.fn(() => null) }));
vi.mock("@/lib/object-history/eligibility", () => ({ listEventsForObject: h.eventsSpy }));
vi.mock("@/lib/authz/enforce-resource-access", () => ({ enforceResourceAccess: vi.fn(async () => undefined) }));
vi.mock("@cinatra-ai/workflows/store", () => ({ readWorkflow: vi.fn(), listWorkflows: vi.fn(async () => []) }));

import { loadObjectVersionHistoryPortlet } from "../portlet-loaders";

const ev = (over: Record<string, unknown>) => ({
  changeSetId: "cs", operation: "update", createdAt: "2026-01-01T00:00:00Z", actorKind: "user",
  beforeSnapshot: null, afterSnapshot: null, ...over,
});

beforeEach(() => h.eventsSpy.mockReset());

describe("PORT-07 loadObjectVersionHistoryPortlet", () => {
  it("reads the field from payload.data and includes a create that set it", async () => {
    h.eventsSpy.mockReturnValueOnce([
      ev({ changeSetId: "c1", operation: "create", beforeSnapshot: null, afterSnapshot: { payload: { data: { body: "art-1" } } } }),
    ]);
    const out = await loadObjectVersionHistoryPortlet({ objectId: "obj1", parentObjectField: "body" });
    expect(out).toHaveLength(1);
    expect(out[0]!.fieldValue).toBe("art-1");
  });

  it("includes an update that CHANGED the field and drops one that did not", async () => {
    h.eventsSpy.mockReturnValueOnce([
      ev({ changeSetId: "c-changed", beforeSnapshot: { payload: { data: { body: "art-1" } } }, afterSnapshot: { payload: { data: { body: "art-2" } } } }),
      ev({ changeSetId: "c-same", beforeSnapshot: { payload: { data: { body: "art-2" } } }, afterSnapshot: { payload: { data: { body: "art-2" } } } }),
    ]);
    const out = await loadObjectVersionHistoryPortlet({ objectId: "obj1", parentObjectField: "body" });
    expect(out.map((e) => e.changeSetId)).toEqual(["c-changed"]);
    expect(out[0]!.fieldValue).toBe("art-2");
  });

  it("returns empty when the object cannot be found", async () => {
    h.getByIdSpy.mockReturnValueOnce(null as never);
    const out = await loadObjectVersionHistoryPortlet({ objectId: "missing", parentObjectField: "body" });
    expect(out).toEqual([]);
  });
});
