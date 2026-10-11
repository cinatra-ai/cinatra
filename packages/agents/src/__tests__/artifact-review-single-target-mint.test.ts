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
  let readFailure = false;
  let lateConflict: StoredGate | null = null;
  let crashAfter: number | null = null;
  let readIdentity: { runId: string; reviewTaskId: string } | undefined;
  const key = (row: StoredGate) => `${row.runId}/${row.reviewTaskId}`;
  const executor = {
    async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      const before = new Map(rows);
      try { return await callback(executor); }
      catch (err) { rows.clear(); for (const [k, v] of before) rows.set(k, v); throw err; }
    },
    insert() {
      return {
        values(row: StoredGate) {
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
  return { rows, inserts, executor, setLateConflict(row: StoredGate | null) { lateConflict = row; }, setReadFailure(value: boolean) { readFailure = value; }, setCrashAfter(n: number | null) { crashAfter = n; }, setReadKey(row: StoredGate) { readIdentity = row; } };
});

vi.mock("../db", () => ({ db: storage.executor }));
vi.mock("../store", () => ({
  readAgentRunById: vi.fn(), readAgentTemplateById: vi.fn(), readRunCoOwners: vi.fn(),
}));
vi.mock("../auth-policy", () => ({ enforceRunAccess: vi.fn(), resolveEffectivePolicy: vi.fn() }));
vi.mock("../run-wait-notifier", () => ({ dispatchAutoGateResolved: vi.fn() }));
vi.mock("../run-produced-review-hold", () => ({ isParkedOnProducedReview: vi.fn(() => false) }));

import { emitArtifactReviewGate, emitDeclaredReviewGateFamily, readGatePinnedTargets } from "../artifact-review-gate-store";

const A = { artifactId: "post", representationRevisionId: "post-r1" };
const B = { artifactId: "image", representationRevisionId: "image-r1" };
const input = (targets: unknown) => ({ runId: "run", orgId: "org", reviewTaskId: "task", targets });

beforeEach(() => { storage.rows.clear(); storage.inserts.length = 0; storage.setCrashAfter(null); storage.setReadFailure(false); storage.setLateConflict(null); });

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
