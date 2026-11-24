/**
 * The single-use consumption of a person's decision for a run's outward action (cinatra#3745).
 *
 * The store checks the person's recorded, affirmative decision for exactly the run, step and action of a call (the
 * publish decision in front of the step, cinatra#4150) and records its one consumption in the same transaction. The
 * graph is the repository's synthetic agent fixture with two declared steps, read by the host's real declaration
 * reader. The guarded transaction is a stand-in that keeps the rows of each table in memory; the consumption table
 * behaves as its primary key does (an insert of a used key inserts nothing). The decision read behaves as the database
 * does: it keeps the rows of the run and step in the run's current attempt (a row with no generation counts as current),
 * orders them by the creation time at microsecond precision (`createdAtMicros`, which a JavaScript Date cannot hold),
 * then id, newest first, and applies the limit. The test also checks that the read uses the publish-decision store's own
 * current-attempt predicate and order, so the stand-in and the store cannot differ.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  agentRunOutwardActionPolicies,
  agentRunPublishDecisions,
  agentRuns,
  artifactReviewActionConsumptions,
} from "../schema";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  tables: new Map<unknown, Record<string, unknown>[]>(),
  calls: [] as string[],
  fail: null as Error | null,
  // Set by the concurrent case: every consumption read waits until both calls reached it.
  barrier: null as null | { arrive: () => Promise<void> },
  // The arguments of the decision read's where and orderBy calls.
  decisionWhere: [] as unknown[],
  decisionOrder: [] as unknown[][],
}));

vi.mock("../db", () => ({ db: { transaction: () => { throw Error("must use the guarded seam"); } } }));
vi.mock("../org-write-run-seam", () => ({
  guardedRunWrite: async (authority: unknown, opts: { orgId: string; runId: string; capability: string },
    body: (tx: object) => Promise<unknown>) => {
    if (!authority || (authority as { orgId?: unknown }).orgId !== opts.orgId) throw Error("org write refused: lease org-7");
    h.calls.push(`guard:${opts.capability}`);
    const rowsOf = (table: unknown) => h.tables.get(table) ?? [];
    const tx = {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          let ordered = false; let limit = Infinity;
          const chain = {
            where: (cond: unknown) => { if (table === agentRunPublishDecisions) h.decisionWhere.push(cond); return chain; },
            orderBy: (...by: unknown[]) => {
              if (table === agentRunPublishDecisions) { h.decisionOrder.push(by); ordered = true; }
              return chain;
            },
            limit: (n: number) => { limit = n; return chain; },
            for: (mode: string) => { h.calls.push(`lock:${tableName(table)}:${mode}`); return chain; },
            then: async (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
              try {
                if (h.fail) throw h.fail;
                if (table === artifactReviewActionConsumptions && h.barrier) await h.barrier.arrive();
                let rows = rowsOf(table).map((r) => ({ ...r }));
                if (table === agentRunPublishDecisions) rows = databaseDecisionRead(rows, ordered).slice(0, limit);
                return resolve(columns ? rows.map((r) => ({ gateId: r.gateId })) : rows);
              } catch (e) { return reject(e); }
            },
          };
          return chain;
        },
      }),
      insert: (table: unknown) => ({
        values: (value: Row) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              const rows = h.tables.get(table) ?? [];
              h.tables.set(table, rows);
              if (rows.some((r) => r.gateId === value.gateId)) return [];
              rows.push({ ...value, consumedAt: new Date() });
              h.calls.push("insert:consumption");
              return [{ gateId: value.gateId }];
            },
          }),
        }),
      }),
    };
    return body(tx);
  },
}));

/** The decision read as the database runs it for run-1 and the proof's step: the current attempt's rows (the run's
 *  reset generation, or no generation at all), newest first by microsecond creation time, then id. */
function databaseDecisionRead(rows: Row[], ordered: boolean): Row[] {
  const run = (h.tables.get(agentRuns) ?? []).find((r) => r.id === "run-1");
  const micros = (r: Row) => (r.createdAtMicros as number | undefined) ?? (r.createdAt as Date).getTime() * 1000;
  const kept = rows.filter((r) => r.runId === "run-1" && r.nodeId === SEND_STEP && run !== undefined &&
    (r.runGeneration ?? run.resetGeneration) === run.resetGeneration);
  if (!ordered) return kept;
  return kept.sort((a, b) => {
    const ma = micros(a), mb = micros(b);
    if (ma !== mb) return ma > mb ? -1 : 1;
    return String(a.id) > String(b.id) ? -1 : String(a.id) < String(b.id) ? 1 : 0;
  });
}

