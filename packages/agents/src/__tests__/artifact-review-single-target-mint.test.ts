import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

type StoredGate = {
  id: string;
  runId: string;
  orgId: string;
  reviewTaskId: string;
  status: "pending" | "resolved";
  pinnedTargets: Array<{ artifactId: string; representationRevisionId: string }>;
};

const storage = vi.hoisted(() => {
  const rows = new Map<string, StoredGate>();
  const inserts: StoredGate[] = [];
  /** The run generation each insert stamps, as the emitter hands it to the statement (a number, or an SQL read). */
  const generations: unknown[] = [];
  let readFailure = false;
  let lateConflict: StoredGate | null = null;
  let crashAfter: number | null = null;
  let readIdentity: { runId: string; reviewTaskId: string } | undefined;
  const key = (row: StoredGate) => `${row.runId}/${row.reviewTaskId}`;
  /** cinatra#4762: the statements the store runs on `execute` (the run-row lock, the read of a publishing call in
   *  flight), in order, each tagged with the insert count at that moment. */
  const statements: Array<{ text: string; insertsBefore: number }> = [];
  let publishCallInFlight = false;
  const executor = {
    async execute(query: SQL) {
      const text = new PgDialect().sqlToQuery(query).sql;
      statements.push({ text, insertsBefore: inserts.length });
      return { rows: /calls_in_flight > 0/.test(text) && publishCallInFlight ? [{ "?column?": 1 }] : [] };
    },
    async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      const before = new Map(rows);
      try { return await callback(executor); }
      catch (err) { rows.clear(); for (const [k, v] of before) rows.set(k, v); throw err; }
    },
    insert() {
      return {
        values(input: StoredGate & { runGeneration?: unknown }) {
          // The run generation is an SQL expression the database evaluates from the run row; this store keeps none.
          const row: StoredGate & { runGeneration?: unknown } = { ...input };
          generations.push(row.runGeneration);
          delete row.runGeneration;
          readIdentity = row;
          inserts.push(row);
          return {
            onConflictDoNothing() {
              return {
                async returning() {
                  if (crashAfter !== null && inserts.length > crashAfter) throw new Error("interrupted before family commit");
                  if (lateConflict?.reviewTaskId === row.reviewTaskId) return [];
                  if (rows.has(key(row))) return [];
                  rows.set(key(row), row);
                  return [{ id: row.id }];
                },
              };
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where(condition: SQL) {
              const [runId, reviewTaskId] = new PgDialect().sqlToQuery(condition).params;
              readIdentity = { runId: String(runId), reviewTaskId: String(reviewTaskId) };
              return {
                async orderBy() { if (readFailure) throw new Error("family inventory unreadable"); return [...rows.values()].filter(row => row.runId === String(runId)); },
                async limit() {
                  if (readIdentity?.reviewTaskId === lateConflict?.reviewTaskId && lateConflict) return [lateConflict];
                  return readIdentity ? [rows.get(`${readIdentity.runId}/${readIdentity.reviewTaskId}`)].filter(Boolean) : [];
                },
              };
            },
          };
        },
      };
    },
  };
  return { rows, inserts, generations, executor, statements, setPublishCallInFlight(value: boolean) { publishCallInFlight = value; }, setLateConflict(row: StoredGate | null) { lateConflict = row; }, setReadFailure(value: boolean) { readFailure = value; }, setCrashAfter(n: number | null) { crashAfter = n; }, setReadKey(row: StoredGate) { readIdentity = row; } };
});

vi.mock("../db", () => ({ db: storage.executor }));
vi.mock("../store", () => ({
  readAgentRunById: vi.fn(), readAgentTemplateById: vi.fn(), readRunCoOwners: vi.fn(),
}));
vi.mock("../auth-policy", () => ({ enforceRunAccess: vi.fn(), resolveEffectivePolicy: vi.fn() }));
vi.mock("../run-wait-notifier", () => ({ dispatchAutoGateResolved: vi.fn() }));
vi.mock("../run-produced-review-hold", () => ({ isParkedOnProducedReview: vi.fn(() => false) }));

import * as gateStore from "../artifact-review-gate-store";
import { emitArtifactReviewGate, emitDeclaredReviewGateFamily, readGatePinnedTargets } from "../artifact-review-gate-store";

