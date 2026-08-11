/**
 * cinatra#2582 — the provider breakdown never turns "unknown" into a number.
 *
 * The breakdown SUMs `cost_usd`, which is NULL for any row the ledger cannot
 * price: a model with no rate card, and now the knowledge-graph indexer, whose
 * per-episode OpenAI fan-out is real spend the pinned wrapper never reports.
 * The cell used to render those as `$0.0000`, which reads as "this was free" —
 * a stronger claim than "we do not know", and exactly the kind of quiet
 * overstatement this issue exists to remove.
 *
 * The count column carries the same hazard in the other direction: one Graphiti
 * episode is NOT one provider call, so a bare number under a "Calls" heading
 * would understate the request volume by an unknown multiple.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  formatUsd,
  formatCostCell,
  describeUnit,
  describeModel,
} from "../src/components/cost-by-provider-table";

describe("an unpriced row says so", () => {
  it("renders a NULL cost as unknown, not as zero dollars", () => {
    expect(formatUsd(null)).toBe("unknown");
    expect(formatUsd(undefined as unknown as null)).toBe("unknown");
  });

  it("still renders a real zero as a real zero", () => {
    // A genuinely $0 row (a fully cached turn) is a measured fact and must not
    // be laundered into "unknown".
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(1.23456789)).toBe("$1.2346");
  });
});

describe("a MIXED group cannot pass its subtotal off as a total (cinatra#2641)", () => {
  // The laundering path a per-row NULL does not close: `SUM(cost_usd)` IGNORES
  // NULLs, so one priced row next to one unpriced row answers with a number.
  // Before this, the cell printed that number and nothing said what it omitted.
  it("states the unpriced remainder next to the subtotal", () => {
    expect(formatCostCell(1.2345, 2)).toBe("$1.2345 + 2 unknown-cost rows");
    // Singular reads as a sentence, not as a template artefact.
    expect(formatCostCell(1.2345, 1)).toBe("$1.2345 + 1 unknown-cost row");
  });

  it("says plain unknown when the group has no priced row at all", () => {
    expect(formatCostCell(null, 3)).toBe("unknown");
  });

  it("stays a bare amount when everything in the group is priced", () => {
    expect(formatCostCell(1.2345, 0)).toBe("$1.2345");
    // A genuinely $0 group is a measured fact and keeps saying so.
    expect(formatCostCell(0, 0)).toBe("$0.0000");
    // A NULL total with no unpriced count is the pre-#2641 empty-group shape.
    expect(formatCostCell(null, 0)).toBe("unknown");
  });
});

describe("every breakdown tab says unknown the same way (cinatra#2641)", () => {
  // The by-agent and by-skill tabs each carried their OWN formatter whose null
  // branch printed "$0.00". That was survivable while unpriced rows had no
  // agent — the Graphiti rows carry none — but cinatra#2641 puts a NAMED agent
  // behind unpriced spend for the first time: `blog-post-image`, one row per
  // billed image. Its tab would have announced a price of $0.00 for spend
  // nobody has measured.
  const componentSource = (name: string): string =>
    readFileSync(
      path.join(__dirname, "..", "src", "components", `${name}.tsx`),
      "utf8",
    );

  for (const name of ["cost-by-agent-table", "cost-by-skill-table"]) {
    it(`${name} uses the shared formatter and declares no $0.00 fallback`, () => {
      const text = componentSource(name);
      expect(text).toContain('from "./cost-by-provider-table"');
      expect(text).toContain("formatCostCell(row.totalCost, row.unknownCostCount)");
      // No zero-dollar fallback in the CODE (the prose above may name it).
      expect(text).not.toMatch(/return\s*`?"?\$0\.00/);
      // …and no privately redeclared formatter to drift away from the shared one.
      expect(text).not.toMatch(/function\s+formatUsd/);
    });
  }
});

describe("a row says what it counts", () => {
  it("labels knowledge-graph counts as EPISODES, not calls", () => {
    expect(describeUnit("graphiti", 42)).toBe("42 episodes");
    // One episode fans out to an unknown number of provider requests, so the
    // number under "Calls" would otherwise be read as a request count.
    expect(describeUnit("llm", 42)).toBe("42");
  });

  it("names the knowledge-graph rows instead of showing an empty model", () => {
    expect(describeModel("graphiti", null)).toContain("knowledge-graph episodes");
    expect(describeModel("graphiti", null)).toContain("not reported");
    expect(describeModel("llm", null)).toBe("(unknown)");
    expect(describeModel("llm", "gpt-5.5")).toBe("gpt-5.5");
  });
});
