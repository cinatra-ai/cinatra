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

describe("writeProposalSnapshot — RETIRED (cinatra#2570, epic #2564 S6a)", () => {
  // The run-scoped writer no longer writes. `/api/auditor/apply` — this store's
  // only reader — was deleted with the receipt path (#2047 row 8), so the
  // snapshot was being persisted for nobody; suggestions are now minted
  // GATE-BOUND against the pinned revision by
  // `lifecycle-suggestion-producer-lane`.
  //
  // These are the RUNTIME half of the "zero writes to
  // `auditor_proposal_snapshots` after cutover" acceptance criterion (the grep
  // half lives in
  // `src/lib/__tests__/legacy-auditor-proposal-writer-retired.test.ts`). The
  // symbol is deliberately kept and made to throw: a deleted function is a
  // compile error today and an easy re-implementation tomorrow, whereas a
  // refusing one fails loudly for whatever path finds its way back here.

  it("refuses with `legacy_writer_retired` instead of writing", async () => {
    await expect(
      writeProposalSnapshot({
        agentRunId: "run-1",
        preview,
        patches,
        inputData: { a: 1 },
        edited: "edited",
      }),
    ).rejects.toMatchObject({ name: "AuditorSnapshotError", code: "legacy_writer_retired" });
  });

  it("refuses BEFORE touching the database — the insert stub is never reached", async () => {
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
    await expect(
      writeProposalSnapshot({
        agentRunId: "run-1",
        preview,
        patches,
        inputData: { a: 1 },
        edited: "edited",
      }),
    ).rejects.toBeInstanceOf(AuditorSnapshotError);
    // A write that had landed would have consumed the stubbed insert result.
    expect(dbState.insertReturns).toHaveLength(1);
  });

  it("refuses a well-formed call exactly as it refuses a malformed one — there is no accepted shape any more", async () => {
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
});