const A = { artifactId: "post", representationRevisionId: "post-r1" };
const B = { artifactId: "image", representationRevisionId: "image-r1" };
const input = (targets: unknown) => ({ runId: "run", orgId: "org", reviewTaskId: "task", targets });

beforeEach(() => { storage.rows.clear(); storage.inserts.length = 0; storage.generations.length = 0; storage.statements.length = 0; storage.setPublishCallInFlight(false); storage.setCrashAfter(null); storage.setReadFailure(false); storage.setLateConflict(null); });

describe("new review gates freeze one artifact revision", () => {
  it.each([
    [A, B],
    [A, { ...A, representationRevisionId: "post-r2" }],
  ])("refuses a distinct combined input before any insert: %j", async (...targets) => {
    await expect(emitArtifactReviewGate(input(targets))).rejects.toMatchObject({ code: "invalid-targets" });
    expect(storage.inserts).toEqual([]);
  });

  it("never discards a malformed sibling to make a singleton", async () => {
    await expect(emitArtifactReviewGate(input([A, { artifactId: "image" }]))).rejects.toMatchObject({ code: "invalid-targets" });
    expect(storage.inserts).toEqual([]);
  });

  it("deduplicates identical pins without treating them as another artifact", async () => {
    const result = await emitArtifactReviewGate(input([A, A]));
    expect(result.targets).toEqual([A]);
    expect(storage.inserts[0].pinnedTargets).toEqual([A]);
  });

  it("keeps exact same-pin replay idempotent and rejects a repin or foreign organization", async () => {
    const first = await emitArtifactReviewGate(input([A]));
    expect(await emitArtifactReviewGate(input([A]))).toEqual({ ...first, idempotent: true });
    await expect(emitArtifactReviewGate(input([B]))).rejects.toMatchObject({ code: "pin-conflict" });
    await expect(emitArtifactReviewGate({ ...input([A]), orgId: "other" })).rejects.toMatchObject({ code: "pin-conflict" });
    expect(storage.rows.size).toBe(1);
  });

  it.each(["pending", "resolved"] as const)("retains a historical %s gate's complete frozen target set", async (status) => {
    const historical: StoredGate = {
      id: "historic", runId: "run", orgId: "org", reviewTaskId: "historic-task", status,
      pinnedTargets: [A, B],
    };
    storage.rows.set("run/historic-task", historical);
    storage.setReadKey(historical);
    expect(await readGatePinnedTargets("run", "historic-task")).toMatchObject({
      status, targets: [A, B],
    });
    expect(storage.inserts).toEqual([]);
  });
});


describe("grandfathered combined gate replay", () => {
  it.each(["pending", "resolved"] as const)("replays a matching historical %s gate without any write", async status => {
    const historical: StoredGate = { id: "historic", runId: "run", orgId: "org", reviewTaskId: "task", status, pinnedTargets: [A, B] };
    storage.rows.set("run/task", historical);
    expect(await emitArtifactReviewGate(input([B, A]))).toEqual({ gateId: "historic", targets: [B, A], idempotent: true });
    expect(storage.inserts).toEqual([]);
    expect(storage.rows.get("run/task")).toBe(historical);
  });

  it("never reuses a foreign or differently pinned combined gate", async () => {
    storage.rows.set("run/task", { id: "historic", runId: "run", orgId: "other", reviewTaskId: "task", status: "pending", pinnedTargets: [A, B] });
    await expect(emitArtifactReviewGate(input([A, B]))).rejects.toMatchObject({ code: "pin-conflict" });
    storage.rows.set("run/task", { id: "historic", runId: "run", orgId: "org", reviewTaskId: "task", status: "pending", pinnedTargets: [A, { ...B, representationRevisionId: "other-revision" }] });
    await expect(emitArtifactReviewGate(input([A, B]))).rejects.toMatchObject({ code: "pin-conflict" });
    expect(storage.inserts).toEqual([]);
  });
});


