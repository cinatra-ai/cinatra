/**
 * THE DASHBOARD'S OWN READ GATE ON THE ARTIFACT PAGE (cinatra#3092).
 *
 * The page draws every row through its one display dispatch, but a dashboard row
 * keeps the gate chain of the canonical /dashboards/[id] route. The gate and the
 * real resolver run; only the session actor, the dashboard row read, the access
 * check and the liveness oracle are replaced (the seams of
 * `dashboard-artifact-pointer-resolvers.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dashboards/dashboard-actor", () => ({
  buildDashboardActorFromSession: vi.fn(async () => ({
    actor: { userId: "user-me", organizationId: "org-1", teamIds: [] },
    orgId: "org-1",
    userId: "user-me",
  })),
}));
vi.mock("@/lib/dashboards/authz", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/dashboards/authz")>();
  return { ...actual, requireDashboardAccess: vi.fn() };
});
vi.mock("@cinatra-ai/dashboards/extension-dashboard-reads", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@cinatra-ai/dashboards/extension-dashboard-reads")>();
  return { ...actual, readDashboardRowById: vi.fn() };
});
vi.mock("@/lib/dashboards/live-extension-oracle", () => ({
  resolveLiveExtensionPredicate: vi.fn(async () => (id: string) => id !== "@x/dead"),
}));

import { DashboardAccessError, requireDashboardAccess } from "@/lib/dashboards/authz";
import { readDashboardRowById } from "@cinatra-ai/dashboards/extension-dashboard-reads";
import { DASHBOARD_ARTIFACT_OBJECT_TYPE } from "@/lib/dashboards/dashboard-artifact-surface";
import { readArtifactTypeGate } from "../artifact-type-read-gate";

const access = vi.mocked(requireDashboardAccess);
const readRow = vi.mocked(readDashboardRowById);

function dashboardRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dash-1",
    name: "Pipeline health",
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

const DASHBOARD = { artifactId: "dash-1", objectType: DASHBOARD_ARTIFACT_OBJECT_TYPE };

beforeEach(() => {
  access.mockReset();
  readRow.mockReset();
});

describe("readArtifactTypeGate", () => {
  it("a reader the dashboard's owner and project grant refuses is denied", async () => {
    readRow.mockResolvedValue(dashboardRow() as never);
    access.mockRejectedValue(new DashboardAccessError("dashboard_forbidden", "no"));
    await expect(readArtifactTypeGate(DASHBOARD)).resolves.toBe("denied");
    expect(access).toHaveBeenCalledWith(expect.anything(), "dash-1", "read");
  });

  it("a project template is not found, whatever the grant says", async () => {
    readRow.mockResolvedValue(dashboardRow({ isTemplate: true, templateScope: "project" }) as never);
    access.mockRejectedValue(new DashboardAccessError("dashboard_forbidden", "no"));
    await expect(readArtifactTypeGate(DASHBOARD)).resolves.toBe("not-found");
  });

  it("an orphaned extension dashboard is not found", async () => {
    readRow.mockResolvedValue(dashboardRow({ extensionId: "@x/dead" }) as never);
    access.mockResolvedValue(undefined as never);
    await expect(readArtifactTypeGate(DASHBOARD)).resolves.toBe("not-found");
  });

  it("an archived extension dashboard is not found", async () => {
    readRow.mockResolvedValue(dashboardRow({ extensionId: "@x/live", status: "archived" }) as never);
    access.mockResolvedValue(undefined as never);
    await expect(readArtifactTypeGate(DASHBOARD)).resolves.toBe("not-found");
  });

  it("an absent dashboard row is not found", async () => {
    readRow.mockResolvedValue(null as never);
    await expect(readArtifactTypeGate(DASHBOARD)).resolves.toBe("not-found");
  });

  it("a live dashboard the grant admits is ok", async () => {
    readRow.mockResolvedValue(dashboardRow() as never);
    access.mockResolvedValue(undefined as never);
    await expect(readArtifactTypeGate(DASHBOARD)).resolves.toBe("ok");
  });

  it("a store failure rejects, so the page draws nothing", async () => {
    readRow.mockRejectedValue(new Error("store down"));
    await expect(readArtifactTypeGate(DASHBOARD)).rejects.toThrow("store down");
  });

  it("a row of another type is ok and never reads a dashboard", async () => {
    await expect(readArtifactTypeGate({ artifactId: "a-1", objectType: "acme.note" })).resolves.toBe("ok");
    await expect(readArtifactTypeGate({ artifactId: "a-2", objectType: null })).resolves.toBe("ok");
    expect(readRow).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
  });
});
