/**
 * THE DASHBOARD'S OWN READ GATE ON THE ARTIFACT PAGE (cinatra#3092).
 *
 * No type-specific branch stands before the page's one display dispatch, but a
 * dashboard row keeps the gate chain of the canonical /dashboards/[id] route.
 * The gate and the real resolver run; only the session actor, the dashboard row
 * read, the access check and the liveness oracle are replaced (the seams of
 * `dashboard-artifact-pointer-resolvers.test.ts`). The resolver is wrapped in a
 * spy that calls the real one, so the last block can hand the gate an answer the
 * resolver's type does not allow.
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
vi.mock("@/lib/dashboards/dashboard-artifact-pointer-resolvers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/dashboards/dashboard-artifact-pointer-resolvers")>();
  return { ...actual, resolveDashboardArtifactPointer: vi.fn(actual.resolveDashboardArtifactPointer) };
});

import { DashboardAccessError, requireDashboardAccess } from "@/lib/dashboards/authz";
import { readDashboardRowById } from "@cinatra-ai/dashboards/extension-dashboard-reads";
import { DASHBOARD_ARTIFACT_OBJECT_TYPE } from "@/lib/dashboards/dashboard-artifact-surface";
import { resolveDashboardArtifactPointer } from "@/lib/dashboards/dashboard-artifact-pointer-resolvers";
import { readArtifactTypeGate } from "../artifact-type-read-gate";

const access = vi.mocked(requireDashboardAccess);
const readRow = vi.mocked(readDashboardRowById);
const resolver = vi.mocked(resolveDashboardArtifactPointer);

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
    await expect(readArtifactTypeGate(DASHBOARD)).resolves.toEqual({ access: "denied" });
    expect(access).toHaveBeenCalledWith(expect.anything(), "dash-1", "read");
  });

  it("a project template is not found, whatever the grant says", async () => {
    readRow.mockResolvedValue(dashboardRow({ isTemplate: true, templateScope: "project" }) as never);
    access.mockRejectedValue(new DashboardAccessError("dashboard_forbidden", "no"));
    await expect(readArtifactTypeGate(DASHBOARD)).resolves.toEqual({ access: "not-found" });
  });

  it("an orphaned extension dashboard is not found", async () => {
    readRow.mockResolvedValue(dashboardRow({ extensionId: "@x/dead" }) as never);
    access.mockResolvedValue(undefined as never);
    await expect(readArtifactTypeGate(DASHBOARD)).resolves.toEqual({ access: "not-found" });
  });

  it("an archived extension dashboard is not found", async () => {
    readRow.mockResolvedValue(dashboardRow({ extensionId: "@x/live", status: "archived" }) as never);
    access.mockResolvedValue(undefined as never);
    await expect(readArtifactTypeGate(DASHBOARD)).resolves.toEqual({ access: "not-found" });
  });

  it("an absent dashboard row is not found", async () => {
    readRow.mockResolvedValue(null as never);
    await expect(readArtifactTypeGate(DASHBOARD)).resolves.toEqual({ access: "not-found" });
  });

  it("a live dashboard the grant admits is ok and carries its pointer", async () => {
    readRow.mockResolvedValue(dashboardRow() as never);
    access.mockResolvedValue(undefined as never);
    await expect(readArtifactTypeGate(DASHBOARD)).resolves.toEqual({
      access: "ok",
      dashboardPointer: expect.objectContaining({ dashboardId: "dash-1", name: "Pipeline health" }),
    });
  });

  it("a store failure rejects, so the page draws no artifact display", async () => {
    readRow.mockRejectedValue(new Error("store down"));
    await expect(readArtifactTypeGate(DASHBOARD)).rejects.toThrow("store down");
  });

  it("a row of another type is ok and never reads a dashboard", async () => {
    const ok = { access: "ok", dashboardPointer: null };
    await expect(readArtifactTypeGate({ artifactId: "a-1", objectType: "acme.note" })).resolves.toEqual(ok);
    await expect(readArtifactTypeGate({ artifactId: "a-2", objectType: null })).resolves.toEqual(ok);
    expect(readRow).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
  });
});

describe("readArtifactTypeGate refuses an answer it does not know (fails closed)", () => {
  // Anything but ok-with-a-pointer, not-found and denied: the page must never
  // read it as ok, so the gate throws to the route's error boundary.
  it.each([
    ["an unknown access word", { access: "timeout" }],
    ["an undefined access", { access: undefined }],
    ["no access key", {}],
    ["ok without a pointer", { access: "ok" }],
    ["ok with a null pointer", { access: "ok", pointer: null }],
    ["a bare access word", "ok"],
    ["null", null],
    ["undefined", undefined],
  ])("%s rejects with the gate's own error, whose message names no value", async (_label, answer) => {
    resolver.mockResolvedValueOnce(answer as never);
    const result = readArtifactTypeGate(DASHBOARD);
    await expect(result).rejects.toMatchObject({ name: "ArtifactTypeReadGateError" });
    await expect(result).rejects.toThrow("the dashboard read gate answered no known access");
  });

  // An answer whose own property read throws is no known answer either: the
  // gate throws its own error, never the thrower's (which can carry a value).
  const throwing = (key: string, rest: Record<string, unknown>) =>
    Object.defineProperty({ ...rest }, key, {
      enumerable: true,
      get() {
        throw new Error("private value");
      },
    });
  it.each([
    ["an access getter that throws", throwing("access", {})],
    ["a pointer getter that throws", throwing("pointer", { access: "ok" })],
    [
      // `then` is left readable: a throwing `then` makes the resolver's own
      // promise reject, which is the store-failure road, not an answer.
      "a proxy whose traps throw",
      new Proxy(
        {},
        {
          get(_target, key) {
            if (key === "then") return undefined;
            throw new Error("private value");
          },
          has() {
            throw new Error("private value");
          },
        },
      ),
    ],
  ])("%s rejects with the gate's own error, never the thrown one", async (_label, answer) => {
    resolver.mockResolvedValueOnce(answer as never);
    const result = readArtifactTypeGate(DASHBOARD);
    await expect(result).rejects.toMatchObject({ name: "ArtifactTypeReadGateError" });
    await expect(result).rejects.toThrow("the dashboard read gate answered no known access");
    await expect(result).rejects.not.toThrow("private value");
  });
});
