/**
 * Scope-leakage guard (the server-seam enforcement point). The portlet loaders
 * derive org scope from the SESSION (resolvePortletAuthz), never from
 * caller-supplied input — proven by spying on the store read and asserting the
 * session orgId flows through even when a (type-cast) bogus orgId/projectId is
 * smuggled into the args. Per-row read authz (canReadObject) is also exercised.
 */
import { describe, it, expect, vi } from "vitest";

const { listSpy, getByIdSpy, canReadSpy } = vi.hoisted(() => ({
  listSpy: vi.fn((_filter: Record<string, unknown>, _actor?: unknown) => [
    { id: "o1", data: { title: "X" }, parentId: null },
    { id: "o2", data: { title: "Y" }, parentId: null },
  ]),
  getByIdSpy: vi.fn((_id: string, _scope: { orgId: string | null }, _actor?: unknown) => ({
    id: "o1",
    type: "@cinatra-ai/assets:blog-project",
    data: { title: "X" },
    orgId: "sess-org",
    ownerLevel: "organization",
    ownerId: "sess-org",
    visibility: "organization",
  })),
  canReadSpy: vi.fn(async () => true),
}));

vi.mock("@/lib/dashboards/portlet-authz", () => ({
  resolvePortletAuthz: vi.fn(async () => ({
    orgId: "sess-org",
    primitiveActor: { actorType: "human", source: "ui", userId: "u" },
    roleHints: { orgRole: "org_admin" },
  })),
  canReadObject: canReadSpy,
  objectResourceCheck: (row: { id: string }) => ({ resourceType: "object", resourceId: row.id }),
}));
vi.mock("@/lib/objects-store", () => ({ listObjectsByFilter: listSpy, getObjectById: getByIdSpy }));
vi.mock("@/lib/authz/enforce-resource-access", () => ({ enforceResourceAccess: vi.fn(async () => undefined) }));

import { loadObjectListPortlet, loadObjectDetailPortlet } from "../portlet-loaders";

describe("portlet loaders — scope from session only", () => {
  it("object-list uses the SESSION orgId, ignoring any smuggled caller orgId/projectId", async () => {
    listSpy.mockClear();
    const out = await loadObjectListPortlet({ typeId: "T", parentId: null, orgId: "attacker-org", projectId: "attacker-proj" } as never);
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy.mock.calls[0]![0]).toMatchObject({ orgId: "sess-org", type: "T" });
    expect(JSON.stringify(listSpy.mock.calls[0]![0])).not.toContain("attacker");
    expect(out).toHaveLength(2); // both rows pass the per-row read gate (canReadObject → true)
  });

  it("requireParent + unresolved parent → EMPTY (no broadening to all rows)", async () => {
    listSpy.mockClear();
    const out = await loadObjectListPortlet({ typeId: "T", parentId: null, requireParent: true });
    expect(out).toEqual([]);
    expect(listSpy).not.toHaveBeenCalled(); // short-circuits before the store read
  });

  it("object-list per-row gate drops rows the actor cannot read", async () => {
    canReadSpy.mockImplementationOnce(async () => false); // first row denied
    const out = await loadObjectListPortlet({ typeId: "T", parentId: null });
    expect(out).toHaveLength(1);
  });

  it("object-detail reads with the session orgId", async () => {
    getByIdSpy.mockClear();
    const d = await loadObjectDetailPortlet({ objectId: "o1" });
    expect(getByIdSpy).toHaveBeenCalledWith("o1", { orgId: "sess-org" });
    expect(d?.label).toBe("X");
  });
});
