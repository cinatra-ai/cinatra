// cinatra#1738 D1 — createDashboard records the entity anchor derived from the
// required ownerLevel/ownerId scope. Covers the codex-flagged hazards: the
// reserved "Overview" name now applies to ANCHORED creates (it never did on
// this path), and the per-entity name-uniqueness constraint newly fires here —
// its 23505 must map to a name conflict ONLY for dashboards_entity_name_uniq
// (a client-supplied dashboardId makes a primary-key collision reachable, and
// that must surface raw, not as a name conflict).

import { describe, it, expect, vi, beforeEach } from "vitest";

// Captures every .values() payload; `failNextInsert` simulates a Postgres
// unique violation (shaped like the drizzle-wrapped driver error: code +
// constraint on the cause chain).
const state = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  failNextInsert: null as null | { code: string; constraint?: string },
}));

vi.mock("../store/db", () => {
  // Positional table arg deliberately ignored (extra args are fine in JS).
  const insert = () => ({
    values: (v: Record<string, unknown>) => {
      if (state.failNextInsert) {
        const fail = state.failNextInsert;
        state.failNextInsert = null;
        const cause = Object.assign(new Error("duplicate key"), fail);
        const wrapped = Object.assign(new Error("insert failed"), { cause });
        const p = Promise.reject(wrapped);
        // Only ONE of the two consumers (await values() vs .returning()) runs
        // per call — silence the other path's unhandled-rejection tracker.
        p.catch(() => {});
        return Object.assign(p, { returning: () => Promise.reject(wrapped) });
      }
      state.inserted.push(v);
      const p = Promise.resolve([v]);
      return Object.assign(p, { returning: async () => [v] });
    },
  });
  // `execute` backs the writer's advisory-lock statement (cinatra#1894 B1b): the
  // twin lock is a DB-concurrency no-op with no observable effect in this mock.
  const tx = { insert, execute: async () => ({ rows: [] }) };
  return {
    auditEvents: {},
    dashboardRevisions: {},
    dashboards: {},
    getDashboardsDb: () => ({
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    }),
  };
});

import {
  createDashboard,
  DashboardForbiddenError,
  DashboardInvalidEntityError,
  DashboardNameConflictError,
} from "../mutation-service";
import type { DashboardActor } from "../permissions";

const ORG = "org-1";
const TEAM = "team-1";

const actor: DashboardActor = {
  userId: "user-1",
  organizationId: ORG,
  teamIds: [TEAM],
  orgRole: "admin",
  teamRoles: { [TEAM]: "admin" },
};

// Minimal bare drizzle-cube config — normalizeConfigForWrite wraps it into the
// apiVersion 1.2 envelope (the shape agents emit; mirrors
// EMPTY_ENTITY_DASHBOARD_DC).
const DC = {
  portlets: [] as unknown[],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

function input(overrides: Record<string, unknown>) {
  return {
    name: "Ops board",
    config: DC,
    ownerLevel: "user",
    ownerId: "user-1",
    ...overrides,
  } as Parameters<typeof createDashboard>[0];
}

function dashboardRow(): Record<string, unknown> {
  // The dashboards row is the one carrying ownerLevel (audit rows do not).
  const row = state.inserted.find((r) => "ownerLevel" in r);
  if (!row) throw new Error("no dashboards insert captured");
  return row;
}

beforeEach(() => {
  state.inserted = [];
  state.failNextInsert = null;
});

describe("createDashboard anchor derivation (#1738)", () => {
  it("team scope → entityType/entityId anchored to the team", async () => {
    await createDashboard(input({ ownerLevel: "team", ownerId: TEAM }), actor);
    expect(dashboardRow()).toMatchObject({ entityType: "team", entityId: TEAM });
  });

  it("organization scope → anchored to the org", async () => {
    await createDashboard(input({ ownerLevel: "organization", ownerId: ORG }), actor);
    expect(dashboardRow()).toMatchObject({ entityType: "organization", entityId: ORG });
  });

  it("user and workspace scopes → anchor stays NULL", async () => {
    await createDashboard(input({ ownerLevel: "user", ownerId: "user-1" }), actor);
    expect(dashboardRow()).toMatchObject({ entityType: null, entityId: null });
    state.inserted = [];
    await createDashboard(input({ ownerLevel: "workspace", ownerId: ORG }), actor);
    expect(dashboardRow()).toMatchObject({ entityType: null, entityId: null });
  });

  it("a team the actor does not admin is FORBIDDEN by the existing resolver (no new lookups)", async () => {
    await expect(
      createDashboard(input({ ownerLevel: "team", ownerId: "foreign-team" }), actor),
    ).rejects.toBeInstanceOf(DashboardForbiddenError);
    expect(state.inserted).toHaveLength(0);
  });

  it("anchored creates reject the reserved Overview name (previously unenforced here)", async () => {
    await expect(
      createDashboard(input({ ownerLevel: "team", ownerId: TEAM, name: "Overview" }), actor),
    ).rejects.toBeInstanceOf(DashboardInvalidEntityError);
  });

  it("a user-scope create named Overview keeps today's behavior (allowed, unanchored)", async () => {
    await createDashboard(input({ name: "Overview" }), actor);
    expect(dashboardRow()).toMatchObject({ name: "Overview", entityType: null });
  });

  it("23505 on dashboards_entity_name_uniq → DashboardNameConflictError", async () => {
    state.failNextInsert = { code: "23505", constraint: "dashboards_entity_name_uniq" };
    await expect(
      createDashboard(input({ ownerLevel: "team", ownerId: TEAM }), actor),
    ).rejects.toBeInstanceOf(DashboardNameConflictError);
  });

  it("23505 on any OTHER constraint (e.g. a client-supplied id PK collision) surfaces raw", async () => {
    state.failNextInsert = { code: "23505", constraint: "dashboards_pkey" };
    await expect(
      createDashboard(input({ ownerLevel: "team", ownerId: TEAM }), actor),
    ).rejects.not.toBeInstanceOf(DashboardNameConflictError);
  });
});
