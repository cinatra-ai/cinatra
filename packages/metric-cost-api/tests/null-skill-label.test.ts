import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Covers: historical rows with skill_label = NULL are queryable.
// ---------------------------------------------------------------------------
const { mockExecute } = vi.hoisted(() => {
  const mockExecute = vi.fn();
  return { mockExecute };
});

vi.mock("../src/db", () => ({ db: { execute: mockExecute } }));
vi.mock("../src/schema", () => ({ usageEvents: {} }));

import { readCostBySkill } from "../src/store";

beforeEach(() => {
  mockExecute.mockReset();
});

describe("readCostBySkill — NULL skill_label historical rows", () => {
  it("includes rows with skillLabel=null in results", async () => {
    mockExecute.mockResolvedValue({
      rows: [{ skillLabel: null, totalCost: 0.99, callCount: 12 }],
    });

    const result = await readCostBySkill({ days: 30 });

    expect(result).toHaveLength(1);
    expect(result[0].skillLabel).toBeNull();
    expect(result[0].totalCost).toBe(0.99);
    expect(result[0].callCount).toBe(12);
  });

  it("handles mixed attributed and unattributed rows", async () => {
    mockExecute.mockResolvedValue({
      rows: [
        { skillLabel: "@cinatra-skills/seo-writer", totalCost: 2.00, callCount: 8 },
        { skillLabel: null, totalCost: 0.50, callCount: 3 },
      ],
    });

    const result = await readCostBySkill({ days: 90 });

    const nullRow = result.find((r) => r.skillLabel === null);
    expect(nullRow).toBeDefined();
    expect(nullRow?.callCount).toBe(3);
  });
});
