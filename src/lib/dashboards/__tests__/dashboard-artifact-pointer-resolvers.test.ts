// §VIII pointer detail — BEHAVIORAL tests for the session-bound resolver
// (cinatra#1895). Proves the authorization OUTCOMES (not just source presence):
// denied vs not-found vs ok, the fail-closed paths, and — critically — the
// canonical gate ORDER: existence / project-template / liveness are checked
// BEFORE the owner+project access gate, so a dashboard-DENIED template or dead
// row is hidden as `not-found` and NEVER leaked through the not-authorized
// panel (matching the canonical /dashboards/[id] route). The pointer reflects
// the read row.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The session actor builder pulls `auth-session` — mock it to a fixed actor.
vi.mock("@/lib/dashboards/dashboard-actor", () => ({
  buildDashboardActorFromSession: vi.fn(async () => ({
    actor: { userId: "user-me", organizationId: "org-1", teamIds: [] },
    orgId: "org-1",
    userId: "user-me",
  })),
}));

// Keep the REAL DashboardAccessError (for `instanceof`) but drive the gate.
vi.mock("@/lib/dashboards/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dashboards/authz")>();
  return { ...actual, requireDashboardAccess: vi.fn() };
});

// Override the by-id read; keep the REAL isProjectTemplate / isDashboardRowRenderable
// (they evaluate row fields) + the module's other exports.
vi.mock("@cinatra-ai/dashboards/extension-dashboard-reads", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@cinatra-ai/dashboards/extension-dashboard-reads")
    >();
  return { ...actual, readDashboardRowById: vi.fn() };
});

// The liveness oracle: everything live EXCEPT a deliberately-dead package.
vi.mock("@/lib/dashboards/live-extension-oracle", () => ({
  resolveLiveExtensionPredicate: vi.fn(async () => (id: string) => id !== "@x/dead"),
}));

import { requireDashboardAccess, DashboardAccessError } from "@/lib/dashboards/authz";
import { readDashboardRowById } from "@cinatra-ai/dashboards/extension-dashboard-reads";
import { resolveDashboardArtifactPointer } from "@/lib/dashboards/dashboard-artifact-pointer-resolvers";

const gate = vi.mocked(requireDashboardAccess);
const readRow = vi.mocked(readDashboardRowById);

type Row = Record<string, unknown>;
function dashboardRow(overrides: Row): Row {
  return {
    id: "dash-1",
    name: "Pipeline health — Q3",
    ownerLevel: "team",
    ownerId: "team-growth",
    organizationId: "org-1",
    visibility: "members",
    projectId: null,
    updatedAt: new Date("2026-07-20T12:00:00.000Z"),
    entityType: "team",
    entityId: "team-growth",
    extensionId: null,
    status: "published",
    isTemplate: false,
    templateScope: null,
    ...overrides,
  };
}

// Block body (NOT `() => gate.mockReset()`): an arrow that IMPLICITLY RETURNS the
// mock hands vitest a function it treats as a per-test teardown and then CALLS —
// invoking the gate (with its test-set async-throwing impl) at teardown, which
// rejects and spuriously fails the test. Returning undefined keeps reset a reset.
beforeEach(() => {
  gate.mockReset();
  readRow.mockReset();
});

