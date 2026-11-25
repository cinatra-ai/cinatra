/**
 * The single-use consumption of a person's decision for a run's outward action (cinatra#3745).
 *
 * The store checks the person's recorded, affirmative decision for exactly the run, step and action of a call (the
 * publish decision in front of the step, cinatra#4150) and records its one consumption in the same transaction. The
 * graph is the repository's synthetic agent fixture with two declared steps, read by the host's real declaration
 * reader. The guarded transaction is a stand-in that keeps the rows of each table in memory; the consumption table
 * behaves as its primary key does (an insert of a used key inserts nothing). The decision read is honoured from the
 * query itself: the stand-in renders the read's where and order to SQL and runs only the one shape it knows (run and step
 * from the query's own parameters, the publish-decision store's current-attempt predicate, created_at then id, newest
 * first); any other where or order throws, so the stand-in cannot filter what the query does not say. Creation times
 * are kept at microsecond precision (`createdAtMicros`, which a JavaScript Date cannot hold).
 *
 * The race cases also model the run row's locks: the consumption's FOR UPDATE, and the KEY SHARE lock that a new
 * decision's insert (the real insertParkedDecision) takes only when its rendered SQL asks for it. A new decision becomes
 * visible when its statement commits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  agentRunOutwardActionPolicies,
  agentRunPublishDecisions,
  agentRuns,
  artifactReviewActionConsumptions,
} from "../schema";
import { CURRENT_ATTEMPT, insertParkedDecision } from "../publish-decision-store";

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
  // The race cases: the run row's locks are modelled, and the order in which writes commit is recorded.
  lockRuns: false,
  runLock: { exclusive: false, shared: 0, waiting: [] as Array<() => void> },
  commits: [] as string[],
  // Runs once, right after the consumption's decision read returned its rows.
  afterDecisionRead: null as null | (() => Promise<void>),
  // Holds a new decision's insert after it took its lock, before it commits.
  parkHold: null as null | Promise<void>,
  park: null as null | ((table: unknown, value: Record<string, unknown>) => Promise<Record<string, unknown>[]>),
}));

async function lockRun(mode: "update" | "key share"): Promise<void> {
  const l = h.runLock;
  for (;;) {
    if (mode === "update" ? !l.exclusive && l.shared === 0 : !l.exclusive) {
      if (mode === "update") l.exclusive = true; else l.shared += 1;
      return;
    }
    await new Promise<void>((resolve) => l.waiting.push(resolve));
  }
}
function unlockRun(mode: "update" | "key share"): void {
  const l = h.runLock;
  if (mode === "update") l.exclusive = false; else l.shared -= 1;
  for (const wake of l.waiting.splice(0)) wake();
}

vi.mock("../db", () => ({ db: {
  transaction: () => { throw Error("must use the guarded seam"); },
  // A new decision's insert (insertParkedDecision): one autocommit statement.
  insert: (table: unknown) => ({ values: (value: Record<string, unknown>) => ({
    onConflictDoNothing: () => ({ returning: () => h.park!(table, value) }) }) }),
} }));
vi.mock("../org-write-run-seam", () => ({
  guardedRunWrite: async (authority: unknown, opts: { orgId: string; runId: string; capability: string },
    body: (tx: object) => Promise<unknown>) => {
    if (!authority || (authority as { orgId?: unknown }).orgId !== opts.orgId) throw Error("org write refused: lease org-7");
    h.calls.push(`guard:${opts.capability}`);
    let holdsRun = false;
    const rowsOf = (table: unknown) => h.tables.get(table) ?? [];
    const tx = {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          let where: unknown = null; let order: unknown[] | null = null; let limit = Infinity; let lock: string | null = null;
          const chain = {
            where: (cond: unknown) => { where = cond; if (table === agentRunPublishDecisions) h.decisionWhere.push(cond); return chain; },
            orderBy: (...by: unknown[]) => {
              order = by;
              if (table === agentRunPublishDecisions) h.decisionOrder.push(by);
              return chain;
            },
            limit: (n: number) => { limit = n; return chain; },
            for: (mode: string) => { lock = mode; h.calls.push(`lock:${tableName(table)}:${mode}`); return chain; },
            then: async (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
              try {
                if (h.fail) throw h.fail;
                if (table === agentRuns && lock === "update" && h.lockRuns && !holdsRun) { await lockRun("update"); holdsRun = true; }
                if (table === artifactReviewActionConsumptions && h.barrier) await h.barrier.arrive();
                let rows = rowsOf(table).map((r) => ({ ...r }));
                if (table === agentRunPublishDecisions) rows = databaseDecisionRead(rows, where, order).slice(0, limit);
                if (table === agentRunPublishDecisions && h.afterDecisionRead) {
                  const hook = h.afterDecisionRead; h.afterDecisionRead = null; await hook();
                }
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
    try {
      const out = await body(tx);
      h.commits.push("consumption");
      return out;
    } finally {
      if (holdsRun) unlockRun("update");
    }
  },
}));

/** A new decision's insert, as one autocommit statement: it takes the run row's KEY SHARE lock only when the rendered
 *  SQL of its generation read asks for it, and its row becomes visible when it commits. */
