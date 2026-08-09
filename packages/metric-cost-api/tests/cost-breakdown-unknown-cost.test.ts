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

import {
  formatUsd,
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
