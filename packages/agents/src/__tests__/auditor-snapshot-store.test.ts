/**
 * auditor-snapshot-store (cinatra#1625) — snapshot hash + write fail-closed
 * semantics.
 *
 * Run: pnpm exec vitest run packages/agents/src/__tests__/auditor-snapshot-store.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const dbState = vi.hoisted(() => ({
  insertReturns: [] as unknown[],
  selectReturns: [] as unknown[],
}));

vi.mock("../db", () => ({
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => dbState.insertReturns,
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => dbState.selectReturns }),
      }),
    }),
  },
}));

import {
  computeSnapshotHash,
  computeInputDigest,
  writeProposalSnapshot,
} from "../auditor-snapshot-store";
import { AuditorSnapshotError } from "../auditor-snapshot-errors";

const preview = { name: "n", description: "d", content: "c", patches: [] };
const patches = [
  { id: "p1", fieldPath: "/a", op: "replace" as const, value: "1", message: "m1" },
  { id: "p2", fieldPath: "/b", op: "add" as const, value: "2", message: "m2" },
];

beforeEach(() => {
  dbState.insertReturns = [];
  dbState.selectReturns = [];
});

describe("computeSnapshotHash / computeInputDigest", () => {
  it("snapshot hash is deterministic and key-order-independent", () => {
    const h1 = computeSnapshotHash(preview, patches);
    const h2 = computeSnapshotHash({ description: "d", content: "c", name: "n", patches: [] }, patches);
    expect(h1).toBe(h2);
  });
  it("input digest changes when the audited data changes", () => {
    expect(computeInputDigest({ a: 1 })).not.toBe(computeInputDigest({ a: 2 }));
  });
});

describe("writeProposalSnapshot", () => {
  it("fails closed on duplicate patch ids (malformed_snapshot)", async () => {
    await expect(
      writeProposalSnapshot({
        agentRunId: "run-1",
        preview,
        patches: [patches[0], { ...patches[0] }],
        inputData: {},
        edited: "edited",
      }),
    ).rejects.toBeInstanceOf(AuditorSnapshotError);
  });

  it("fails closed on a blank patch id", async () => {
    await expect(
      writeProposalSnapshot({
        agentRunId: "run-1",
        preview,
        patches: [{ id: "", fieldPath: "/a", op: "replace", value: "1", message: "m" }],
        inputData: {},
        edited: "edited",
      }),
    ).rejects.toBeInstanceOf(AuditorSnapshotError);
  });

  it("returns the inserted snapshot on a fresh write", async () => {
    dbState.insertReturns = [
      {
        id: "s1",
        agentRunId: "run-1",
        preview,
        patches,
        patchIds: ["p1", "p2"],
        inputDataDigest: computeInputDigest({ a: 1 }),
        snapshotHash: computeSnapshotHash(preview, patches),
        edited: "edited",
        createdAt: new Date(),
      },
    ];
    const snap = await writeProposalSnapshot({
      agentRunId: "run-1",
      preview,
      patches,
      inputData: { a: 1 },
      edited: "edited",
    });
    expect(snap.patchIds).toEqual(["p1", "p2"]);
  });

  it("idempotent retry: same digest returns the stored snapshot on conflict", async () => {
    const digest = computeInputDigest({ a: 1 });
    dbState.insertReturns = []; // conflict → no insert
    dbState.selectReturns = [
      {
        id: "s1",
        agentRunId: "run-1",
        preview,
        patches,
        patchIds: ["p1", "p2"],
        inputDataDigest: digest,
        snapshotHash: computeSnapshotHash(preview, patches),
        edited: "edited",
        createdAt: new Date(),
      },
    ];
    const snap = await writeProposalSnapshot({
      agentRunId: "run-1",
      preview,
      patches,
      inputData: { a: 1 },
      edited: "edited",
    });
    expect(snap.id).toBe("s1");
  });

  it("fails closed (snapshot_conflict) when an existing snapshot has a different digest", async () => {
    dbState.insertReturns = []; // conflict
    dbState.selectReturns = [
      {
        id: "s1",
        agentRunId: "run-1",
        preview,
        patches,
        patchIds: ["p1", "p2"],
        inputDataDigest: "DIFFERENT-DIGEST",
        snapshotHash: computeSnapshotHash(preview, patches),
        edited: "edited",
        createdAt: new Date(),
      },
    ];
    await expect(
      writeProposalSnapshot({ agentRunId: "run-1", preview, patches, inputData: { a: 999 }, edited: "edited" }),
    ).rejects.toBeInstanceOf(AuditorSnapshotError);
  });
});
