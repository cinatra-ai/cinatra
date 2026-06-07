/**
 * Unit tests for AgentTemplateRecord deserialization of the durable,
 * hitl_required, and execution_provider flag columns.
 *
 * These tests are pure-logic (no DB); they synthesize row objects and exercise
 * the deserializeTemplate normalization contract directly.
 *
 * Coverage for the agent_runs.lg_thread_id column: schema declares the column
 * and AgentRunRecord exposes lgThreadId on the read side.
 */
import { describe, it, expect } from "vitest";

import { deserializeTemplate } from "../store";
import { agentRuns } from "../schema";
import type { AgentRunRecord } from "../store";

function makeRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: "tpl_1",
    orgId: null,
    creatorId: null,
    name: "Test",
    description: null,
    sourceNl: "x",
    compiledPlan: JSON.stringify([]),
    inputSchema: JSON.stringify({}),
    outputSchema: null,
    approvalPolicy: JSON.stringify({ steps: [] }),
    status: "draft",
    type: "leaf",
    taskSpec: null,
    packageName: null,
    packageVersion: null,
    currentVersionId: null,
    hitlScreens: null,
    agentDependencies: null,
    ioSpec: null,
    durable: null,
    hitlRequired: null,
    executionProvider: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("deserializeTemplate — flag normalization", () => {
  it("null flag columns → runtime defaults", () => {
    const rec = deserializeTemplate(makeRow());
    expect(rec.durable).toBe(false);
    expect(rec.hitlRequired).toBe(false);
    expect(rec.executionProvider).toBe("default");
  });

  it("true/true/openai round-trip", () => {
    const rec = deserializeTemplate(
      makeRow({ durable: true, hitlRequired: true, executionProvider: "openai" }),
    );
    expect(rec.durable).toBe(true);
    expect(rec.hitlRequired).toBe(true);
    expect(rec.executionProvider).toBe("openai");
  });

  it("unknown provider string normalizes to 'default'", () => {
    const rec = deserializeTemplate(
      makeRow({ executionProvider: "notAProvider" }),
    );
    expect(rec.executionProvider).toBe("default");
  });

  it("all known provider literals round-trip", () => {
    for (const p of ["openai", "anthropic", "gemini", "langgraph", "wayflow", "default"] as const) {
      const rec = deserializeTemplate(makeRow({ executionProvider: p }));
      expect(rec.executionProvider).toBe(p);
    }
  });
});

describe("agent_runs.lg_thread_id schema + type surface", () => {
  it("Drizzle agentRuns table declares a lgThreadId column", () => {
    // Column is present on the table object. Drizzle table columns are
    // exposed on the runtime object keyed by their JS property name.
    // We verify existence — the underlying DB column name check happens
    // in the live-DB task.
    expect(agentRuns).toHaveProperty("lgThreadId");
  });

  it("AgentRunRecord type permits lgThreadId: string | null", () => {
    // Type-only assertion: construct a record literal and ensure compilation
    // accepts both a string and null for lgThreadId. If the field is missing
    // from the type, this file fails to type-check under `tsc --noEmit`.
    const withString: Pick<AgentRunRecord, "lgThreadId"> = { lgThreadId: "thr_abc" };
    const withNull: Pick<AgentRunRecord, "lgThreadId"> = { lgThreadId: null };
    expect(withString.lgThreadId).toBe("thr_abc");
    expect(withNull.lgThreadId).toBeNull();
  });
});
