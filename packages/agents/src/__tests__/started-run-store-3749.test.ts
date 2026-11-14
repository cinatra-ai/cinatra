import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const seam = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, where: vi.fn(), order: vi.fn(), select: vi.fn() }));
vi.mock("../db", () => ({ db: { select: (...args: unknown[]) => {
  seam.select(...args);return { from: () => ({ where: (clause: unknown) => {
    seam.where(clause);return { limit: async () => seam.rows, orderBy: (...order: unknown[]) => { seam.order(...order);return Promise.resolve(seam.rows); } };
  } }) };
} } }));
import { assertStarterRun, readStartedRunsFor } from "../started-run-store";
const dialect = new PgDialect();
beforeEach(() => { vi.clearAllMocks(); seam.rows = []; });
describe("starter record storage uses its own tenant-fenced relationship", () => {
  it("validates a real same-org starter and refuses an absent/foreign starter", async () => {
    await expect(assertStarterRun({ id: "child", orgId: "org", startedByRunId: "curator" })).rejects.toThrow(/absent from this organization/);
    const actual = dialect.sqlToQuery(seam.where.mock.calls[0][0]);
    expect(actual.sql).toContain('"id"');expect(actual.sql).toContain('"org_id"');
    expect(actual.params).toEqual(["curator", "org"]);
    seam.rows = [{ id: "curator" }];
    await expect(assertStarterRun({ id: "child", orgId: "org", startedByRunId: "curator" })).resolves.toBeUndefined();
  });
  it.each(["child", "", " padded"])("rejects invalid/self starter %j before any query", async startedByRunId => {
    await expect(assertStarterRun({ id: "child", orgId: "org", startedByRunId })).rejects.toThrow(/invalid/);
    expect(seam.select).not.toHaveBeenCalled();
  });
  it("ordinary run creation needs no starter probe", async () => {
    await assertStarterRun({ id: "child", orgId: "org" });
    expect(seam.select).not.toHaveBeenCalled();
  });
  it("lists by started-by plus org, never the orchestrator-parent column, in stable request order", async () => {
    expect(await readStartedRunsFor({ id: "curator", orgId: "org" })).toEqual([]);
    const actual = dialect.sqlToQuery(seam.where.mock.calls[0][0]);
    expect(actual.sql).toContain('"started_by_run_id"');expect(actual.sql).not.toContain("parent_run_id");
    expect(actual.params).toEqual(["curator", "org"]);
    expect(seam.order).toHaveBeenCalledTimes(1);expect(seam.order.mock.calls[0]).toHaveLength(2);
  });
});
