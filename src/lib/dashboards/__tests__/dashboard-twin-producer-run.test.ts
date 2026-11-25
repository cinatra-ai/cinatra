// cinatra#3092 (finding A2) — the HOST twin records a dashboard's producing
// run. DB-FREE, in the shape of dashboard-artifact-twin-writer.test.ts.
//
// (a) the pure builder: a validated run is the produced event's
//     `producer_run_id`, makes the origin agent-produced, and is the
//     revision's `created_by_run_id`; without one every op is unchanged.
// (b) the writer: the context's run id is trusted only when `agent_runs` holds
//     it in THIS organization (read on the same transaction); a missing or
//     cross-organization run reads as no run; no run id ⇒ no read.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("@/lib/postgres-sync", () => ({ runPostgresQueriesSync: vi.fn() }));
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: vi.fn() }));
vi.mock("@/lib/postgres-config", () => ({
  postgresSchema: "cinatra",
  getPostgresConnectionString: () => "postgres://test",
}));

import { rawWithParams } from "@/lib/dashboards/raw-with-params";
import {
  buildDashboardTwinQueries,
  dashboardArtifactTwinWriter,
  readSameOrgProducerRunId,
} from "@/lib/dashboards/dashboard-artifact-twin-writer";
import { LIFECYCLE_REVIEW_ORCHESTRATION_ENV } from "@/lib/lifecycle/lifecycle-activation";
import type { DashboardTwinContext, TwinTx } from "@cinatra-ai/dashboards/twin-writer-seam";

const dialect = new PgDialect();

function render(text: string, values: readonly unknown[]): { sql: string; params: unknown[] } {
  const { sql, params } = dialect.sqlToQuery(rawWithParams(text, values));
  return { sql, params };
}

const ctx: DashboardTwinContext = {
  operation: "upsert",
  dashboardId: "dash-1",
  orgId: "org-1",
  ownerLevel: "team",
  ownerId: "team-9",
  projectId: null,
  actorId: "user-7",
};
const pinnedCtx: DashboardTwinContext = { ...ctx, configuration: { apiVersion: "1.2", portlets: [] } };
const runCtx: DashboardTwinContext = { ...ctx, producerRunId: "run-1" };

type Op = { text: string; values: readonly unknown[] };
const producedOp = (ops: Op[]): Op => {
  const op = ops.find((q) => q.text.includes('"artifact_produced_outbox"'));
  if (!op) throw new Error("no produced-event op");
  return op;
};
const representationOp = (ops: Op[]): Op => {
  const op = ops.find((q) => q.text.includes('INSERT INTO "cinatra"."representation"'));
  if (!op) throw new Error("no representation op");
  return op;
};

let savedSwitch: string | undefined;
beforeEach(() => {
  // The review orchestration is DEFAULT-ON; make sure no opt-out leaks in.
  savedSwitch = process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
});
afterEach(() => {
  if (savedSwitch === undefined) delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  else process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = savedSwitch;
});

describe("(a) the builder records a validated producing run (cinatra#3092)", () => {
  it("the produced event names the run and is agent-produced", () => {
    const op = producedOp(buildDashboardTwinQueries(ctx, "run-1"));
    expect(op.values[6]).toBe("run-1"); // producer_run_id
    expect(op.values[8]).toBe("agent_produced"); // origin_kind (lattice)
  });

  it("without a run the produced event is a person's upload, as before", () => {
    const op = producedOp(buildDashboardTwinQueries(ctx));
    expect(op.values[6]).toBeNull();
    expect(op.values[8]).toBe("user_provided");
  });

  it("the raw context run id is never used by the builder (only the validated argument)", () => {
    const op = producedOp(buildDashboardTwinQueries(runCtx));
    expect(op.values[6]).toBeNull();
    expect(op.values[8]).toBe("user_provided");
  });

  it("the revision's created_by_run_id is the run, with and without a pinned configuration", () => {
    for (const c of [ctx, pinnedCtx]) {
      const op = representationOp(buildDashboardTwinQueries(c, "run-1"));
      const { sql, params } = render(op.text, op.values);
      expect(params).toContain("run-1");
      const runIdx = params.indexOf("run-1") + 1;
      // created_by_run_id is the column after created_by ($5).
      expect(sql).toMatch(new RegExp(`\\$5::text, \\$${runIdx}::text, `));
      expect(params).toHaveLength(op.values.length);
    }
  });

  it("without a run the revision statement is unchanged (created_by_run_id NULL)", () => {
    for (const c of [ctx, pinnedCtx]) {
      const op = representationOp(buildDashboardTwinQueries(c));
      expect(op.text).toContain("$5::text, NULL, ");
      expect(op.values).not.toContain("run-1");
    }
  });
});

describe("cinatra#4762: the twin takes the producing run's row before its first write", () => {
  const isRunLock = (q: Op) => /"agent_runs"[\s\S]*FOR KEY SHARE/.test(q.text) && !q.text.includes('"artifact_produced_outbox"');

  it("a run's twin locks the run row FOR KEY SHARE right after the advisory lock, before any write", () => {
    const ops = buildDashboardTwinQueries(ctx, "run-1");
    expect(ops.findIndex(isRunLock)).toBe(1);
    expect(ops[1].values).toEqual(["run-1"]);
    expect(ops[0].text).toContain("pg_advisory_xact_lock");
  });

  it("no run, or the review orchestration switched off, takes no run lock", () => {
    expect(buildDashboardTwinQueries(ctx).some(isRunLock)).toBe(false);
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "off";
    expect(buildDashboardTwinQueries(ctx, "run-1").some(isRunLock)).toBe(false);
  });
});

