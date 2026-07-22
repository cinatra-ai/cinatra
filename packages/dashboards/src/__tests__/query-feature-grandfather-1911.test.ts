// cinatra#1911 × cinatra#1913 — the executable-feature write gate must ride
// the "no NET NEW validator errors" grandfathering: a dashboard that already
// persists a feature-violating query (written before the gate existed) stays
// editable — an untouched re-save passes, a RENAME of the violating card
// passes (the violation message is keyed by the stable card id, never the
// display title), and only a NEW violation throws, with delta-only copy.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("../store/db", () => {
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: async () => (state.row ? [state.row] : []),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            state.updates.push(v);
            return [{ ...state.row, ...v }];
          },
        }),
      }),
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        state.audits.push(v);
        return [v];
      },
    }),
  };
  return {
    auditEvents: {},
    dashboardRevisions: {},
    dashboards: {},
    getDashboardsDb: () => ({
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    }),
  };
});

import { updateDashboard, DashboardConfigInvalidError } from "../mutation-service";
import { ANALYTICS_PORTLET_INSTANCE_ID } from "../v12-envelope";
import { ANALYTICS_PORTLET_KIND, ANALYTICS_PORTLET_VERSION } from "../portlets/kinds";
import type { DashboardActor } from "../permissions";

const USER = "user-1";
const ORG = "org-1";
const ACTOR: DashboardActor = { userId: USER, organizationId: ORG, teamIds: [] };

/** An embedded DC card whose query uses a feature the v1 adapter cannot
 *  execute (`contains` operator) — the pre-gate persisted artifact. */
function violatingCard(id: string, title: string, operator = "contains"): Record<string, unknown> {
  return {
    id,
    title,
    w: 3,
    h: 4,
    x: 0,
    y: 0,
    analysisConfig: {
      version: 1,
      analysisType: "query",
      activeView: "chart",
      charts: { query: { chartType: "bar", chartConfig: {}, displayConfig: {} } },
      query: {
        measures: ["agent_runs.count"],
        filters: [{ member: "agent_runs.status", operator, values: ["x"] }],
      },
    },
  };
}

function envelopeWithCards(cards: unknown[]): Record<string, unknown> {
  return {
    apiVersion: "v1.2",
    scopeLevel: "project",
    portlets: [
      {
        instanceId: ANALYTICS_PORTLET_INSTANCE_ID,
        kind: ANALYTICS_PORTLET_KIND,
        version: ANALYTICS_PORTLET_VERSION,
        slot: "fixed",
        config: {
          dashboard: {
            portlets: cards,
            layoutMode: "grid",
            grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
          },
        },
      },
    ],
  };
}

function rowWith(configJson: unknown): Record<string, unknown> {
  return {
    id: "dash-1",
    name: "Personal",
    description: null,
    isDefault: false,
    isTemplate: false,
    templateScope: null,
    entityType: null,
    entityId: null,
    ownerLevel: "user",
    ownerId: USER,
    organizationId: ORG,
    visibility: "private",
    status: "draft",
    configVersion: "v1.2",
    configJson,
    dashboardVersion: 1,
  };
}

beforeEach(() => {
  state.row = rowWith(envelopeWithCards([violatingCard("legacy-card", "Old widget")]));
  state.updates.length = 0;
  state.audits.length = 0;
});

describe("updateDashboard — feature-gate violations ride the #1913 grandfathering", () => {
  it("an untouched pre-gate violating card re-saves (no net-new errors)", async () => {
    const updated = await updateDashboard(
      "dash-1",
      { config: envelopeWithCards([violatingCard("legacy-card", "Old widget")]) },
      ACTOR,
    );
    expect(state.updates).toHaveLength(1);
    expect(updated.dashboardVersion).toBe(2);
  });

  it("RENAMING the violating card still saves — violation identity is the card id, not the title", async () => {
    await updateDashboard(
      "dash-1",
      { config: envelopeWithCards([violatingCard("legacy-card", "Shiny new name")]) },
      ACTOR,
    );
    expect(state.updates).toHaveLength(1);
  });

  it("removing the violating card always passes", async () => {
    await updateDashboard("dash-1", { config: envelopeWithCards([]) }, ACTOR);
    expect(state.updates).toHaveLength(1);
  });

  it("ADDING a new violating card throws with ONLY the new card's copy", async () => {
    await expect(
      updateDashboard(
        "dash-1",
        {
          config: envelopeWithCards([
            violatingCard("legacy-card", "Old widget"),
            violatingCard("fresh-card", "New widget", "notIn"),
          ]),
        },
        ACTOR,
      ),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(DashboardConfigInvalidError);
      const msg = (e as Error).message;
      expect(msg).toContain("fresh-card");
      expect(msg).toContain('"notIn"');
      // Delta-only: the grandfathered card's violation never reaches the user.
      expect(msg).not.toContain("legacy-card");
      return true;
    });
    expect(state.updates).toHaveLength(0);
  });

  it("a CREATE-equivalent strict path: violating query on a fresh row id throws", async () => {
    state.row = rowWith(envelopeWithCards([]));
    await expect(
      updateDashboard(
        "dash-1",
        { config: envelopeWithCards([violatingCard("brand-new", "N")]) },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(DashboardConfigInvalidError);
    expect(state.updates).toHaveLength(0);
  });
});
