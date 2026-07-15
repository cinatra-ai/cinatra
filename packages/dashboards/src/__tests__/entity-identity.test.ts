import { describe, it, expect } from "vitest";

// The versioned backfill migration (source of the coexistence mapping).
import {
  MIGRATABLE_SURFACES,
  buildEntityOverviewBackfillSql,
} from "../../../../migrations/core/core__0048_dashboards-entity-overview-backfill.mjs";

import {
  DASHBOARD_ENTITY_TYPES,
  INSTANCE_ENTITY_TYPES,
  MIGRATABLE_SURFACE_ENTITY_TYPES,
  OVERVIEW_DASHBOARD_NAME,
  buildOverviewDashboardId,
  compareDashboardsForList,
  isKnownEntityType,
  parseLegacySurfaceEntityType,
  parseCanonicalOverviewId,
  type DashboardEntityRef,
  type DashboardOrderFields,
} from "../store/entity-identity";

const ref: DashboardEntityRef = {
  entityType: "agents",
  entityId: "org-1",
  ownerLevel: "user",
  ownerId: "u-1",
};

describe("entity-identity: known types", () => {
  it("accepts the six migratable surfaces + the three instance surfaces", () => {
    for (const t of MIGRATABLE_SURFACE_ENTITY_TYPES) expect(isKnownEntityType(t)).toBe(true);
    for (const t of INSTANCE_ENTITY_TYPES) expect(isKnownEntityType(t)).toBe(true);
    expect(DASHBOARD_ENTITY_TYPES.length).toBe(
      MIGRATABLE_SURFACE_ENTITY_TYPES.length + INSTANCE_ENTITY_TYPES.length,
    );
  });
  it("rejects unknown / non-string entity types (fail-closed)", () => {
    expect(isKnownEntityType("workflows")).toBe(false);
    expect(isKnownEntityType("")).toBe(false);
    expect(isKnownEntityType(undefined)).toBe(false);
    expect(isKnownEntityType(42)).toBe(false);
  });
});

describe("entity-identity: buildOverviewDashboardId", () => {
  it("converges to the legacy system-<surface> id for the six user-owned surfaces", () => {
    // Same id the historical save action + the coexistence migration use, so all
    // paths resolve to ONE row.
    expect(buildOverviewDashboardId(ref)).toBe("system-agents:org-1:u-1");
    for (const surface of MIGRATABLE_SURFACE_ENTITY_TYPES) {
      expect(buildOverviewDashboardId({ ...ref, entityType: surface })).toBe(
        `system-${surface}:org-1:u-1`,
      );
    }
  });
  it("uses the dedicated dash:…:overview form for per-instance / non-user surfaces", () => {
    expect(
      buildOverviewDashboardId({ entityType: "project", entityId: "p-1", ownerLevel: "user", ownerId: "u-1" }),
    ).toBe("dash:project:p-1:user:u-1:overview");
    expect(buildOverviewDashboardId({ ...ref, ownerLevel: "team" })).toBe(
      "dash:agents:org-1:team:u-1:overview",
    );
  });
  it("is deterministic; distinct owners/entities produce distinct ids", () => {
    expect(buildOverviewDashboardId(ref)).toBe(buildOverviewDashboardId({ ...ref }));
    expect(buildOverviewDashboardId({ ...ref, ownerId: "u-2" })).not.toBe(
      buildOverviewDashboardId(ref),
    );
    expect(buildOverviewDashboardId({ ...ref, entityId: "org-2" })).not.toBe(
      buildOverviewDashboardId(ref),
    );
  });
});

describe("entity-identity: compareDashboardsForList", () => {
  const mk = (o: Partial<DashboardOrderFields>): DashboardOrderFields => ({
    isDefault: false,
    name: "z",
    createdAt: new Date(0),
    ...o,
  });
  it("puts the Overview default first regardless of name", () => {
    const overview = mk({ isDefault: true, name: "zzz" });
    const named = mk({ isDefault: false, name: "aaa" });
    expect([named, overview].sort(compareDashboardsForList)[0]).toBe(overview);
  });
  it("orders non-defaults by name (case-insensitive), then oldest createdAt", () => {
    const b = mk({ name: "Beta", createdAt: new Date(10) });
    const a = mk({ name: "alpha", createdAt: new Date(20) });
    const a2 = mk({ name: "Alpha", createdAt: new Date(5) });
    const sorted = [b, a, a2].sort(compareDashboardsForList);
    expect(sorted.map((s) => s.name)).toEqual(["Alpha", "alpha", "Beta"]);
    // "Alpha" (createdAt 5) before "alpha" (createdAt 20): name tie broken by age.
    expect(sorted[0].createdAt.getTime()).toBe(5);
  });
});