h.park = async (table, value) => {
  if (table !== agentRunPublishDecisions) throw Error("unexpected insert");
  const generation = new PgDialect().sqlToQuery(value.runGeneration as SQL).sql;
  const locks = h.lockRuns && /"cinatra"\."agent_runs" live_run where live_run\.id = \$\d+ for key share\)/.test(generation);
  if (locks) await lockRun("key share");
  try {
    if (h.parkHold) await h.parkHold;
    const run = (h.tables.get(agentRuns) ?? []).find((r) => r.id === value.runId);
    const held = run !== undefined && (run.status === "running" || run.status === "pending_approval");
    const row: Row = { ...value, runGeneration: held ? run!.resetGeneration : -1, decidedBy: null, decidedAt: null,
      decisionNote: null, createdAt: new Date("2026-11-24T12:00:00Z"), createdAtMicros: Date.parse("2026-11-24T12:00:00Z") * 1000,
      expiresAt: new Date("2026-11-25T12:00:00Z") };
    h.tables.get(agentRunPublishDecisions)!.push(row);
    h.commits.push("decision");
    return [{ ...row }];
  } finally {
    if (locks) unlockRun("key share");
  }
};

/** The decision read, run from the query's own where and order. The one where shape known is the run and step (taken
 *  from the query's parameters) and the store's current-attempt predicate; the one order known is created_at then id,
 *  newest first. Anything else throws. The current attempt is the run's reset generation, or no generation at all. */
function databaseDecisionRead(rows: Row[], where: unknown, order: unknown[] | null): Row[] {
  const dialect = new PgDialect();
  const asked = dialect.sqlToQuery(where as SQL);
  const [runId, nodeId] = asked.params;
  const known = dialect.sqlToQuery(and(eq(agentRunPublishDecisions.runId, runId as string),
    eq(agentRunPublishDecisions.nodeId, nodeId as string), CURRENT_ATTEMPT)!);
  if (asked.sql !== known.sql || JSON.stringify(asked.params) !== JSON.stringify(known.params)) {
    throw Error("the stand-in cannot run this decision read's where");
  }
  const newestFirst = dialect.sqlToQuery(sql.join([desc(agentRunPublishDecisions.createdAt),
    desc(agentRunPublishDecisions.id)], sql`, `)).sql;
  if (order !== null && dialect.sqlToQuery(sql.join(order as SQL[], sql`, `)).sql !== newestFirst) {
    throw Error("the stand-in cannot run this decision read's order");
  }
  const run = (h.tables.get(agentRuns) ?? []).find((r) => r.id === runId);
  const micros = (r: Row) => (r.createdAtMicros as number | undefined) ?? (r.createdAt as Date).getTime() * 1000;
  const kept = rows.filter((r) => r.runId === runId && r.nodeId === nodeId && run !== undefined &&
    (r.runGeneration ?? run.resetGeneration) === run.resetGeneration);
  if (order === null) return kept;
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
  createdAt: new Date("2026-11-24T09:00:00Z"), runGeneration: 0, surfacedValues: JSON.stringify({ subject: "Hello" }),
  declaredRows: JSON.stringify([{ label: "Subject", input: "subject" }]), a2aContextId: "ctx", decisionNote: null,
  expiresAt: new Date("2026-11-25T09:00:00Z"), ...over });
