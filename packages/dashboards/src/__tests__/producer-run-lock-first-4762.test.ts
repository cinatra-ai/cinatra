// cinatra#4762 — a content writer whose actor carries a run (create, update,
// publish) takes the producing run's row BEFORE its first dashboards write, not
// only inside the twin, which runs after the dashboards row and its audit row.
// A Publish reads its review fence under the same row FOR UPDATE; with the lock
// first, that read runs before the writer's first write or sees its event.
//
// Drives the REAL writers against a fake dashboards transaction that logs every
// statement in order, with a recording producing-run lock registered in the
// seam, and reads where the lock falls.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  log: [] as string[],
  lockedRow: null as Record<string, unknown> | null,
  kernelAnswers: {
    organization: { archivedAt: null } as { archivedAt: string | null } | null,
  },
}));

vi.mock("../store/db", async () => {
  const { wrapTxWithOrgWriteKernel } = await import("@cinatra-ai/org-write-kernel/testing");
  const insert = () => ({
    values: (v: Record<string, unknown>) => {
      state.log.push("insert");
      const now = new Date();
      const row = { createdAt: now, updatedAt: now, ...v };
      const p = Promise.resolve([row]);
      return Object.assign(p, { returning: async () => [row] });
    },
  });
  const update = () => ({
    set: (v: Record<string, unknown>) => ({
      where: () => {
        state.log.push("update");
        const row = { ...state.lockedRow, ...v };
        const p = Promise.resolve([row]);
        return Object.assign(p, { returning: async () => [row] });
      },
    }),
  });
  // `select()` (the row lock) answers the locked row; the tenancy pre-read its
  // org; any other projection (the revision max) answers no rows.
  const select = (fields?: Record<string, unknown>) => {
    const rows =
      fields === undefined
        ? state.lockedRow
          ? [state.lockedRow]
          : []
        : Object.keys(fields).length === 1 && "organizationId" in fields
          ? state.lockedRow
            ? [{ organizationId: state.lockedRow.organizationId }]
            : []
          : [];
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "for", "limit"]) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej);
    return chain;
  };
  const del = () => ({ where: async () => undefined });
  const tx = wrapTxWithOrgWriteKernel(
    {
      insert,
      update,
      select,
      delete: del,
      execute: async () => {
        state.log.push("execute");
        return { rows: [] };
      },
    },
    state.kernelAnswers,
  );
  return {
    auditEvents: {},
    dashboardEntityLinks: {},
    dashboardRevisions: {},
    dashboards: {},
    getDashboardsDb: () => ({
      select,
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    }),
  };
});

import { createDashboard, publishDashboard, updateDashboard } from "../mutation-service";
import type { DashboardActor } from "../permissions";
import * as seam from "../twin-writer-seam";

const ORG = "org-1";
const TEAM = "team-1";
const RUN = "run-9";

const personActor: DashboardActor = {
  userId: "user-1",
  organizationId: ORG,
  teamIds: [TEAM],
  orgRole: "admin",
  teamRoles: { [TEAM]: "admin" },
  authority: { orgId: ORG, can: (c) => c === "content.write" },
};
const runActor: DashboardActor = { ...personActor, runId: RUN };

const DC = {
  portlets: [] as unknown[],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

const ROW = {
  id: "dash-1",
  name: "Run board",
  description: null,
  configJson: { apiVersion: "1.2", scopeLevel: "team", ...DC },
  configVersion: "1.2",
  dashboardVersion: 1,
  publishedRevisionNumber: null,
  ownerLevel: "team",
  ownerId: TEAM,
  organizationId: ORG,
  status: "draft",
  createdBy: "user-1",
  updatedBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  publishedAt: null,
  archivedAt: null,
  projectId: null,
  extensionId: null,
  isTemplate: false,
  templateScope: null,
  entityType: null,
  entityId: null,
  isDefault: false,
  contributionId: null,
  appliedContributionVersion: null,
  appliedDefaultJson: null,
  appliedDefaultHash: null,
  archiveReason: null,
};

const recordingLock = async (_tx: unknown, producerRunId: string): Promise<void> => {
  state.log.push(`run-lock:${producerRunId}`);
};
const recordingTwin = async (): Promise<void> => {
  state.log.push("twin");
};

beforeEach(() => {
  state.log = [];
  state.lockedRow = ROW;
  state.kernelAnswers.organization = { archivedAt: null };
  seam.resetDashboardArtifactTwinWriter();
  seam.setDashboardArtifactTwinWriter(recordingTwin);
  // Optional call: before the lock existed this registered nothing.
  (seam as { setDashboardTwinProducerRunLock?: (l: typeof recordingLock) => void }).setDashboardTwinProducerRunLock?.(recordingLock);
});

afterAll(() => {
  seam.resetDashboardArtifactTwinWriter();
  (seam as { resetDashboardTwinProducerRunLock?: () => void }).resetDashboardTwinProducerRunLock?.();
  vi.doUnmock("../store/db");
  vi.resetModules();
  vi.restoreAllMocks();
});

/** The statements before the writer's first insert or update. */
function beforeFirstWrite(): string[] {
  const first = state.log.findIndex((s) => s === "insert" || s === "update");
  return state.log.slice(0, first === -1 ? state.log.length : first);
}

describe("a run's content writer takes the producing run's row before its first write (cinatra#4762)", () => {
  it("create, update and publish lock the run once, after the advisory lock and before any insert or update", async () => {
    const outcomes: Array<{ writer: string; before: string[] }> = [];
    await createDashboard({ name: "Run board", config: DC, ownerLevel: "team", ownerId: TEAM }, runActor);
    outcomes.push({ writer: "create", before: beforeFirstWrite().filter((s) => s.startsWith("run-lock")) });
    state.log = [];
    await updateDashboard("dash-1", { name: "Renamed" }, runActor);
    outcomes.push({ writer: "update", before: beforeFirstWrite().filter((s) => s.startsWith("run-lock")) });
    state.log = [];
    await publishDashboard("dash-1", runActor);
    outcomes.push({ writer: "publish", before: beforeFirstWrite().filter((s) => s.startsWith("run-lock")) });
    expect(outcomes).toEqual([
      { writer: "create", before: [`run-lock:${RUN}`] },
      { writer: "update", before: [`run-lock:${RUN}`] },
      { writer: "publish", before: [`run-lock:${RUN}`] },
    ]);
    // The lock follows the writer's advisory lock (the twin's own order) and precedes the twin.
    const lockAt = state.log.indexOf(`run-lock:${RUN}`);
    expect(state.log[lockAt - 1]).toBe("execute");
    expect(lockAt).toBeLessThan(state.log.indexOf("twin"));
  });

  it("a person's write (no run) takes no run lock", async () => {
    await createDashboard({ name: "Person board", config: DC, ownerLevel: "team", ownerId: TEAM }, personActor);
    await updateDashboard("dash-1", { name: "Renamed" }, personActor);
    await publishDashboard("dash-1", personActor);
    expect(state.log.some((s) => s.startsWith("run-lock"))).toBe(false);
    expect(state.log.filter((s) => s === "twin")).toHaveLength(3);
  });
});