describe("entity-identity: parseLegacySurfaceEntityType (compat mapping, fail-closed)", () => {
  it("maps each known system-<surface>:<org>:<user> id to its entityType", () => {
    for (const surface of MIGRATABLE_SURFACE_ENTITY_TYPES) {
      expect(parseLegacySurfaceEntityType(`system-${surface}:org-1:u-1`)).toBe(surface);
    }
  });
  it("returns null for any unrecognized id (never absorbed)", () => {
    expect(parseLegacySurfaceEntityType("system-workflows:org:u")).toBeNull();
    expect(parseLegacySurfaceEntityType("random-uuid-1234")).toBeNull();
    expect(parseLegacySurfaceEntityType("systemagents:org:u")).toBeNull();
    expect(parseLegacySurfaceEntityType("")).toBeNull();
  });
});

describe("entity-identity: parseCanonicalOverviewId (strict, fail-closed)", () => {
  it("parses the exact canonical system-<surface>:<entityId>:<ownerId> shape", () => {
    expect(parseCanonicalOverviewId("system-agents:org-1:u-1")).toEqual({
      entityType: "agents",
      entityId: "org-1",
      ownerId: "u-1",
    });
    // Round-trips buildOverviewDashboardId for every migratable surface.
    for (const surface of MIGRATABLE_SURFACE_ENTITY_TYPES) {
      const id = buildOverviewDashboardId({
        entityType: surface,
        entityId: "org-9",
        ownerLevel: "user",
        ownerId: "u-9",
      });
      expect(parseCanonicalOverviewId(id)).toEqual({
        entityType: surface,
        entityId: "org-9",
        ownerId: "u-9",
      });
    }
  });
  it("returns null for malformed / wrong-arity / unknown-surface / empty ids", () => {
    expect(parseCanonicalOverviewId("system-agents")).toBeNull(); // 1 segment
    expect(parseCanonicalOverviewId("system-agents:x")).toBeNull(); // 2 segments
    expect(parseCanonicalOverviewId("system-agents:o:u:extra")).toBeNull(); // 4 segments
    expect(parseCanonicalOverviewId("system-workflows:o:u")).toBeNull(); // unknown surface
    expect(parseCanonicalOverviewId("dash:agents:org:user:overview")).toBeNull();
    expect(parseCanonicalOverviewId("system-agents::u")).toBeNull(); // empty entityId
    expect(parseCanonicalOverviewId("system-agents:o:")).toBeNull(); // empty ownerId
    expect(parseCanonicalOverviewId(randomUuidLike())).toBeNull();
  });
});

function randomUuidLike(): string {
  return "b3f1c2d4-0000-4000-8000-000000000000";
}

describe("entity-identity: reserved name", () => {
  it("Overview is the reserved default name", () => {
    expect(OVERVIEW_DASHBOARD_NAME).toBe("Overview");
  });
});

// Regression PIN: the migration's surface list AND its generated SQL IN(...)
// clause must stay in sync with MIGRATABLE_SURFACE_ENTITY_TYPES, or a surface
// would be absorbed by one side but not the other.
describe("entity-identity: backfill migration ↔ TS list parity", () => {
  it("migration MIGRATABLE_SURFACES == MIGRATABLE_SURFACE_ENTITY_TYPES", () => {
    expect([...MIGRATABLE_SURFACES].sort()).toEqual(
      [...MIGRATABLE_SURFACE_ENTITY_TYPES].sort(),
    );
  });
  it("generated backfill SQL IN-list == MIGRATABLE_SURFACE_ENTITY_TYPES", () => {
    const sqlText = buildEntityOverviewBackfillSql();
    const m = sqlText.match(/split_part\(id, ':', 1\) IN \(([^)]*)\)/);
    expect(m, "backfill IN(...) clause not found in migration SQL").toBeTruthy();
    const surfaces = [...m![1].matchAll(/'system-([a-z]+)'/g)].map((x) => x[1]).sort();
    expect(surfaces).toEqual([...MIGRATABLE_SURFACE_ENTITY_TYPES].sort());
  });
});
