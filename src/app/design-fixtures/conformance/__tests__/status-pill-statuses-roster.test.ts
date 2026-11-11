// The conformance harness renders one StatusPill per entry of
// CONFORMANCE_STATUS_PILL_STATUSES (page.tsx, the status-pills surface), and
// the contract asserts each one. The application drawing's pill roster
// (specs/app.html) draws Withdrawn and Reset, the two idle-family pills the
// marketplace approval states add (block V.1, cinatra#4296), so the harness
// lists them too.
import { describe, expect, it } from "vitest";

import { CONFORMANCE_STATUS_PILL_STATUSES } from "../fixture-data";

describe("CONFORMANCE_STATUS_PILL_STATUSES", () => {
  it("lists the roster's Withdrawn and Reset pills", () => {
    expect(CONFORMANCE_STATUS_PILL_STATUSES).toContain("withdrawn");
    expect(CONFORMANCE_STATUS_PILL_STATUSES).toContain("reset");
  });

  it("keeps the ten pills it listed before, each once", () => {
    for (const s of [
      "running",
      "approved",
      "hold",
      "needs-review",
      "scheduled",
      "queued",
      "idle",
      "archived",
      "failed",
      "declined",
    ]) {
      expect(CONFORMANCE_STATUS_PILL_STATUSES).toContain(s);
    }
    expect(new Set(CONFORMANCE_STATUS_PILL_STATUSES).size).toBe(CONFORMANCE_STATUS_PILL_STATUSES.length);
  });
});
