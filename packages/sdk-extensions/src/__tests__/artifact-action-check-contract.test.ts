/**
 * The artifact action-check contract an extension implements (cinatra#3745):
 * its capability id, its place in the typed capability map, and the parser of
 * the executed-run source a run's frame carries.
 *
 * The parser is a structural carrier only: it accepts exactly the six named
 * text fields, the three digests as lower-case sha256, and nothing else, and
 * returns a frozen copy. Authority comes from the host's loader, never from a
 * value this parser accepts.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ARTIFACT_ACTION_CHECK_CAPABILITY,
  parseVerifiedExecutedRunSource,
  type ArtifactActionCheckProvider,
} from "../artifact-action-check-contract";
import type { CapabilityContractMap } from "../capability-contract-map";
import { parseVerifiedExecutedRunSource as parseFromIndex } from "../index";
import { ARTIFACT_ACTION_CHECK_CAPABILITY as CAPABILITY_FROM_INTERNAL } from "../internal";

const SOURCE = {
  contextId: "ctx",
  stepId: "step",
  executionAttemptId: "attempt",
  sourceSha256: "a".repeat(64),
  executedSourceSha256: "b".repeat(64),
  declarationSourceSha256: "c".repeat(64),
};

describe("the artifact action-check contract", () => {
  it("names one versioned capability, the same from the contract and from the internal map", () => {
    expect(ARTIFACT_ACTION_CHECK_CAPABILITY).toBe("artifact-action-check/v1");
    expect(CAPABILITY_FROM_INTERNAL).toBe(ARTIFACT_ACTION_CHECK_CAPABILITY);
  });

  it("types the capability's provider as the action checker in the capability map", () => {
    expectTypeOf<CapabilityContractMap["artifact-action-check/v1"]>().toEqualTypeOf<ArtifactActionCheckProvider>();
  });

  it("parses a well-formed executed-run source into a frozen copy", () => {
    const parsed = parseVerifiedExecutedRunSource({ ...SOURCE });
    expect(parsed).toEqual(SOURCE);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseFromIndex).toBe(parseVerifiedExecutedRunSource);
  });

  it("refuses a value that is not exactly the six named text fields", () => {
    const missing: Record<string, unknown> = { ...SOURCE };
    delete missing.stepId;
    for (const value of [
      null, undefined, "source", [SOURCE], missing,
      { ...SOURCE, extra: "x" },
      { ...SOURCE, stepId: "" },
      { ...SOURCE, stepId: 1 },
      { ...SOURCE, contextId: "line\nbreak" },
      { ...SOURCE, contextId: "x".repeat(513) },
    ]) {
      expect(parseVerifiedExecutedRunSource(value)).toBeNull();
    }
  });

  it("refuses a digest that is not lower-case sha256", () => {
    for (const key of ["sourceSha256", "executedSourceSha256", "declarationSourceSha256"] as const) {
      for (const digest of ["A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
        expect(parseVerifiedExecutedRunSource({ ...SOURCE, [key]: digest })).toBeNull();
      }
    }
  });

  it("refuses an accessor field rather than calling it", () => {
    let reads = 0;
    const value: Record<string, unknown> = { ...SOURCE };
    Object.defineProperty(value, "stepId", { enumerable: true, get: () => { reads += 1; return "step"; } });
    expect(parseVerifiedExecutedRunSource(value)).toBeNull();
    expect(reads).toBe(0);
  });
});
