// The durable human-approval gate store (cinatra#2748).
//
// `writeDurableHitlGateArtifact` / `readLatestDurableHitlGateArtifact` are the
// Postgres fallback for a gate whose Redis event-log frame expired. Both run
// raw parameterized SQL behind an injectable `query` seam, so the properties
// that matter are asserted here without a database:
//
//   - the write is ONE statement, an UPSERT on the gate identity
//     (run_id, review_task_id), so a re-park never adds a second row;
//   - the upsert is MONOTONIC on `materialized_at`, so a late-landing re-emit of
//     an older artifact can never overwrite a newer one;
//   - the read takes the NEWEST row for the run — the gate it is parked on.
//
// The real-database proof of the same properties is the sibling
// `durable-hitl-gate-store.integration.test.ts`.
//
//   cd packages/agents && pnpm exec vitest run \
//     src/__tests__/durable-hitl-gate-store.test.ts
import { describe, expect, it, vi } from "vitest";

import {
  readLatestDurableHitlGateArtifact,
  writeDurableHitlGateArtifact,
} from "../store";

/** Collapse SQL whitespace so assertions read on one line. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

function queryDouble(rows: unknown[] = []) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (text: string, values: readonly unknown[]) => {
    calls.push({ text, values });
    return rows;
  }) as unknown as <T>(text: string, values: readonly unknown[]) => Promise<T[]>;
  return { query, calls };
}

const ARTIFACT = {
  runId: "run-2748",
  reviewTaskId: "wayflow-task-a",
  xRenderer: "@cinatra-ai/agent-builder:schema-field-fallback",
  inputSchema: { type: "object", properties: { brief: { type: "string" } } },
  values: { brief: "draft" },
} as const;

describe("writeDurableHitlGateArtifact", () => {
  it("upserts on the gate identity so a re-park never duplicates a row", async () => {
    const { query, calls } = queryDouble();

    await writeDurableHitlGateArtifact(ARTIFACT, { query });
    await writeDurableHitlGateArtifact(ARTIFACT, { query });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const sql = flat(call.text);
      expect(sql).toContain("INSERT INTO");
      expect(sql).toContain("agent_run_hitl_gates");
      expect(sql).toContain("ON CONFLICT (run_id, review_task_id) DO UPDATE SET");
    }
  });

  it("guards the update so an older artifact never replaces a newer one", async () => {
    const { query, calls } = queryDouble();

    await writeDurableHitlGateArtifact(ARTIFACT, { query });

    expect(flat(calls[0]!.text)).toContain(
      "WHERE agent_run_hitl_gates.materialized_at < EXCLUDED.materialized_at",
    );
  });

  it("stamps the write with the injected clock and carries the whole artifact", async () => {
    const { query, calls } = queryDouble();
    const now = new Date("2026-08-15T10:00:00.000Z");

    await writeDurableHitlGateArtifact({ ...ARTIFACT, fieldName: "brief" }, { query, now: () => now });

    expect(calls[0]!.values).toEqual([
      "run-2748",
      "wayflow-task-a",
      ARTIFACT.xRenderer,
      JSON.stringify(ARTIFACT.inputSchema),
      JSON.stringify(ARTIFACT.values),
      "brief",
      now,
    ]);
  });

  it("stores a null field name for a gate that declares none", async () => {
    const { query, calls } = queryDouble();

    await writeDurableHitlGateArtifact(ARTIFACT, { query });

    expect(calls[0]!.values[5]).toBeNull();
  });
});

describe("readLatestDurableHitlGateArtifact", () => {
  it("asks for the newest row for the run", async () => {
    const { query, calls } = queryDouble();

    await readLatestDurableHitlGateArtifact("run-2748", { query });

    const sql = flat(calls[0]!.text);
    expect(sql).toContain("agent_run_hitl_gates");
    expect(sql).toContain("WHERE run_id = $1");
    expect(sql).toContain("ORDER BY materialized_at DESC");
    expect(sql).toContain("LIMIT 1");
    expect(calls[0]!.values).toEqual(["run-2748"]);
  });

  it("maps a stored row back into the renderable artifact", async () => {
    const { query } = queryDouble([
      {
        run_id: "run-2748",
        review_task_id: "wayflow-task-a",
        x_renderer: ARTIFACT.xRenderer,
        input_schema: ARTIFACT.inputSchema,
        gate_values: ARTIFACT.values,
        field_name: "brief",
      },
    ]);

    await expect(readLatestDurableHitlGateArtifact("run-2748", { query })).resolves.toEqual({
      runId: "run-2748",
      reviewTaskId: "wayflow-task-a",
      xRenderer: ARTIFACT.xRenderer,
      inputSchema: ARTIFACT.inputSchema,
      values: ARTIFACT.values,
      fieldName: "brief",
    });
  });

  it("omits the field name when the stored row carries none", async () => {
    const { query } = queryDouble([
      {
        run_id: "run-2748",
        review_task_id: "wayflow-task-a",
        x_renderer: ARTIFACT.xRenderer,
        input_schema: {},
        gate_values: {},
        field_name: null,
      },
    ]);

    const row = await readLatestDurableHitlGateArtifact("run-2748", { query });

    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty("fieldName");
  });

  it("returns null when the run has no durable gate", async () => {
    const { query } = queryDouble([]);

    await expect(readLatestDurableHitlGateArtifact("run-2748", { query })).resolves.toBeNull();
  });
});