describe("cinatra#4762: the host lock a content writer takes before its first dashboards write", () => {
  function recordingTx(): { tx: TwinTx; rendered: Array<{ sql: string; params: unknown[] }> } {
    const rendered: Array<{ sql: string; params: unknown[] }> = [];
    return {
      tx: { execute: async (q: SQL) => { const { sql, params } = dialect.sqlToQuery(q); rendered.push({ sql, params }); return { rows: [] }; } },
      rendered,
    };
  }
  // The seam's port, as the dashboards mutation service reaches it; importing the host writer registers the lock.
  const port = () => (globalThis as { __cinatraDashboardArtifactTwinRunLock?: (tx: TwinTx, runId: string | null | undefined) => Promise<void> })
    .__cinatraDashboardArtifactTwinRunLock;

  it("locks the named run's row FOR KEY SHARE through the seam's port", async () => {
    const { tx, rendered } = recordingTx();
    await port()?.(tx, "run-1");
    expect(rendered).toEqual([
      { sql: 'SELECT 1 FROM "cinatra"."agent_runs" WHERE id = $1::text FOR KEY SHARE', params: ["run-1"] },
    ]);
  });

  it("no run, or the review orchestration switched off, takes no lock", async () => {
    const { tx, rendered } = recordingTx();
    await port()?.(tx, null);
    await port()?.(tx, "");
    process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "off";
    await port()?.(tx, "run-1");
    expect(rendered).toEqual([]);
  });
});

describe("(b) the writer trusts a run only in the same organization (cinatra#3092)", () => {
  function fakeTx(runRows: unknown[]): { tx: TwinTx; rendered: Array<{ sql: string; params: unknown[] }> } {
    const rendered: Array<{ sql: string; params: unknown[] }> = [];
    const tx: TwinTx = {
      execute: async (q: SQL) => {
        const r = dialect.sqlToQuery(q);
        rendered.push(r);
        return r.sql.includes('"agent_runs"') ? { rows: runRows } : { rows: [] };
      },
    };
    return { tx, rendered };
  }

  it("reads agent_runs by id AND organization and keeps a found run", async () => {
    const { tx, rendered } = fakeTx([{ id: "run-1" }]);
    expect(await readSameOrgProducerRunId(tx, runCtx)).toBe("run-1");
    expect(rendered).toHaveLength(1);
    expect(rendered[0].sql).toContain('FROM "cinatra"."agent_runs"');
    expect(rendered[0].sql).toContain("org_id");
    expect(rendered[0].params).toEqual(["run-1", "org-1"]);
  });

  it("a run not found in this organization reads as no run", async () => {
    const { tx } = fakeTx([]);
    expect(await readSameOrgProducerRunId(tx, runCtx)).toBeNull();
  });

  it("no run id, an empty one, or a delete makes no read at all", async () => {
    for (const c of [ctx, { ...ctx, producerRunId: "" }, { ...runCtx, operation: "delete" as const }]) {
      const { tx, rendered } = fakeTx([{ id: "run-1" }]);
      expect(await readSameOrgProducerRunId(tx, c)).toBeNull();
      expect(rendered).toHaveLength(0);
    }
  });

  it("the registered writer emits the produced event with the validated run", async () => {
    const { tx, rendered } = fakeTx([{ id: "run-1" }]);
    await dashboardArtifactTwinWriter(tx, runCtx);
    const produced = rendered.find((r) => r.sql.includes('"artifact_produced_outbox"'));
    expect(produced?.params).toContain("run-1");
    expect(produced?.params).toContain("agent_produced");
  });

  it("the registered writer surfaces the in-flight fence of its event as the typed publishing-call refusal (cinatra#4762)", async () => {
    // A publishing call of the run holds its decision: Postgres aborts the event's cast of the fence's sentinel, and
    // the query builder wraps the database error as its cause.
    const rendered: string[] = [];
    const tx: TwinTx = {
      execute: async (q: SQL) => {
        const { sql } = dialect.sqlToQuery(q);
        rendered.push(sql);
        const fence = /THEN '([^']+)' ELSE '1' END\)::integer = 1/.exec(sql);
        if (fence) {
          const cause = Object.assign(new Error(`invalid input syntax for type integer: "${fence[1]}"`), { code: "22P02" });
          throw new Error(`Failed query: ${sql}`, { cause });
        }
        if (sql.includes('"agent_runs"') && sql.includes("org_id")) return { rows: [{ id: "run-1" }] };
        return { rows: [] };
      },
    };
    await expect(dashboardArtifactTwinWriter(tx, runCtx)).rejects.toMatchObject({ name: "PublishCallInFlightError", code: "publish_call_in_flight", retryable: true });
    expect(rendered.some((sql) => sql.includes('"artifact_produced_outbox"'))).toBe(true);
  });

  it("the registered writer drops a cross-organization run: the event names none", async () => {
    const { tx, rendered } = fakeTx([]);
    await dashboardArtifactTwinWriter(tx, runCtx);
    const produced = rendered.find((r) => r.sql.includes('"artifact_produced_outbox"'));
    expect(produced?.params).not.toContain("run-1");
    expect(produced?.params).toContain("user_provided");
  });
});
