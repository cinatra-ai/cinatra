import { beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type SQL, type AnyColumn } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildRunStepRail } from "../run-step-rail";

// Only database transport is replaced. Actual store predicates/order clauses
// and the actual rail election run below. This narrow read-only SQL port
// refuses unsupported expressions; PostgreSQL/DDL has a companion test.
type Row = Record<string, unknown>;
const data = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, reads: [] as string[] }));
const dialect = new PgDialect();
function rendered(expression: SQL | AnyColumn): string {
  const query = dialect.sqlToQuery(sql`${expression}`);
  return query.sql.replace(/\$(\d+)/g, (_, n: string) => JSON.stringify(query.params[Number(n) - 1]));
}
function field(expression: string, row: Row): unknown {
  const value = expression.trim();
  const column = /^"[^"]+"\."[^"]+"\."([^"]+)"$/.exec(value);
  if (column) return row[column[1]];
  if (value === "null") return null;
  if (/^\d+$/.test(value)) return Number(value);
  throw new Error(`Unsupported expression: ${value}`);
}
function matches(condition: string, row: Row): boolean {
  return condition.replace(/^\(|\)$/g, "").split(" and ").every(part => {
    const equal = /^(.+) = ("[^"]+")$/.exec(part);
    if (equal) return field(equal[1], row) === JSON.parse(equal[2]);
    const notNull = /^(.+) is not null$/.exec(part);
    if (notNull) return field(notNull[1], row) != null;
    const inside = /^(.+) in \((.+)\)$/.exec(part);
    if (inside) return JSON.parse(`[${inside[2]}]`).includes(field(inside[1], row));
    throw new Error(`Unsupported predicate: ${part}`);
  });
}
const executor = {
  select(columns?: Record<string, AnyColumn>) {
    let effectiveColumns = columns;
    let table = ""; let condition: SQL | undefined; let ordering: Array<SQL | AnyColumn> = [];
    const read = (cap?: number) => {
      data.reads.push(table);
      const rows = (data.tables[table] ?? []).filter(row => !condition || matches(rendered(condition), row));
      rows.sort((a, b) => {
        for (const item of ordering) {
          const encoded = rendered(item); const descending = / desc$/i.test(encoded);
          const expression = encoded.replace(/ (asc|desc)$/i, "");
          const left = field(expression, a), right = field(expression, b);
          let comparison = 0;
          if (left == null || right == null) comparison = left == null ? (right == null ? 0 : 1) : -1;
          else if (typeof left === "number" && typeof right === "number") comparison = left - right;
          else comparison = String(left).localeCompare(String(right));
          if (comparison) return descending ? -comparison : comparison;
        }
        return 0;
      });
      return rows.slice(0, cap).map(row => effectiveColumns
        ? Object.fromEntries(Object.entries(effectiveColumns).map(([key, column]) => [key, row[column.name]])) : row);
    };
    const chain = {
      from(tableObject: { [key: symbol]: unknown }) {
        table = String(tableObject[Symbol.for("drizzle:Name")]);
        if (!columns) effectiveColumns = Object.fromEntries(Object.entries(tableObject).filter((entry): entry is [string, AnyColumn] => Boolean(entry[1]) && typeof (entry[1] as AnyColumn).name === "string"));
        return chain;
      },
      where(value: SQL) { condition = value; return chain; },
      orderBy(...values: Array<SQL | AnyColumn>) { ordering = values; return chain; },
      async limit(cap: number) { return read(cap); },
      then(resolve: (value: Row[]) => unknown, reject?: (error: unknown) => unknown) {
        return Promise.resolve(read()).then(resolve, reject);
      },
    };
    return chain;
  },
};
vi.mock("../db", () => ({ db: { select: (...args: Parameters<typeof executor.select>) => executor.select(...args) }, agentBuilderPool: {} }));
vi.mock("../store", () => ({ readAgentRunById: vi.fn(), readAgentTemplateById: vi.fn(), readRunCoOwners: vi.fn() }));
vi.mock("../run-transition", () => ({ transitionRunStatus: () => { throw new Error("Read-only slot test cannot transition a run"); } }));
vi.mock("../auth-policy", () => ({ enforceRunAccess: () => { throw new Error("Unexpected access mutation"); }, resolveEffectivePolicy: () => { throw new Error("Unexpected policy read"); } }));
import { listReviewGatesForRun, readRunReviewSlot } from "../artifact-review-gate-store";