/** True when the drizzle SQL value holds `needle` itself among its chunks, at any depth. */
function holdsChunk(value: unknown, needle: unknown, seen = new Set<unknown>()): boolean {
  if (value === needle) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
  return Array.isArray(chunks) && chunks.some((c) => holdsChunk(c, needle, seen));
}

function tableName(table: unknown): string {
  if (table === agentRuns) return "run";
  if (table === agentRunOutwardActionPolicies) return "binding";
  if (table === agentRunPublishDecisions) return "decision";
  return "consumption";
}

// The module is new with cinatra#3745. It is loaded inside each test, not at the top of the file: before the change
// the file still loads and each test fails on the missing module.
// red-first-expect: Cannot find module '/src/run-action-decision-consumption'
const loadModule = () => import("../run-action-decision-consumption");
async function consume(input: unknown) {
  const { consumeRunActionDecision } = await loadModule();
  return consumeRunActionDecision(input as Parameters<typeof consumeRunActionDecision>[0]);
}

const SEND_STEP = "call_llm_bridge";
const OTHER_STEP = "other_step";
const GRAPH = JSON.parse(readFileSync(new URL("./fixtures/synthetic-gemini-agent.json", import.meta.url), "utf8")) as {
  $referenced_components: Record<string, Record<string, unknown>>;
};
const graph = structuredClone(GRAPH);
graph.$referenced_components[SEND_STEP]!.metadata = { cinatra: { tools: ["mail_send"] } };
graph.$referenced_components[OTHER_STEP] = { ...structuredClone(GRAPH.$referenced_components[SEND_STEP]!), id: OTHER_STEP,
  name: OTHER_STEP, metadata: { cinatra: { tools: ["post_publish"] } } };
const source = JSON.stringify(graph);
const sha = createHash("sha256").update(source).digest("hex");
const policy = { version: 1, contextId: "ctx", sourceSha256: sha, executedSourceSha256: sha, declarationSourceSha256: sha, source };
const proofFor = (stepId: string) => ({ contextId: "ctx", stepId, executionAttemptId: "attempt-1",
  sourceSha256: sha, executedSourceSha256: sha, declarationSourceSha256: sha });
const action = { toolName: "mail_send", packageName: "@cinatra-ai/email-connector", version: "1.2.3",
  installId: "install-1", digest: "d".repeat(64) };
const input = (over: Record<string, unknown> = {}) => ({ orgId: "org-1", runId: "run-1",
  authority: { orgId: "org-1" }, proof: proofFor(SEND_STEP), action, ...over });
const decision = (over: Row = {}): Row => ({ id: "decision-1", orgId: "org-1", runId: "run-1", nodeId: SEND_STEP,
  gateTaskId: "gate-task-1", status: "released", decidedBy: "user-7", decidedAt: new Date("2026-11-24T10:00:00Z"),
  createdAt: new Date("2026-11-24T09:00:00Z"), runGeneration: 0, ...over });
const consumptions = () => h.tables.get(artifactReviewActionConsumptions) ?? [];

beforeEach(() => {
  h.calls = []; h.fail = null; h.barrier = null; h.decisionWhere = []; h.decisionOrder = [];
  h.tables = new Map<unknown, Row[]>([
    [agentRuns, [{ id: "run-1", orgId: "org-1", status: "running", executionAttemptId: "attempt-1", a2aContextId: "ctx", resetGeneration: 0 }]],
    [agentRunOutwardActionPolicies, [{ runId: "run-1", orgId: "org-1", executionAttemptId: "attempt-1", policy }]],
    [agentRunPublishDecisions, [decision()]],
    [artifactReviewActionConsumptions, []],
  ]);
});