describe("H1 atomic original-pause membership", () => {
  const familyInput = () => ({ runId: "run", orgId: "org", reviewTaskId: "wayflow-task", targets: [A, B] });
  it("persists exact complete immutable membership, and retries without rewriting", async () => {
    await emitDeclaredReviewGateFamily(familyInput());
    const before = JSON.stringify([...storage.rows]);
    expect(storage.rows.size).toBe(2);
    for (const row of storage.rows.values()) {
      expect(row.pinnedTargets).toHaveLength(1);
      expect(row.pinnedTargets[0]).toMatchObject({ declaredReviewPlan: { runId: "run", orgId: "org", baseTaskId: "wayflow-task", legs: [
        { reviewTaskId: "wayflow-task", targets: [A] }, { reviewTaskId: "wayflow-task#2", targets: [B] },
      ] } });
    }
    await emitDeclaredReviewGateFamily(familyInput());
    expect(JSON.stringify([...storage.rows])).toBe(before);
  });
  it("a crash after the first insert rolls back and an exact retry recovers both", async () => {
    storage.setCrashAfter(1);
    await expect(emitDeclaredReviewGateFamily(familyInput())).rejects.toThrow("interrupted");
    expect(storage.rows.size).toBe(0);
    storage.setCrashAfter(null);
    await emitDeclaredReviewGateFamily(familyInput());
    expect(storage.rows.size).toBe(2);
  });
  it.each(["pending", "resolved"] as const)("late %s pin conflict rolls back the newly inserted first leg", async status => {
    const old: StoredGate = { id: "old", runId: "run", orgId: "org", reviewTaskId: "wayflow-task#2", status,
      pinnedTargets: [{ ...B, representationRevisionId: "different" }] };
    storage.rows.set("run/wayflow-task#2", old);
    await expect(emitDeclaredReviewGateFamily(familyInput())).rejects.toMatchObject({ code: "pin-conflict" });
    expect([...storage.rows.keys()]).toEqual(["run/wayflow-task#2"]);
    expect(storage.rows.get("run/wayflow-task#2")).toBe(old);
  });
  it("a witnessed missing leg recovers without rewriting its first exact gate", async () => {
    await emitDeclaredReviewGateFamily(familyInput());
    const first = storage.rows.get("run/wayflow-task")!;
    storage.rows.delete("run/wayflow-task#2");
    await emitDeclaredReviewGateFamily(familyInput());
    expect(storage.rows.get("run/wayflow-task")).toBe(first);
    expect(storage.rows.size).toBe(2);
  });
  it("an unreadable family inventory refuses before any insert", async () => {
    storage.setReadFailure(true);
    await expect(emitDeclaredReviewGateFamily(familyInput())).rejects.toThrow("inventory unreadable");
    expect(storage.inserts).toEqual([]);
    expect(storage.rows.size).toBe(0);
  });
  it.each(["missing-witness", "malformed-witness", "foreign", "extra-slot"])("an existing %s member refuses without rewriting", async corruption => {
    await emitDeclaredReviewGateFamily(familyInput());
    const old = storage.rows.get("run/wayflow-task#2")!;
    if (corruption === "missing-witness") delete (old.pinnedTargets[0] as { declaredReviewPlan?: unknown }).declaredReviewPlan;
    if (corruption === "malformed-witness") Object.assign(old.pinnedTargets[0], { declaredReviewPlan: {} });
    if (corruption === "foreign") old.orgId = "other";
    if (corruption === "extra-slot") storage.rows.set("run/wayflow-task#3", { ...old, reviewTaskId: "wayflow-task#3" });
    const before = JSON.stringify([...storage.rows]);
    await expect(emitDeclaredReviewGateFamily(familyInput())).rejects.toMatchObject({ code: "pin-conflict" });
    expect(JSON.stringify([...storage.rows])).toBe(before);
  });
  it("jsonb object-key ordering does not erase immutable membership", async () => {
    await emitDeclaredReviewGateFamily(familyInput());
    for (const row of storage.rows.values()) {
      const target = row.pinnedTargets[0] as typeof A & { declaredReviewPlan: { runId: string; orgId: string; baseTaskId: string; legs: Array<{reviewTaskId: string; targets: typeof A[]}> } };
      const p = target.declaredReviewPlan;
      Object.assign(target, { declaredReviewPlan: { legs: p.legs.map(leg => ({ targets: leg.targets.map(t => ({ representationRevisionId: t.representationRevisionId, artifactId: t.artifactId })), reviewTaskId: leg.reviewTaskId })), orgId: p.orgId, baseTaskId: p.baseTaskId, runId: p.runId } });
    }
    const before = JSON.stringify([...storage.rows]);
    await emitDeclaredReviewGateFamily(familyInput());
    expect(JSON.stringify([...storage.rows])).toBe(before);
  });

  it("a typed second-insert conflict after successful first insert rolls back the whole new set", async () => {
    const conflicting: StoredGate = { id: "conflicting", runId: "run", orgId: "org", reviewTaskId: "wayflow-task#2", status: "resolved",
      pinnedTargets: [{ ...B, representationRevisionId: "other" }] };
    // Storage boundary reports the unique conflict only when the second insert
    // reaches it, then serves its exact old row to the real conflict reader.
    storage.setLateConflict(conflicting);
    await expect(emitDeclaredReviewGateFamily(familyInput())).rejects.toMatchObject({ code: "pin-conflict" });
    expect(storage.inserts).toHaveLength(2);
    expect(storage.rows.size).toBe(0);
    expect(conflicting.pinnedTargets[0].representationRevisionId).toBe("other");
    storage.setLateConflict(null);
    await emitDeclaredReviewGateFamily(familyInput());
    expect(storage.rows.size).toBe(2);
  });

  it("caller-supplied target metadata cannot create or replace a server witness", async () => {
    await emitArtifactReviewGate(input([{ ...A, declaredReviewPlan: { orgId: "invented" } }]));
    expect(storage.rows.get("run/task")!.pinnedTargets).toEqual([A]);
    storage.rows.clear(); storage.inserts.length = 0;
    await emitDeclaredReviewGateFamily({ ...familyInput(), targets: [
      { ...A, declaredReviewPlan: { orgId: "invented" } }, B,
    ] });
    expect(storage.rows.get("run/wayflow-task")!.pinnedTargets[0]).toMatchObject({ declaredReviewPlan: { orgId: "org" } });
  });

});

