// cinatra#2807 fix leg 5, CONVERGENCE round. The listed-rows read of a scope's
// Dashboards collection must be tenant-fenced on BOTH sides of its join.
//
// Fix leg 5 widened the organization landing's read so every confirmed member
// sees the tab body (the ratified drawing: "A member without write authority
// still sees the Dashboards tab and every row — homed and listed alike"). That
// makes the listed read reachable for more principals, so its own tenant fence
// has to be exact. The homed read has always filtered
// `dashboards.organization_id`; the listed read filtered only the junction's
// DENORMALIZED `dashboard_entity_links.organization_id`, and no composite
// constraint ties those two columns together. A malformed, migrated or directly
// inserted link row would therefore surface another tenant's dashboard id, name
// and canonical path to members of the viewed scope.
//
// This test reads the actual query the store builds — it captures the drizzle
// condition handed to `.where()` and walks its chunks for the real Column
// objects by IDENTITY, so it cannot pass on a lookalike string.
import { describe, it, expect, beforeEach, vi } from "vitest";

const captured = vi.hoisted(() => ({ where: null as unknown }));

vi.mock("../db", async () => {
  const schema = await vi.importActual<typeof import("../schema")>("../schema");
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (cond: unknown) => {
      captured.where = cond;
      return Promise.resolve([]);
    },
  };
  return {
    dashboards: schema.dashboards,
    dashboardEntityLinks: schema.dashboardEntityLinks,
    getDashboardsDb: () => ({ select: () => chain }),
  };
});

import { dashboards, dashboardEntityLinks } from "../schema";
import { listScopeListedDashboards } from "../entity-links";

/** Every object reachable through a drizzle SQL condition's chunk tree. */
function chunkNodes(node: unknown, seen = new Set<unknown>()): unknown[] {
  if (node === null || typeof node !== "object" || seen.has(node)) return [];
  seen.add(node);
  const out: unknown[] = [node];
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const c of chunks) out.push(...chunkNodes(c, seen));
  }
  if (Array.isArray(node)) {
    for (const c of node) out.push(...chunkNodes(c, seen));
  }
  return out;
}

beforeEach(() => {
  captured.where = null;
});

describe("listScopeListedDashboards is tenant-fenced on both sides of its join", () => {
  it("constrains the JOINED dashboard's own organization, not only the junction's denormalized column", async () => {
    await listScopeListedDashboards({
      kind: "organization",
      scopeId: "org-1",
      orgId: "org-1",
    });

    expect(captured.where).not.toBeNull();
    const nodes = chunkNodes(captured.where);

    // The junction's denormalized tenant column — the fence that already existed.
    expect(nodes).toContain(dashboardEntityLinks.organizationId);
    // The joined dashboard's OWN tenant column — the fence this round added.
    // Without it a link row whose denormalized org disagrees with its
    // dashboard's org leaks that dashboard across the tenant boundary.
    expect(nodes).toContain(dashboards.organizationId);
  });

  it("still constrains the scope's own kind and id", async () => {
    await listScopeListedDashboards({
      kind: "team",
      scopeId: "team-9",
      orgId: "org-1",
    });
    const nodes = chunkNodes(captured.where);
    expect(nodes).toContain(dashboardEntityLinks.entityType);
    expect(nodes).toContain(dashboardEntityLinks.entityId);
    expect(nodes).toContain(dashboards.organizationId);
  });
});
