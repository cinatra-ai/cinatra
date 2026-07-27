// cinatra#1913 — "no NET NEW validator errors" grandfathering on the UPDATE
// path. A dashboard that already persists an invalid card (the pre-#1512
// "Demo" artifact) must stay EDITABLE: a save that carries the legacy card
// through unchanged (or removes it) succeeds; a save that would grow the
// error multiset throws with ONLY the delta errors (the #1512 copy for
// exactly the cards the user touched/added — never the legacy card's).

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  updates: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("../store/db", async () => {
  // Kernel test fakes (cinatra#1939 S3 — updateDashboard runs under the
  // org-write kernel guard): answer the guard's own queries (org locks,
  // lifecycle read → active org), pass the writer's statements through.
  const { wrapTxWithOrgWriteKernel } = await import(
    "@cinatra-ai/org-write-kernel/testing"
  );
  const tx = wrapTxWithOrgWriteKernel(
    {
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
      // Backs the writer's advisory-lock statement (cinatra#1894 B1b): a
      // DB-concurrency no-op with no observable effect in this mock.
      execute: async () => ({ rows: [] }),
    },
    { organization: { archivedAt: null } },
  );
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
import type { DashboardActor } from "../permissions";

const USER = "user-1";
const ORG = "org-1";
const ACTOR: DashboardActor = {
  userId: USER,
  organizationId: ORG,
  teamIds: [],
  // cinatra#1939 S3 — updateDashboard runs under the org-write kernel guard.
  authority: { orgId: ORG, can: (c) => c === "content.write" },
};

/** A portlet whose kind is unknown to the real registry — its deterministic
 *  validator error string stands in for the legacy cross-cube "Demo" card. */
function badPortlet(instanceId: string, kind = "legacy-bad"): Record<string, unknown> {
  return { instanceId, kind, version: "1.0.0", slot: "fixed", config: {} };
}

function envelope(portlets: unknown[]): Record<string, unknown> {
  return { apiVersion: "v1.2", scopeLevel: "project", portlets };
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
  state.row = rowWith(envelope([badPortlet("demo")]));
  state.updates.length = 0;
  state.audits.length = 0;
});

describe("updateDashboard — legacy invalid card no longer freezes the dashboard (cinatra#1913)", () => {
  it("REGRESSION PIN (AC5): saving a config that carries the untouched legacy card persists", async () => {
    const updated = await updateDashboard(
      "dash-1",
      { config: envelope([badPortlet("demo")]) },
      ACTOR,
    );
    expect(state.updates).toHaveLength(1);
    expect(updated.dashboardVersion).toBe(2);
    // The audit trail records the write like any other update.
    expect(state.audits.some((a) => a.operation === "dashboards.update")).toBe(true);
  });

  it("removing the legacy card is the escape hatch — fewer errors always passes", async () => {
    await updateDashboard("dash-1", { config: envelope([]) }, ACTOR);
    expect(state.updates).toHaveLength(1);
  });

  it("adding a NEW invalid card throws with ONLY the delta error — the legacy card's copy is absent", async () => {
    await expect(
      updateDashboard(
        "dash-1",
        { config: envelope([badPortlet("demo"), badPortlet("fresh", "also-bad")]) },
        ACTOR,
      ),
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(DashboardConfigInvalidError);
      const msg = (e as Error).message;
      expect(msg).toContain('"fresh"');
      expect(msg).toContain("also-bad");
      // Delta-only: the grandfathered card's error never reaches the user.
      expect(msg).not.toContain('"demo"');
      expect(msg).not.toContain("legacy-bad");
      return true;
    });
    expect(state.updates).toHaveLength(0);
  });

  it("editing the legacy card into a DIFFERENT violation is a net-new error and throws", async () => {
    // Same instanceId, new unknown kind — its error string changes, so it no
    // longer matches the stored row's error and is NOT grandfathered.
    await expect(
      updateDashboard(
        "dash-1",
        { config: envelope([badPortlet("demo", "worse-bad")]) },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(DashboardConfigInvalidError);
    expect(state.updates).toHaveLength(0);
  });

  it("STRUCTURAL grandfathering: a row with a schema-broken portlet re-saves unchanged, but a second broken portlet is net-new", async () => {
    // Missing required fields → zod-level errors (not graph-level).
    const broken = { instanceId: "old-broken", kind: "legacy-bad" }; // no version/slot
    state.row = rowWith(envelope([broken]));
    await updateDashboard("dash-1", { config: envelope([broken]) }, ACTOR);
    expect(state.updates).toHaveLength(1);

    state.updates.length = 0;
    const broken2 = { instanceId: "new-broken", kind: "also-bad" };
    await expect(
      updateDashboard("dash-1", { config: envelope([broken, broken2]) }, ACTOR),
    ).rejects.toBeInstanceOf(DashboardConfigInvalidError);
    expect(state.updates).toHaveLength(0);
  });

  it("POSITION-INDEPENDENT grandfathering: reordering/removing cards AHEAD of a schema-broken card does not re-freeze", async () => {
    // Zod schema errors embed the ARRAY INDEX (`portlets.1.version: …`), not
    // the instanceId — a save that only MOVES the broken card must not turn
    // the index-shifted strings into "net new" errors (#1931 review finding).
    const broken = { instanceId: "old-broken", kind: "legacy-bad" }; // no version/slot
    const mover = badPortlet("mover"); // structurally valid; unknown kind
    state.row = rowWith(envelope([mover, broken]));

    // Pure reorder: same cards, broken shifts index 1 → 0.
    await updateDashboard("dash-1", { config: envelope([broken, mover]) }, ACTOR);
    expect(state.updates).toHaveLength(1);

    // Removing the card ahead of it (index shift by deletion) also passes.
    state.updates.length = 0;
    await updateDashboard("dash-1", { config: envelope([broken]) }, ACTOR);
    expect(state.updates).toHaveLength(1);
  });

  it("position-independence does NOT weaken growth detection: a shifted same-shape duplicate still throws", async () => {
    const broken = { instanceId: "old-broken", kind: "legacy-bad" };
    state.row = rowWith(envelope([broken]));
    // Same missing fields, inserted AHEAD — normalized counts grow 1 → 2.
    const broken2 = { instanceId: "new-broken", kind: "also-bad" };
    await expect(
      updateDashboard("dash-1", { config: envelope([broken2, broken]) }, ACTOR),
    ).rejects.toBeInstanceOf(DashboardConfigInvalidError);
    expect(state.updates).toHaveLength(0);
  });

  it("a VALID save on a valid row stays strict end-to-end (no behavior change)", async () => {
    state.row = rowWith(envelope([]));
    await updateDashboard("dash-1", { config: envelope([]) }, ACTOR);
    expect(state.updates).toHaveLength(1);

    state.updates.length = 0;
    await expect(
      updateDashboard("dash-1", { config: envelope([badPortlet("nope")]) }, ACTOR),
    ).rejects.toBeInstanceOf(DashboardConfigInvalidError);
    expect(state.updates).toHaveLength(0);
  });
});
