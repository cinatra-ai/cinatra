// EVERY run-creation call site states its ANCHOR disposition (cinatra#2809, S3).
//
// The issue's sentence: "anchor coverage consumes `RUN_CREATION_CALL_SITES`
// (the canonical named inventory owned by the assignment substrate slice
// #2813) and pins an anchor/explicit-omission disposition for every entry …
// no second inventory is permitted."
//
// ADDITIVE ON PURPOSE. The inventory belongs to #2813; this suite adds a field
// and walks it, so a new run-creation call site cannot land without SAYING
// whether it anchors its run or deliberately does not.

import { describe, expect, it } from "vitest";

import {
  ANCHOR_DISPOSITIONS,
  RUN_CREATION_CALL_SITES,
} from "./run-creation-call-sites";

describe("the anchor disposition", () => {
  it("offers exactly two answers — anchored at the fence, or explicitly none", () => {
    expect([...ANCHOR_DISPOSITIONS].sort()).toEqual([
      "explicitly_unanchored",
      "threaded_from_launch",
    ]);
  });

  it("is stated by EVERY entry, and is one of the two", () => {
    expect(RUN_CREATION_CALL_SITES.length).toBeGreaterThan(0);
    for (const site of RUN_CREATION_CALL_SITES) {
      expect(ANCHOR_DISPOSITIONS).toContain(site.anchor);
      // Never an empty word: an entry that says nothing says nothing.
      expect(site.anchorWhy.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps #2813's own dispositions untouched", () => {
    for (const site of RUN_CREATION_CALL_SITES) {
      expect(site.snapshot).toBe("derived_at_store");
      expect(site.launchAnchor.length).toBeGreaterThan(0);
    }
  });

  it("routes BOTH primitives through the launch fence, which is where the anchor is threaded", () => {
    const modules = new Set(RUN_CREATION_CALL_SITES.map((s) => s.module));
    expect([...modules]).toEqual(["packages/agents/src/lifecycle-coordinator.ts"]);
    for (const site of RUN_CREATION_CALL_SITES) {
      expect(site.anchor).toBe("threaded_from_launch");
    }
  });
});