function gate(task: string, time: number, status: "pending" | "resolved" = "pending", run = "run"): Row {
  return { id: `id-${task}`, run_id: run, org_id: "org", review_task_id: task, created_at: time, status,
    pinned_targets: [{ artifactId: task, representationRevisionId: "revision" }], disposition: status === "resolved" ? "approve" : null };
}
function seed(parked = false) {
  data.tables.agent_runs = [{ id: "run", status: parked ? "pending_approval" : "completed", step_results: parked
    ? [{ lifecycle_review_withheld_terminal: { status: "completed", output: {} } }] : [] }];
}
function link(...tasks: string[]) {
  data.tables.artifact_produced_outbox = tasks.map(task => ({ event_id: `event-${task}`, producer_run_id: "run", status: "processed", continuation_address: `id-${task}` }));
}
async function activeRailTask(): Promise<string | null> {
  const gates = await listReviewGatesForRun("run");
  const rail = buildRunStepRail({ gates: gates.map(g => ({ gateId: g.id, reviewTaskId: g.reviewTaskId, status: g.status, disposition: g.disposition, createdAt: g.createdAt })) });
  return rail.entries.find(entry => entry.ordinal === rail.activeOrdinal)?.gate?.reviewTaskId ?? null;
}
beforeEach(() => { data.tables = { artifact_review_gates: [], artifact_produced_outbox: [], agent_runs: [] }; data.reads = []; seed(); });

describe("detail and rail elect the first pending review in raise order", () => {
  it.each([false, true])("advances through three persisted decisions, parked=%s", async parked => {
    seed(parked);
    data.tables.artifact_review_gates = [gate("third", 3), gate("first", 1), gate("second", 2), gate("foreign", 0, "pending", "other-run")];
    if (parked) link("first", "second", "third");
    for (const expected of ["first", "second", "third"]) {
      expect(await activeRailTask()).toBe(expected);
      expect(await readRunReviewSlot("run")).toEqual({ reviewTaskId: expected, awaiting: false, parkedOnProducedReview: parked });
      // Persisted decision state: the real CAS/decision transaction itself is
      // separately exercised against PostgreSQL by the integration suite.
      data.tables.artifact_review_gates.find(row => row.review_task_id === expected)!.status = "resolved";
    }
    expect(await activeRailTask()).toBeNull();
    expect((await readRunReviewSlot("run")).reviewTaskId).toBe("third");
  });
  it.each([false, true].flatMap(parked => [[parked, ["z-task", "a-task"]], [parked, ["task-Z", "task-a", "task-A"]], [parked, ["task_2", "task#2", "task.1", "task-1"]]] as const))("matches the rail task-key tie order, parked=%s keys=%j", async (parked, tasks) => {
    seed(parked); data.tables.artifact_review_gates = tasks.map(task => gate(task, 5));
    if (parked) link(...tasks);
    const first = [...tasks].sort((a, b) => a.localeCompare(b))[0];
    expect(await activeRailTask()).toBe(first);
    expect((await readRunReviewSlot("run")).reviewTaskId).toBe(first);
  });
  it.each([false, true])("pending wins over a newer settled review, parked=%s", async parked => {
    seed(parked); data.tables.artifact_review_gates = [gate("old-pending", 1), gate("new-resolved", 9, "resolved")];
    if (parked) link("old-pending", "new-resolved");
    expect((await readRunReviewSlot("run")).reviewTaskId).toBe("old-pending");
  });
  it("retains the latest decided review and old id tie for a finished run", async () => {
    data.tables.artifact_review_gates = [gate("old", 1, "resolved"), gate("a", 9, "resolved"), gate("z", 9, "resolved")];
    expect((await readRunReviewSlot("run")).reviewTaskId).toBe("z");
  });
  it("keeps outbox-first awaiting without substituting an unlinked gate", async () => {
    seed(true); data.tables.artifact_review_gates = [gate("unlinked", 0), gate("old", 1, "resolved")]; link("old");
    data.tables.artifact_produced_outbox.push({ event_id: "waiting", producer_run_id: "run", status: "pending", continuation_address: null });
    expect(await readRunReviewSlot("run")).toEqual({ reviewTaskId: null, awaiting: true, parkedOnProducedReview: true });
    expect(data.reads[0]).toBe("artifact_produced_outbox");
  });
  it("retains the latest linked settled gate before release", async () => {
    seed(true); data.tables.artifact_review_gates = [gate("linked-old", 1, "resolved"), gate("linked-new", 9, "resolved"), gate("unlinked", 10)]; link("linked-old", "linked-new");
    expect((await readRunReviewSlot("run")).reviewTaskId).toBe("linked-new");
  });
  it.each([false, true])("no owned gate remains an empty slot, parked=%s", async parked => {
    seed(parked); data.tables.artifact_review_gates = [gate("foreign", 1, "pending", "other-run")];
    expect(await readRunReviewSlot("run")).toEqual({ reviewTaskId: null, awaiting: false, parkedOnProducedReview: parked });
  });
});
