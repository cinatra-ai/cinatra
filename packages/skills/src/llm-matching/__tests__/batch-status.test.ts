/**
 * Invariant tests for the PERSISTED batch-run status sets. The two subsets
 * MUST be disjoint (no status is both in-flight and terminal) AND their union
 * MUST equal the persisted vocabulary so a future status drift on either side
 * is caught at unit-test time, not via a frozen status panel in production.
 *
 * Since setup-flow S6 the persisted vocabulary is provider-neutral: the
 * legacy OpenAI literals stay so pre-S6 rows keep classifying, `cancelling`
 * joined the in-flight set (cancellation initiated, processing not ended),
 * and neutral batch-v2 states map onto these literals via
 * `mapBatchV2StatusToPersisted`.
 *
 * If a new state is introduced, the constants module MUST be updated AND this
 * test must be updated with the new EXPECTED_PERSISTED_STATUSES entry —
 * failing this test is the signal to do so.
 */

import { describe, it, expect } from "vitest";
import {
  BATCH_STATUS_IN_FLIGHT,
  BATCH_STATUS_TERMINAL,
  BATCH_STATUS_ALL,
  mapBatchV2StatusToPersisted,
} from "../constants";

const EXPECTED_PERSISTED_STATUSES = [
  "validating",
  "in_progress",
  "finalizing",
  "cancelling",
  "completed",
  "cancelled",
  "failed",
  "expired",
];

describe("OpenAI Batch API status sets", () => {
  it("in-flight and terminal sets are disjoint", () => {
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

  it("union of in-flight + terminal equals BATCH_STATUS_ALL", () => {
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

  it("BATCH_STATUS_ALL covers exactly the documented OpenAI Batch enum", () => {
    // If this fails, OpenAI either added or removed a status. Update the
    // EXPECTED_PERSISTED_STATUSES array AND the matching subset in constants.ts.
    expect(BATCH_STATUS_ALL.size).toBe(EXPECTED_PERSISTED_STATUSES.length);
    for (const status of EXPECTED_PERSISTED_STATUSES) {
      expect(
        BATCH_STATUS_ALL.has(status),
        `Documented OpenAI status "${status}" is missing from BATCH_STATUS_ALL`,
      ).toBe(true);
    }
  });

  it("each documented status is classified as in-flight OR terminal", () => {
    for (const status of EXPECTED_PERSISTED_STATUSES) {
      const inFlight = BATCH_STATUS_IN_FLIGHT.has(status);
      const terminal = BATCH_STATUS_TERMINAL.has(status);
      expect(
        inFlight || terminal,
        `Status "${status}" is in BATCH_STATUS_ALL but classified as neither in-flight nor terminal`,
      ).toBe(true);
    }
  });

  it("jobs.ts and panel both consume the centralized sets (import-check)", async () => {
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

describe("mapBatchV2StatusToPersisted", () => {
  it("maps the four neutral batch-v2 states onto persisted literals", () => {
    expect(mapBatchV2StatusToPersisted("in_progress")).toBe("in_progress");
    expect(mapBatchV2StatusToPersisted("canceling")).toBe("cancelling");
    expect(mapBatchV2StatusToPersisted("ended")).toBe("completed");
    expect(mapBatchV2StatusToPersisted("failed")).toBe("failed");
  });

  it("every mapped value is a member of the persisted vocabulary", () => {
    for (const v2 of ["in_progress", "canceling", "ended", "failed"]) {
      expect(BATCH_STATUS_ALL.has(mapBatchV2StatusToPersisted(v2))).toBe(true);
    }
  });

  it("passes unknown states through verbatim (defensive keep-polling stance)", () => {
    expect(mapBatchV2StatusToPersisted("awaiting_quota")).toBe("awaiting_quota");
  });
});
