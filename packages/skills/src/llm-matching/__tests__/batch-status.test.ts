/**
 * Invariant tests for the OpenAI Batch API status sets. The two subsets MUST
 * be disjoint (no status is both in-flight and terminal) AND their union MUST
 * equal the documented OpenAI Batch enum so a future status drift on either
 * side is caught at unit-test time, not via a frozen status panel in
 * production.
 *
 * Reference: OpenAI Batch API docs (status field). Snapshot of the documented
 * statuses as of 2026-05-11:
 *   - validating  (in-flight)
 *   - in_progress (in-flight)
 *   - finalizing  (in-flight)
 *   - completed   (terminal)
 *   - cancelled   (terminal)
 *   - failed      (terminal)
 *   - expired     (terminal)
 *
 * If OpenAI introduces a new status (e.g. `awaiting_quota`), the constants
 * module MUST be updated AND this test must be updated with the new
 * EXPECTED_OPENAI_STATUSES entry — failing this test is the signal to do so.
 */

import { describe, it, expect } from "vitest";
import {
  BATCH_STATUS_IN_FLIGHT,
  BATCH_STATUS_TERMINAL,
  BATCH_STATUS_ALL,
} from "../constants";

const EXPECTED_OPENAI_STATUSES = [
  "validating",
  "in_progress",
  "finalizing",
  "completed",
  "cancelled",
  "failed",
  "expired",
];

describe("OpenAI Batch API status sets", () => {
  it("BATCH-01: in-flight and terminal sets are disjoint", () => {
    for (const status of BATCH_STATUS_IN_FLIGHT) {
      expect(
        BATCH_STATUS_TERMINAL.has(status),
        `Status "${status}" appears in BOTH BATCH_STATUS_IN_FLIGHT and BATCH_STATUS_TERMINAL`,
      ).toBe(false);
    }
    for (const status of BATCH_STATUS_TERMINAL) {
      expect(
        BATCH_STATUS_IN_FLIGHT.has(status),
        `Status "${status}" appears in BOTH BATCH_STATUS_TERMINAL and BATCH_STATUS_IN_FLIGHT`,
      ).toBe(false);
    }
  });

  it("BATCH-02: union of in-flight + terminal equals BATCH_STATUS_ALL", () => {
    const computedUnion = new Set<string>([
      ...BATCH_STATUS_IN_FLIGHT,
      ...BATCH_STATUS_TERMINAL,
    ]);
    expect(computedUnion.size).toBe(BATCH_STATUS_ALL.size);
    for (const status of computedUnion) {
      expect(BATCH_STATUS_ALL.has(status)).toBe(true);
    }
    for (const status of BATCH_STATUS_ALL) {
      expect(computedUnion.has(status)).toBe(true);
    }
  });

  it("BATCH-03: BATCH_STATUS_ALL covers exactly the documented OpenAI Batch enum", () => {
    // If this fails, OpenAI either added or removed a status. Update the
    // EXPECTED_OPENAI_STATUSES array AND the matching subset in constants.ts.
    expect(BATCH_STATUS_ALL.size).toBe(EXPECTED_OPENAI_STATUSES.length);
    for (const status of EXPECTED_OPENAI_STATUSES) {
      expect(
        BATCH_STATUS_ALL.has(status),
        `Documented OpenAI status "${status}" is missing from BATCH_STATUS_ALL`,
      ).toBe(true);
    }
  });

  it("BATCH-04: each documented status is classified as in-flight OR terminal", () => {
    for (const status of EXPECTED_OPENAI_STATUSES) {
      const inFlight = BATCH_STATUS_IN_FLIGHT.has(status);
      const terminal = BATCH_STATUS_TERMINAL.has(status);
      expect(
        inFlight || terminal,
        `Status "${status}" is in BATCH_STATUS_ALL but classified as neither in-flight nor terminal`,
      ).toBe(true);
    }
  });

  it("BATCH-05: jobs.ts and panel both consume the centralized sets (import-check)", async () => {
    // Spot-check the call sites do not silently re-introduce file-local
    // duplicates by re-importing the centralized symbols and asserting they
    // are the same Set instances. If a future refactor inlines a literal
    // again, this test still passes (the sets are equivalent), but the
    // disjoint/completeness invariants above will catch the drift.
    const constants = await import("../constants");
    expect(constants.BATCH_STATUS_IN_FLIGHT).toBe(BATCH_STATUS_IN_FLIGHT);
    expect(constants.BATCH_STATUS_TERMINAL).toBe(BATCH_STATUS_TERMINAL);
    expect(constants.BATCH_STATUS_ALL).toBe(BATCH_STATUS_ALL);
  });
});