describe("the attempt a review gate belongs to (cinatra#4762)", () => {
  // red-first-expect: to match object { code: 'publish_call_in_flight' }
  it("takes the run row before its insert and opens no review while a publishing call of the run is in flight (cinatra#4762)", async () => {
    // A publishing call read the review fence and took its released decision under the run row FOR UPDATE. This
    // review is written after: the store holds the run row FOR KEY SHARE first, reads the call's claim, and refuses.
    storage.setPublishCallInFlight(true);
    const refused: unknown = await emitArtifactReviewGate({ ...input([A]), runGeneration: 0 }).catch((err: unknown) => err);
    expect(refused).toMatchObject({ code: "publish_call_in_flight" });
    // Not a gate refusal: the run executor never falls back to another gate for it.
    expect(refused).not.toBeInstanceOf(gateStore.ArtifactReviewGateError);
    expect(storage.rows.size).toBe(0);
    expect(storage.statements.map((st) =>
      /for key share/.test(st.text) && st.insertsBefore === 0 ? "lock-before-insert"
        : /calls_in_flight > 0/.test(st.text) && st.insertsBefore === 1 ? "claim-read-after-insert" : st.text))
      .toEqual(["lock-before-insert", "claim-read-after-insert"]);
    // The claim only counts for the run's current attempt; once the call ends, the review opens.
    expect(storage.statements[1]!.text).toMatch(/coalesce\(call_claim\.run_generation, claim_run\.reset_generation\) = claim_run\.reset_generation/);
    storage.setPublishCallInFlight(false);
    expect((await emitArtifactReviewGate({ ...input([A]), runGeneration: 0 })).idempotent).toBe(false);
    expect(storage.rows.size).toBe(1);
    // A replay of an existing review writes nothing new, and stays idempotent even while a call is in flight.
    storage.setPublishCallInFlight(true);
    expect((await emitArtifactReviewGate({ ...input([A]), runGeneration: 0 })).idempotent).toBe(true);
  });

  // red-first-expect: to deeply equal [ 3, -1, -1 ]
  it("a gate raised for a produced event carries the producing attempt's generation, never the run's live state", async () => {
    // The delayed drain names the generation the event was written with; an event of an older build carries none, and
    // its gate is stamped -1, which no publish gate counts.
    await emitArtifactReviewGate({ ...input([A]), reviewTaskId: "produced-3", runGeneration: 3 });
    await emitArtifactReviewGate({ ...input([A]), reviewTaskId: "produced-old", runGeneration: null });
    await emitArtifactReviewGate({ ...input([A]), reviewTaskId: "produced-bad", runGeneration: 1.5 });
    expect(storage.generations).toEqual([3, -1, -1]);
  });

  // red-first-expect: to be -1 // Object.is equality
  it("a gate whose caller names no attempt is stamped -1: the run row is never read at the raise", async () => {
    // A delayed caller of an ended attempt would read the next attempt's generation there.
    await emitArtifactReviewGate({ ...input([A]), reviewTaskId: "own" });
    expect(storage.generations[0]).toBe(-1);
    // The executor names the attempt it serves.
    await emitArtifactReviewGate({ ...input([A]), reviewTaskId: "executor", runGeneration: 2 });
    expect(storage.generations[1]).toBe(2);
    // A continuation of a review (a failed verification's reopen, a repair's successor) takes the generation of the
    // gate it continues, read in the insert: an SQL expression, not a number, and it wins over a named generation.
    await emitArtifactReviewGate({ ...input([A]), reviewTaskId: "reopen", successorOfGateId: "gate-1", runGeneration: 5 });
    expect(typeof storage.generations[2]).toBe("object");
    expect(storage.generations[2]).not.toBeNull();
  });
});

