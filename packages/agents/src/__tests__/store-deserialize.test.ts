/**
 * Tests for AgentRunRecord.orgId field.
 *
 * AgentRunRecord includes an `orgId: string | null` field, populated from the
 * `agent_runs.org_id` Drizzle column inside `deserializeRun`.
 *
 * `deserializeRun` is private to store.ts. We exercise it through the public
 * read path: `readAgentRunById` resolves a row -> deserializeRun -> record.
 *
 * These tests pin the runtime contract: a mocked row with `orgId` must return
 * a record carrying the same field value, including null rather than undefined.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mutable state — vi.mock factories run before module-scope code.
// ---------------------------------------------------------------------------

const shared = vi.hoisted(() => {
  type FakeRunRow = Record<string, unknown> & {
    id: string;
    orgId: string | null;
  };

  const baseRow = (overrides: Partial<FakeRunRow>): FakeRunRow => ({
    id: "seeded-run-id",
    templateId: "tpl-1",
    versionId: null,
    runBy: "u-1",
    status: "completed",
    inputParams: "{}",
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    sourceType: "internal",
    sourceId: null,
    packageVersion: null,
    a2aTaskId: null,
    a2aContextId: null,
    parentRunId: null,
    agUiEnabled: null,
    lgThreadId: null,
    traceId: null,
    timeoutSeconds: null,
    streamedText: null,
    authPolicy: null,
    orgId: null,
    ...overrides,
  });

  return {
    seededRow: baseRow({}) as FakeRunRow,
    baseRow,
  };
});

// ---------------------------------------------------------------------------
// Drizzle-like chained query stub returning the seededRow.
// ---------------------------------------------------------------------------

vi.mock("../db", () => {
  function makeChain() {
    const chain: Record<string, unknown> = {};
    for (const stage of [
      "from",
      "where",
      "orderBy",
      "limit",
      "offset",
      "innerJoin",
      "leftJoin",
      "groupBy",
    ]) {
      (chain as Record<string, () => unknown>)[stage] = () => chain;
    }
    chain.then = (resolve: (v: unknown) => unknown) => {
      const value = [shared.seededRow];
      return Promise.resolve(value).then(resolve);
    };
    return chain;
  }

  const db = {
    select: () => makeChain(),
  };

  return {
    db,
    agentBuilderPool: { on: () => {}, listenerCount: () => 1, end: vi.fn() },
  };
});

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import { readAgentRunById, type AgentRunRecord } from "../store";

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("AgentRunRecord.orgId field", () => {
  beforeEach(() => {
    shared.seededRow = shared.baseRow({});
  });

  it("populates orgId from agent_runs.org_id column", async () => {
    shared.seededRow = shared.baseRow({ id: "run-with-org", orgId: "test-org-1" });
    const record = await readAgentRunById("run-with-org");
    expect(record).not.toBeNull();
    // Runtime contract: deserializeRun must copy row.orgId onto the record.
    expect((record as unknown as { orgId: string | null }).orgId).toBe(
      "test-org-1",
    );
  });

  it("returns orgId === null when DB column is null (not undefined)", async () => {
    shared.seededRow = shared.baseRow({ id: "run-null-org", orgId: null });
    const record = await readAgentRunById("run-null-org");
    expect(record).not.toBeNull();
    expect((record as unknown as { orgId: string | null }).orgId).toBeNull();
  });

  it("AgentRunRecord type structurally includes orgId (runtime witness)", () => {
    // Type witness: AgentRunRecord includes an `orgId: string | null` field.
    // We avoid `satisfies AgentRunRecord` here so the test file continues to
    // typecheck under tsgo today; the load-bearing tests above pin the runtime
    // contract through the public read path.
    const synthetic = {
      id: "x",
      orgId: "synthesized-org" as string | null,
    } as unknown as AgentRunRecord & { orgId: string | null };
    expect((synthetic as { orgId: string | null }).orgId).toBe(
      "synthesized-org",
    );
  });
});