const consumptions = () => h.tables.get(artifactReviewActionConsumptions) ?? [];

beforeEach(() => {
  h.calls = []; h.fail = null; h.barrier = null; h.decisionWhere = []; h.decisionOrder = [];
  h.lockRuns = false; h.runLock = { exclusive: false, shared: 0, waiting: [] }; h.commits = [];
  h.afterDecisionRead = null; h.parkHold = null;
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

  // A new decision of the same run and step, with a distinct gate task, written by the store's real insert.
  const newPark = () => insertParkedDecision({ orgId: "org-1", runId: "run-1", nodeId: SEND_STEP, gateTaskId: "gate-task-2",
    a2aContextId: "ctx", surfacedValues: { subject: "Hello again" } });
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

  it("a new decision of the step cannot commit between the consumption's read and its write: it waits for the commit", async () => {
    await loadModule();
    h.lockRuns = true;
    let park: Promise<unknown> | null = null;
    // The new decision arrives right after the consumption chose the released one, and is given time to commit.
    h.afterDecisionRead = async () => { park = newPark(); await pause(); };
    const result = await consume(input());
    await park;
    expect(result).toMatchObject({ decisionId: "decision-1" });
    // Serialized: the consumption committed first, so the released decision was still the newest when it was used.
    expect(h.commits).toEqual(["consumption", "decision"]);
    // The new open decision now holds the step.
    await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_open" });
    expect(consumptions()).toHaveLength(1);
  });

  it("a consumption waits for a new decision of the step that is being written, then refuses the older released one", async () => {
    await loadModule();
    h.lockRuns = true;
    let release!: () => void;
    h.parkHold = new Promise<void>((resolve) => { release = resolve; });
    const park = newPark();
    await pause();
    const consumption = consume(input()).catch((e: unknown) => e);
    await pause();
    // The consumption waits at the run row: it has not read the binding yet.
    expect(h.calls).toContain("lock:run:update");
    expect(h.calls).not.toContain("lock:binding:update");
    release();
    await park;
    expect(await consumption).toMatchObject({ code: "action_person_decision_open" });
    expect(h.commits).toEqual(["decision"]);
    expect(consumptions()).toEqual([]);
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

  it("refuses a released decision whose stored surfaced values or declared rows the store cannot read", async () => {
    await loadModule();
    const malformed: Row[] = [{ surfacedValues: "{not json" }, { surfacedValues: JSON.stringify(["a"]) },
      { declaredRows: "[{" }, { declaredRows: JSON.stringify([{ label: "Subject" }]) }];
    for (const over of malformed) {
      h.tables.set(agentRunPublishDecisions, [decision(over)]);
      const refused = await consume(input()).catch((e: unknown) => e as Error & { code?: string });
      expect(refused).toMatchObject({ code: "action_person_decision_invalid" });
      expect(String((refused as Error).message)).not.toMatch(/not json|Subject/);
    }
    expect(consumptions()).toEqual([]);
    // A valid row, with or without recorded declared rows, is still consumed once.
    h.tables.set(agentRunPublishDecisions, [decision({ declaredRows: null })]);
    await expect(consume(input())).resolves.toMatchObject({ consumptionKey: "publish_decision:decision-1" });
    await expect(consume(input())).rejects.toMatchObject({ code: "action_person_decision_already_consumed" });
    expect(consumptions()).toHaveLength(1);
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