describe("a successor of a review raised before the generation column (cinatra#4762)", () => {
  /** The statement text an SQL value renders to; a plain value renders as itself. */
  const rendered = async (value: unknown): Promise<string> => {
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const { SQL } = await import("drizzle-orm");
    return value instanceof SQL ? new PgDialect().sqlToQuery(value).sql.replace(/\s+/g, " ") : String(value);
  };

  // red-first-expect: to match /nullif\(coalesce\(\(select coalesce\(
  it("keeps no generation, as the review it continues: settled it reads as 0, open it holds every attempt; a foreign one is -1", async () => {
    // The review it continues has no stored generation (null): the successor is stored null too (the -2 marker inside
    // the read), so the publish gate reads it as that review: generation 0 once settled, so it can clear the change
    // request, and while open a review of an unknown attempt that holds every attempt's fence. A review this run does
    // not own still stamps -1.
    await emitArtifactReviewGate({ ...input([A]), reviewTaskId: "repair-successor", successorOfGateId: "gate-old" });
    expect(await rendered(storage.generations[0])).toMatch(
      /nullif\(coalesce\(\(select coalesce\(prior_gate\.run_generation, -2\) from \S+ prior_gate where prior_gate\.id = \$\d+ and prior_gate\.run_id = \$\d+\), -1\), -2\)/,
    );
  });

  // red-first-expect: to be null
  it("a review the drain raises for an output that names no attempt is stored with no generation (cinatra#4762)", async () => {
    await emitArtifactReviewGate({ ...input([A]), reviewTaskId: "auto-unknown", runGeneration: "unknown" as never });
    expect(storage.generations[0]).toBeNull();
  });
});

describe("an output of the attempt still waiting for the review orchestration (cinatra#4762)", () => {
  /** The WHERE clause the read hands to its executor, rendered as Postgres reads it. */
  const whereOf = async (generation: number) => {
    let where = "";
    let params: unknown[] = [];
    const executor = {
      select: () => ({ from: () => ({ where: (condition: SQL) => {
        const q = new PgDialect().sqlToQuery(condition);
        where = q.sql.replace(/\s+/g, " ");
        params = q.params;
        return { limit: async () => [] };
      } }) }),
    };
    const read = (gateStore as { hasPendingProducedEventForAttempt?: (input: unknown, executor: unknown) => Promise<boolean> })
      .hasPendingProducedEventForAttempt;
    if (read) await read({ orgId: "org", runId: "run", generation }, executor);
    return { where, params };
  };

  // red-first-expect: expected { nullCounts: false } to deeply equal { nullCounts: true }
  it("an event with no generation, written before the column existed, may be this attempt's: it counts for every attempt", async () => {
    const { where, params } = await whereOf(1);
    expect({ nullCounts: /\((\S+\.)?"artifact_produced_outbox"\."producer_run_generation" = \$\d+ or (\S+\.)?"artifact_produced_outbox"\."producer_run_generation" is null\)/.test(where) })
      .toEqual({ nullCounts: true });
    expect(params).toEqual(["pending", "org", "run", 1]);
  });
});
