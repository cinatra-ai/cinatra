import { describe, it, expect } from "vitest";

import { listDashboardsForEntity } from "../mutation-service";
import type { DashboardActor } from "../permissions";
import type { DashboardEntityRef } from "../store/entity-identity";

// listDashboardsForEntity fail-closes (returns []) on an incomplete ref or actor
// BEFORE it ever touches the database — so these assertions need no DB. This is
// the "empty scope → zero rows" invariant at the exact-composite filter layer
// (the cube SecurityContext predicates enforce the same at the analytics-query
// layer; both remain fail-closed).
const goodRef: DashboardEntityRef = {
  entityType: "agents",
  entityId: "org-1",
  ownerLevel: "user",
  ownerId: "u-1",
};
const goodActor: DashboardActor = { userId: "u-1", organizationId: "org-1", teamIds: [] };

describe("listDashboardsForEntity fail-closed guard (no DB)", () => {
  it("returns [] when the actor has no active organization", async () => {
    const actor = { ...goodActor, organizationId: "" };
    await expect(listDashboardsForEntity(goodRef, actor)).resolves.toEqual([]);
  });
  it("returns [] for an unknown entityType", async () => {
    const ref = { ...goodRef, entityType: "workflows" as unknown as DashboardEntityRef["entityType"] };
    await expect(listDashboardsForEntity(ref, goodActor)).resolves.toEqual([]);
  });
  it("returns [] when entityId is empty", async () => {
    await expect(listDashboardsForEntity({ ...goodRef, entityId: "" }, goodActor)).resolves.toEqual(
      [],
    );
  });
  it("returns [] when ownerId is empty", async () => {
    await expect(listDashboardsForEntity({ ...goodRef, ownerId: "" }, goodActor)).resolves.toEqual(
      [],
    );
  });
});
