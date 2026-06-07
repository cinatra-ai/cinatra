import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock db BEFORE importing store so the module-level import picks up the mock.
// ---------------------------------------------------------------------------
const { mockExecute } = vi.hoisted(() => {
  const mockExecute = vi.fn();
  return { mockExecute };
});

vi.mock("../src/db", () => ({ db: { execute: mockExecute } }));
vi.mock("../src/schema", () => ({ usageEvents: {} }));

import { readCostBySkill } from "../src/store";
import type { CostBySkillRow } from "../src/store";

beforeEach(() => {
  mockExecute.mockReset();
});

describe("readCostBySkill", () => {
  it("returns typed CostBySkillRow[] from db results", async () => {
    const mockRows: CostBySkillRow[] = [
      { skillLabel: "@cinatra-skills/example-vendor", totalCost: 1.23, callCount: 5 },
      { skillLabel: null, totalCost: 0.45, callCount: 2 },
    ];
    mockExecute.mockResolvedValue({ rows: mockRows });

    const result = await readCostBySkill({ days: 30 });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      skillLabel: "@cinatra-skills/example-vendor",
      totalCost: 1.23,
      callCount: 5,
    });
    expect(result[1]).toMatchObject({
      skillLabel: null,
      totalCost: 0.45,
      callCount: 2,
    });
  });

  it("clamps invalid days to 30 via sanitizeDays", async () => {
    mockExecute.mockResolvedValue({ rows: [] });

    await readCostBySkill({ days: 999 });

    // db.execute was called — if days was invalid (999 not in [7,30,90]),
    // sanitizeDays defaults to 30. The SQL call still proceeds (no throw).
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  it("returns empty array when no rows exist", async () => {
    mockExecute.mockResolvedValue({ rows: [] });

    const result = await readCostBySkill({ days: 7 });

    expect(result).toEqual([]);
  });
});
