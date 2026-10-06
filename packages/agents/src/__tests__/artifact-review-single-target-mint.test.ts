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
  let readIdentity: { runId: string; reviewTaskId: string } | undefined;
  const key = (row: StoredGate) => `${row.runId}/${row.reviewTaskId}`;
  const executor = {
    insert() {
      return {
        values(row: StoredGate) {
          readIdentity = row;
          inserts.push(row);
          return {
            onConflictDoNothing() {
              return {
                async returning() {
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
                async limit() {
                  return readIdentity ? [rows.get(`${readIdentity.runId}/${readIdentity.reviewTaskId}`)].filter(Boolean) : [];
                },
              };
            },
          };
        },
      };
    },
  };
  return { rows, inserts, executor, setReadKey(row: StoredGate) { readIdentity = row; } };
});

vi.mock("../db", () => ({ db: storage.executor }));
vi.mock("../store", () => ({
  readAgentRunById: vi.fn(), readAgentTemplateById: vi.fn(), readRunCoOwners: vi.fn(),
}));
vi.mock("../auth-policy", () => ({ enforceRunAccess: vi.fn(), resolveEffectivePolicy: vi.fn() }));
vi.mock("../run-wait-notifier", () => ({ dispatchAutoGateResolved: vi.fn() }));
vi.mock("../run-produced-review-hold", () => ({ isParkedOnProducedReview: vi.fn(() => false) }));

import { emitArtifactReviewGate, readGatePinnedTargets } from "../artifact-review-gate-store";

const A = { artifactId: "post", representationRevisionId: "post-r1" };
const B = { artifactId: "image", representationRevisionId: "image-r1" };
const input = (targets: unknown) => ({ runId: "run", orgId: "org", reviewTaskId: "task", targets });

beforeEach(() => { storage.rows.clear(); storage.inserts.length = 0; });

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