describe("§VIII resolveDashboardArtifactPointer — authorization outcomes", () => {
  it("ok: a live, non-template, ACCESS-granted row → pointer built from the read row", async () => {
    readRow.mockResolvedValue(
      dashboardRow({ id: "dash-1", name: "Authorized name" }) as never,
    );
    gate.mockResolvedValue(undefined as never); // access granted
    const res = await resolveDashboardArtifactPointer("dash-1");
    expect(res.access).toBe("ok");
    if (res.access !== "ok") throw new Error("unreachable");
    expect(res.pointer.name).toBe("Authorized name");
    expect(res.pointer.canonicalHref).toBe("/teams/team-growth/dashboards/dash-1");
    expect(res.pointer.dashboardId).toBe("dash-1");
    // The gate was consulted for READ on the requested id (after existence).
    expect(gate).toHaveBeenCalledWith(expect.anything(), "dash-1", "read");
  });

  it("denied: a LIVE non-template row the gate forbids → not-authorized (may list, not read)", async () => {
    readRow.mockResolvedValue(dashboardRow({}) as never);
    gate.mockImplementation(async () => {
      throw new DashboardAccessError("dashboard_forbidden", "no");
    });
    expect(await resolveDashboardArtifactPointer("dash-1")).toEqual({
      access: "denied",
    });
  });

  it("not-found: an ABSENT row → 404, and the access gate is never consulted", async () => {
    readRow.mockResolvedValue(undefined as never);
    expect(await resolveDashboardArtifactPointer("dash-1")).toEqual({
      access: "not-found",
    });
    expect(gate).not.toHaveBeenCalled();
  });

  it("not-found: a read-race (row deleted between reads) → gate dashboard_not_found → 404", async () => {
    readRow.mockResolvedValue(dashboardRow({}) as never);
    gate.mockImplementation(async () => {
      throw new DashboardAccessError("dashboard_not_found", "gone");
    });
    expect(await resolveDashboardArtifactPointer("dash-1")).toEqual({
      access: "not-found",
    });
  });

  it("not-found: a PROJECT-TEMPLATE row is hidden BEFORE the access gate runs", async () => {
    readRow.mockResolvedValue(
      dashboardRow({ isTemplate: true, templateScope: "project" }) as never,
    );
    expect(await resolveDashboardArtifactPointer("dash-1")).toEqual({
      access: "not-found",
    });
    expect(gate).not.toHaveBeenCalled();
  });

  it("not-found: an ORPHANED extension dashboard is hidden BEFORE the access gate runs", async () => {
    readRow.mockResolvedValue(
      dashboardRow({
        extensionId: "@x/dead",
        ownerLevel: "organization",
        ownerId: "org-1",
      }) as never,
    );
    expect(await resolveDashboardArtifactPointer("dash-1")).toEqual({
      access: "not-found",
    });
    expect(gate).not.toHaveBeenCalled();
  });

  // Regression (Codex round-1): existence-hiding MUST win over access. A template
  // or dead-extension dashboard the actor cannot dashboard-read must 404 (existence
  // hidden), NOT surface the not-authorized panel — matching the canonical
  // /dashboards/[id] route. The access-FIRST order this replaced leaked such a row
  // as `denied` (the panel confirms "a dashboard is here").
  it("not-found: a DENIED project-template row is 404 (existence-hiding precedes access)", async () => {
    readRow.mockResolvedValue(
      dashboardRow({ isTemplate: true, templateScope: "project" }) as never,
    );
    gate.mockImplementation(async () => {
      throw new DashboardAccessError("dashboard_forbidden", "no");
    });
    expect(await resolveDashboardArtifactPointer("dash-1")).toEqual({
      access: "not-found",
    });
    // The gate is never even consulted — the template short-circuits first.
    expect(gate).not.toHaveBeenCalled();
  });

  it("not-found: a DENIED orphaned extension dashboard is 404 (existence-hiding precedes access)", async () => {
    readRow.mockResolvedValue(
      dashboardRow({
        extensionId: "@x/dead",
        ownerLevel: "organization",
        ownerId: "org-1",
      }) as never,
    );
    gate.mockImplementation(async () => {
      throw new DashboardAccessError("dashboard_forbidden", "no");
    });
    expect(await resolveDashboardArtifactPointer("dash-1")).toEqual({
      access: "not-found",
    });
    expect(gate).not.toHaveBeenCalled();
  });

  it("rethrows a non-access gate error (a store failure is NOT a denial)", async () => {
    readRow.mockResolvedValue(dashboardRow({}) as never);
    gate.mockImplementation(async () => {
      throw new Error("db down");
    });
    await expect(resolveDashboardArtifactPointer("dash-1")).rejects.toThrow(
      "db down",
    );
  });

  it("rethrows a read failure (the row read itself failing is NOT a denial)", async () => {
    readRow.mockImplementation(async () => {
      throw new Error("read failed");
    });
    await expect(resolveDashboardArtifactPointer("dash-1")).rejects.toThrow(
      "read failed",
    );
  });
});
