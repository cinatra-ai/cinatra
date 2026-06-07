/**
 * Unit tests for run-duration estimation.
 *
 * Three tiers for run-duration estimation:
 *   - Tier 1 (history): aggregate p50/p90 from completed agent_runs
 *   - Tier 2 (LLM analysis): runDeterministicLlmTask on compiled OAS + SKILL.md
 *   - Tier 3 (start-only): dynamic agents get null
 *
 * Combined entry point estimateRunDuration() picks the best available tier.
 *
 * The DB is mocked via the same fluent-chain pattern used by
 * store-external-templates.test.ts. The LLM module is mocked via vi.mock at
 * file scope (vitest hoists vi.mock above imports).
 *
 * Invoke explicitly:
 *   pnpm exec vitest run src/__tests__/trigger-duration-estimate.test.ts
 * from packages/agent-builder/.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (must be declared before importing the module under test).
// vitest hoists `vi.mock` calls above the imports so the mocks are in place
// when the module under test resolves its dependencies.
// ---------------------------------------------------------------------------

// In-memory state for the mocked DB. Tests reset this in beforeEach.
const dbState = vi.hoisted(() => ({
  // rows returned by the next `select().from(agentRuns).where(...)` chain
  rows: [] as Array<{ startedAt: Date | null; completedAt: Date | null }>,
}));

const mockDb = vi.hoisted(() => {
  const selectChain = {
    from: () => selectChain,
    where: async () => dbState.rows,
    then: (onFulfilled: (value: unknown[]) => unknown) =>
      Promise.resolve(dbState.rows).then(onFulfilled),
  };
  return {
    select: () => selectChain,
  };
});

vi.mock("../db", () => ({
  db: mockDb,
  agentBuilderPool: { on: () => {}, listenerCount: () => 1 },
}));

// Mock the LLM orchestration module. The default export returns "{}" — tests
// override per-case via mockResolvedValueOnce / mockRejectedValueOnce.
const llmMock = vi.hoisted(() => ({
  runDeterministicLlmTask: vi.fn(async (_input: unknown) => ({ content: "{}" })),
}));

vi.mock("@cinatra-ai/llm", () => llmMock);

// Now import the module under test. This must come AFTER vi.mock calls.
import {
  estimateFromHistory,
  estimateFromCompiledOas,
  estimateRunDuration,
  type DurationEstimate,
} from "../trigger-duration-estimate";

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  dbState.rows = [];
  llmMock.runDeterministicLlmTask.mockReset();
  // Default: returns the smallest valid envelope
  llmMock.runDeterministicLlmTask.mockResolvedValue({ content: "{}" });
});

// ---------------------------------------------------------------------------
// Tier 1 — estimateFromHistory
// ---------------------------------------------------------------------------

describe("estimateFromHistory — Tier 1 (aggregate from completed agent_runs)", () => {
  it("returns null when there are zero completed runs", async () => {
    dbState.rows = [];
    const result = await estimateFromHistory("tmpl-1");
    expect(result).toBeNull();
  });

  it("returns null when there are 2 completed runs (below the 3-run minimum)", async () => {
    const now = Date.now();
    dbState.rows = [
      { startedAt: new Date(now - 60_000), completedAt: new Date(now - 30_000) },
      { startedAt: new Date(now - 50_000), completedAt: new Date(now - 20_000) },
    ];
    const result = await estimateFromHistory("tmpl-1");
    expect(result).toBeNull();
  });

  it("returns a DurationEstimate with source=history when 5 completed runs exist", async () => {
    // 5 runs of 60, 90, 120, 150, 180 seconds total
    const now = Date.now();
    const durations = [60, 90, 120, 150, 180]; // seconds
    dbState.rows = durations.map((sec) => ({
      startedAt: new Date(now - sec * 1000),
      completedAt: new Date(now),
    }));

    const result = await estimateFromHistory("tmpl-1");

    expect(result).not.toBeNull();
    expect(result!.source).toBe("history");
    expect(result!.runCount).toBe(5);
    expect(typeof result!.p50Seconds).toBe("number");
    expect(typeof result!.p90Seconds).toBe("number");
    // 80/20 prep/gated split must be reflected in the breakdown.
    expect(result!.prepMinSeconds).toBeGreaterThan(0);
    expect(result!.prepMaxSeconds).toBeGreaterThan(0);
    expect(result!.gatedMinSeconds).toBeGreaterThan(0);
    expect(result!.gatedMaxSeconds).toBeGreaterThan(0);
    // Confidence buckets: <6 = "low", 6-11 = "medium", >=12 = "high".
    expect(result!.confidence).toBe("low");
    // computedAt is an ISO timestamp.
    expect(result!.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("ignores runs missing startedAt or completedAt (defensive against bad data)", async () => {
    const now = Date.now();
    // 2 valid runs + 2 with null timestamps → only 2 valid, below threshold → null
    dbState.rows = [
      { startedAt: new Date(now - 60_000), completedAt: new Date(now) },
      { startedAt: new Date(now - 90_000), completedAt: new Date(now) },
      { startedAt: null, completedAt: new Date(now) },
      { startedAt: new Date(now - 50_000), completedAt: null },
    ];
    const result = await estimateFromHistory("tmpl-1");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — estimateFromCompiledOas
// ---------------------------------------------------------------------------

describe("estimateFromCompiledOas — Tier 2 (LLM analysis of compiled OAS + SKILL.md)", () => {
  it("parses a valid JSON envelope and returns a DurationEstimate with source=llm-analysis", async () => {
    llmMock.runDeterministicLlmTask.mockResolvedValueOnce({
      content: JSON.stringify({
        prepMinSeconds: 300,
        prepMaxSeconds: 600,
        gatedMinSeconds: 60,
        gatedMaxSeconds: 120,
        confidence: "medium",
        notes: "assumes batch API",
      }),
    });

    const result = await estimateFromCompiledOas({
      compiledOas: { triggerMode: "full", gatedSteps: [{ id: "send-1" }] },
      skillMd: "# Skill\nSends emails.",
    });

    expect(result).not.toBeNull();
    expect(result!.source).toBe("llm-analysis");
    expect(result!.prepMinSeconds).toBe(300);
    expect(result!.prepMaxSeconds).toBe(600);
    expect(result!.gatedMinSeconds).toBe(60);
    expect(result!.gatedMaxSeconds).toBe(120);
    expect(result!.confidence).toBe("medium");
    expect(result!.notes).toBe("assumes batch API");
    expect(result!.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // History-only fields must be undefined for source=llm-analysis
    expect(result!.runCount).toBeUndefined();
    expect(result!.p50Seconds).toBeUndefined();
    expect(result!.p90Seconds).toBeUndefined();
  });

  it("returns null on malformed JSON (graceful degradation)", async () => {
    llmMock.runDeterministicLlmTask.mockResolvedValueOnce({
      content: "this is not JSON at all <<>>",
    });

    const result = await estimateFromCompiledOas({
      compiledOas: { triggerMode: "full", gatedSteps: [] },
      skillMd: "# Skill",
    });
    expect(result).toBeNull();
  });

  it("returns null on missing required numeric fields (defensive parse)", async () => {
    llmMock.runDeterministicLlmTask.mockResolvedValueOnce({
      content: JSON.stringify({ prepMinSeconds: 10, confidence: "low" }), // missing 3 fields
    });
    const result = await estimateFromCompiledOas({
      compiledOas: { triggerMode: "full", gatedSteps: [] },
      skillMd: "# Skill",
    });
    expect(result).toBeNull();
  });

  it("returns null when runDeterministicLlmTask rejects", async () => {
    llmMock.runDeterministicLlmTask.mockRejectedValueOnce(new Error("network down"));
    const result = await estimateFromCompiledOas({
      compiledOas: { triggerMode: "full", gatedSteps: [] },
      skillMd: "# Skill",
    });
    expect(result).toBeNull();
  });

  it("rejects non-finite numeric values (NaN, Infinity)", async () => {
    llmMock.runDeterministicLlmTask.mockResolvedValueOnce({
      content: JSON.stringify({
        prepMinSeconds: "NaN",
        prepMaxSeconds: 600,
        gatedMinSeconds: 60,
        gatedMaxSeconds: 120,
      }),
    });
    const result = await estimateFromCompiledOas({
      compiledOas: { triggerMode: "full", gatedSteps: [] },
      skillMd: "# Skill",
    });
    expect(result).toBeNull();
  });

  it("whitelists confidence values; unknown strings fall back to 'low'", async () => {
    llmMock.runDeterministicLlmTask.mockResolvedValueOnce({
      content: JSON.stringify({
        prepMinSeconds: 10,
        prepMaxSeconds: 20,
        gatedMinSeconds: 5,
        gatedMaxSeconds: 8,
        confidence: "ULTRA_HIGH", // not in the whitelist
      }),
    });
    const result = await estimateFromCompiledOas({
      compiledOas: { triggerMode: "full", gatedSteps: [] },
      skillMd: "# Skill",
    });
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Combined — estimateRunDuration
// ---------------------------------------------------------------------------

describe("estimateRunDuration — combined entry point", () => {
  it("returns null for triggerMode='start-only' (Tier 3 — dynamic agents)", async () => {
    const result = await estimateRunDuration({
      template: { id: "tmpl-1" },
      compiledOas: { triggerMode: "start-only" },
    });
    expect(result).toBeNull();
    // The LLM must NOT be consulted for start-only agents.
    expect(llmMock.runDeterministicLlmTask).not.toHaveBeenCalled();
  });

  it("prefers Tier 1 (history) when at least 3 completed runs exist", async () => {
    const now = Date.now();
    dbState.rows = [60, 90, 120, 150, 180].map((sec) => ({
      startedAt: new Date(now - sec * 1000),
      completedAt: new Date(now),
    }));

    const result = await estimateRunDuration({
      template: { id: "tmpl-1" },
      compiledOas: { triggerMode: "full" },
      skillMd: "# Skill",
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe("history");
    // The LLM must NOT be consulted when history is sufficient.
    expect(llmMock.runDeterministicLlmTask).not.toHaveBeenCalled();
  });

  it("falls back to Tier 2 (LLM) when history is insufficient and triggerMode='full'", async () => {
    dbState.rows = []; // no history at all
    llmMock.runDeterministicLlmTask.mockResolvedValueOnce({
      content: JSON.stringify({
        prepMinSeconds: 100,
        prepMaxSeconds: 200,
        gatedMinSeconds: 30,
        gatedMaxSeconds: 60,
        confidence: "medium",
        notes: "initial estimate",
      }),
    });

    const result = await estimateRunDuration({
      template: { id: "tmpl-1" },
      compiledOas: { triggerMode: "full" },
      skillMd: "# Skill\nDoes things.",
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe("llm-analysis");
    expect(result!.prepMinSeconds).toBe(100);
    expect(llmMock.runDeterministicLlmTask).toHaveBeenCalledTimes(1);
  });

  it("returns null when triggerMode='full' but no skillMd is provided (cannot run Tier 2)", async () => {
    dbState.rows = []; // no history
    const result = await estimateRunDuration({
      template: { id: "tmpl-1" },
      compiledOas: { triggerMode: "full" },
      // no skillMd provided
    });
    expect(result).toBeNull();
    expect(llmMock.runDeterministicLlmTask).not.toHaveBeenCalled();
  });

  it("returns null when triggerMode is undefined and history is empty (defaults to full but Tier 2 needs skillMd)", async () => {
    dbState.rows = [];
    const result = await estimateRunDuration({
      template: { id: "tmpl-1" },
      compiledOas: {}, // no triggerMode
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Type-level guarantee
// ---------------------------------------------------------------------------

describe("DurationEstimate type contract", () => {
  it("includes the full required field set when source=llm-analysis", async () => {
    llmMock.runDeterministicLlmTask.mockResolvedValueOnce({
      content: JSON.stringify({
        prepMinSeconds: 1,
        prepMaxSeconds: 2,
        gatedMinSeconds: 3,
        gatedMaxSeconds: 4,
        confidence: "high",
        notes: "type test",
      }),
    });
    const result = await estimateFromCompiledOas({
      compiledOas: {},
      skillMd: "x",
    });
    const typed: DurationEstimate | null = result;
    expect(typed).not.toBeNull();
    expect(typed!.prepMinSeconds).toBe(1);
  });
});
