/**
 * cinatra#4264 slice B1a: the PRODUCTION store write of a step snapshot,
 * `writeStepSnapshotRow`, over a stand-in of the database (review 1 NOTE 4).
 * The other snapshot tests inject an in-memory writer; this one runs the real
 * conflict rule: insert once per (run, node); an equal second value is a no-op;
 * the same bytes under ANOTHER flow version, or other bytes, mark the row
 * ambiguous.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { runId: string; nodeId: string; inputsSha256: string; flowSha256: string; ambiguous: boolean };

const h = vi.hoisted(() => {
  const state: { row: Row | null; updates: Array<Record<string, unknown>> } = { row: null, updates: [] };
  const db = {
    insert: () => ({
      values: (v: Omit<Row, "ambiguous">) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (state.row) return [];
            state.row = { ...v, ambiguous: false };
            return [{ nodeId: v.nodeId }];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            state.row ? [{ inputsSha256: state.row.inputsSha256, flowSha256: state.row.flowSha256 }] : [],
        }),
      }),
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push(s);
          if (state.row && s.ambiguous === true) state.row.ambiguous = true;
        },
      }),
    }),
  };
  return { state, db };
});

vi.mock("../db", () => ({ db: h.db }));
vi.mock("../schema", () => ({
  agentRunStepSnapshots: { runId: "run_id", nodeId: "node_id", inputsSha256: "inputs_sha256", flowSha256: "flow_sha256" },
}));
vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => parts,
  eq: (column: unknown, value: unknown) => [column, value],
}));

import { writeStepSnapshotRow, type StepSnapshotRow } from "../step-snapshots";

const A = "a".repeat(64);
const B = "b".repeat(64);
const S = "c".repeat(64);

function row(over: Partial<StepSnapshotRow> = {}): StepSnapshotRow {
  return { orgId: "org-1", runId: "R1", nodeId: "produce", inputsJson: "{}", inputsSha256: S, flowSha256: A, ...over };
}

describe("writeStepSnapshotRow: the production conflict rule", () => {
  beforeEach(() => {
    h.state.row = null;
    h.state.updates = [];
  });

  it("inserts once; an equal second value is a no-op", async () => {
    expect(await writeStepSnapshotRow(row())).toBe("inserted");
    expect(await writeStepSnapshotRow(row())).toBe("equal");
    expect(h.state.updates).toEqual([]);
    expect(h.state.row?.ambiguous).toBe(false);
  });

  it("the same bytes under another flow version mark the row ambiguous", async () => {
    expect(await writeStepSnapshotRow(row())).toBe("inserted");
    expect(await writeStepSnapshotRow(row({ flowSha256: B }))).toBe("ambiguous");
    expect(h.state.updates).toEqual([{ ambiguous: true }]);
    expect(h.state.row?.ambiguous).toBe(true);
  });

  it("other bytes under the same flow version mark the row ambiguous", async () => {
    expect(await writeStepSnapshotRow(row())).toBe("inserted");
    expect(await writeStepSnapshotRow(row({ inputsSha256: "d".repeat(64) }))).toBe("ambiguous");
    expect(h.state.row?.ambiguous).toBe(true);
  });
});