describe("the person's affirmative decision for the run's action, used once", () => {
  it("consumes the released decision of exactly this run, step and action once, in one guarded transaction", async () => {
    await loadModule();
    const result = await consume(input());
    expect(result).toEqual({ consumptionKey: "publish_decision:decision-1", decisionId: "decision-1", decidedBy: "user-7",
      stepId: SEND_STEP, action });
    expect(consumptions()).toEqual([expect.objectContaining({ gateId: "publish_decision:decision-1", runId: "run-1",
      orgId: "org-1", stepId: SEND_STEP, toolIdentity: action, executedSourceSha256: sha })]);
    // One transaction under the org-write guard; the rows are locked run, binding, decision, then the one insert.
    expect(h.calls).toEqual(["guard:run.execute", "lock:run:update", "lock:binding:update", "lock:decision:update",
      "insert:consumption"]);
  });

  it("refuses a second consumption of the same decision", async () => {
    await loadModule();
    await consume(input());
    await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_already_consumed" });
    expect(consumptions()).toHaveLength(1);
  });

  it("of two concurrent consumptions exactly one commits; the primary key refuses the other", async () => {
    await loadModule();
    let waiting = 0; let open!: () => void;
    const both = new Promise<void>((resolve) => { open = resolve; });
    h.barrier = { arrive: async () => { if (++waiting === 2) open(); await both; } };
    const results = await Promise.allSettled([consume(input()), consume(input())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "action_person_decision_already_consumed" });
    expect(consumptions()).toHaveLength(1);
  });

  it("refuses when the step has no decision", async () => {
    await loadModule();
    h.tables.set(agentRunPublishDecisions, []);
    await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_missing" });
    expect(consumptions()).toEqual([]);
  });

  it("refuses an open decision", async () => {
    await loadModule();
    h.tables.set(agentRunPublishDecisions, [decision({ status: "parked", decidedBy: null, decidedAt: null })]);
    await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_open" });
    expect(consumptions()).toEqual([]);
  });

  it("refuses a declined, expired or ended decision", async () => {
    await loadModule();
    for (const status of ["declined", "expired", "run_ended"]) {
      h.tables.set(agentRunPublishDecisions, [decision({ status, ...(status === "declined" ? {} : { decidedBy: null }) })]);
      await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_not_affirmative" });
    }
    expect(consumptions()).toEqual([]);
  });

  it("judges the newest decision of the step: a newer open decision holds an older released one", async () => {
    await loadModule();
    h.tables.set(agentRunPublishDecisions, [decision(),
      decision({ id: "decision-2", gateTaskId: "gate-task-2", status: "parked", decidedBy: null, decidedAt: null,
        createdAt: new Date("2026-11-24T11:00:00Z") })]);
    await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_open" });
  });

  it("refuses a decision for another step", async () => {
    await loadModule();
    h.tables.set(agentRunPublishDecisions, [decision({ nodeId: OTHER_STEP })]);
    await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_missing" });
    expect(consumptions()).toEqual([]);
  });

  it("refuses a decision for another action: the step's declaration does not name the tool", async () => {
    await loadModule();
    await expect(consume(input({ action: { ...action, toolName: "post_publish" } })))
      .rejects.toMatchObject({ code: "step_tool_not_declared" });
    expect(consumptions()).toEqual([]);
  });

  it("refuses a step that declares no tools, since no decision of it names an action", async () => {
    await loadModule();
    const bare = structuredClone(graph);
    delete bare.$referenced_components[SEND_STEP]!.metadata;
    const bareSource = JSON.stringify(bare);
    const bareSha = createHash("sha256").update(bareSource).digest("hex");
    h.tables.set(agentRunOutwardActionPolicies, [{ runId: "run-1", orgId: "org-1", executionAttemptId: "attempt-1",
      policy: { ...policy, source: bareSource, sourceSha256: bareSha, executedSourceSha256: bareSha, declarationSourceSha256: bareSha } }]);
    const proof = { ...proofFor(SEND_STEP), sourceSha256: bareSha, executedSourceSha256: bareSha, declarationSourceSha256: bareSha };
    await expect(consume(input({ proof }))).rejects.toMatchObject({ code: "action_decision_step_undeclared" });
    expect(consumptions()).toEqual([]);
  });

  it("refuses a decision of another run, organization or attempt", async () => {
    await loadModule();
    for (const over of [{ runId: "run-2" }, { runGeneration: 1 }, { runGeneration: -1 }]) {
      h.tables.set(agentRunPublishDecisions, [decision(over)]);
      await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_missing" });
    }
    h.tables.set(agentRunPublishDecisions, [decision({ orgId: "org-2" })]);
    await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_invalid" });
    expect(consumptions()).toEqual([]);
  });

  it("consumes once a released decision with no generation: a row of an older node is current until a reset", async () => {
    await loadModule();
    h.tables.set(agentRunPublishDecisions, [decision({ runGeneration: null })]);
    // red-first-expect: Cannot find module '/src/run-action-decision-consumption'
    const result = await consume(input());
    expect(result).toMatchObject({ consumptionKey: "publish_decision:decision-1", decidedBy: "user-7" });
    await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_already_consumed" });
    expect(consumptions()).toHaveLength(1);
    // The read judges the attempt by the publish-decision store's own predicate.
    const { CURRENT_ATTEMPT } = await import("../publish-decision-store");
    expect(h.decisionWhere.length).toBeGreaterThan(0);
    for (const where of h.decisionWhere) expect(holdsChunk(where, CURRENT_ATTEMPT)).toBe(true);
  });

  it("picks the database's newest of two decisions inside one millisecond, never a re-sort at millisecond precision", async () => {
    await loadModule();
    // The same millisecond for JavaScript; the database holds the open one 400 microseconds later. Its id sorts below the
    // older released one, so a millisecond re-sort with an id tiebreak would wrongly pick the released decision.
    const ms = new Date("2026-11-24T11:00:00.123Z");
    const base = ms.getTime() * 1000; // microseconds, within the safe integer range
    h.tables.set(agentRunPublishDecisions, [
      decision({ id: "decision-b", createdAt: ms, createdAtMicros: base + 100 }),
      decision({ id: "decision-a", gateTaskId: "gate-task-2", status: "parked", decidedBy: null, decidedAt: null,
        createdAt: ms, createdAtMicros: base + 500 }),
    ]);
    // red-first-expect: Cannot find module '/src/run-action-decision-consumption'
    await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_open" });
    expect(consumptions()).toEqual([]);
    // The read orders as the store does (created_at, then id, newest first) and takes one row.
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const { sql } = await import("drizzle-orm");
    const order = h.decisionOrder.at(-1) ?? [];
    expect(new PgDialect().sqlToQuery(sql.join(order as never[], sql`, `)).sql)
      .toBe('"cinatra"."agent_run_publish_decisions"."created_at" desc, "cinatra"."agent_run_publish_decisions"."id" desc');
  });

  it("refuses a released decision that names no person", async () => {
    await loadModule();
    for (const over of [{ decidedBy: null }, { decidedBy: "" }, { decidedAt: null }]) {
      h.tables.set(agentRunPublishDecisions, [decision(over)]);
      await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_invalid" });
    }
    expect(consumptions()).toEqual([]);
  });

  it("refuses a run that no longer runs under the proof's attempt, context and bound source", async () => {
    await loadModule();
    const run = h.tables.get(agentRuns)![0]!;
    for (const over of [{ status: "pending_approval" }, { executionAttemptId: "attempt-2" }, { a2aContextId: "ctx-2" }]) {
      h.tables.set(agentRuns, [{ ...run, ...over }]);
      await expect(consume(input())).rejects.toMatchObject({ code: "action_run_source_stale" });
    }
    h.tables.set(agentRuns, [run]);
    await expect(consume(input({ proof: { ...proofFor(SEND_STEP), executedSourceSha256: "e".repeat(64) } })))
      .rejects.toMatchObject({ code: "action_run_source_stale" });
    h.tables.set(agentRunOutwardActionPolicies, []);
    await expect(consume(input())).rejects.toMatchObject({ code: "action_run_source_stale" });
    expect(consumptions()).toEqual([]);
  });

  it("refuses malformed input before any transaction", async () => {
    await loadModule();
    for (const over of [{ runId: "" }, { orgId: undefined }, { proof: { ...proofFor(SEND_STEP), sourceSha256: "x" } },
      { action: { ...action, digest: "" } }, { action: { ...action, toolName: "mail_send\n" } }, { action: null }]) {
      await expect(consume(input(over))).rejects.toMatchObject({ code: "action_decision_input_invalid" });
    }
    expect(h.calls).toEqual([]);
  });

  it("fails closed with a fixed code on a store or org-write failure, never with its text", async () => {
    await loadModule();
    h.fail = new Error("connection to db-host-3 reset");
    const stored = await consume(input()).catch((e: unknown) => e as Error & { code?: string });
    expect(stored).toMatchObject({ code: "action_person_decision_unavailable" });
    expect(String((stored as Error).message)).not.toContain("db-host-3");
    h.fail = null;
    const org = await consume(input({ authority: { orgId: "org-2" } })).catch((e: unknown) => e as Error & { code?: string });
    expect(org).toMatchObject({ code: "action_person_decision_unavailable" });
    expect(String((org as Error).message)).not.toContain("org-7");
    expect(consumptions()).toEqual([]);
  });
});
