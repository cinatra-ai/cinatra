/**
 * cinatra#3745 — the structural carrier of a run's executed source.
 *
 * `parseVerifiedExecutedRunSource` only checks the SHAPE of the six fields; it
 * grants nothing. It returns a frozen copy of exactly those six own data
 * properties, or null.
 */
import { describe, expect, it } from "vitest";

import { parseVerifiedExecutedRunSource } from "../index";

const proof = () => ({
  contextId: "ctx-1",
  stepId: "call_llm_bridge",
  executionAttemptId: "attempt-1",
  sourceSha256: "a".repeat(64),
  executedSourceSha256: "b".repeat(64),
  declarationSourceSha256: "c".repeat(64),
});

describe("parseVerifiedExecutedRunSource", () => {
  it("is exported by the sdk's index (cinatra#3745)", () => {
    expect(typeof parseVerifiedExecutedRunSource).toBe("function");
  });

  it("returns a frozen copy of the six fields", () => {
    const input = proof();
    const parsed = parseVerifiedExecutedRunSource(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("refuses anything that is not a plain object of exactly the six fields", () => {
    for (const value of [null, undefined, "x", 1, [], { ...proof(), extra: "x" }, { ...proof(), [Symbol("s")]: "x" }]) {
      expect(parseVerifiedExecutedRunSource(value)).toBeNull();
    }
    const missing: Record<string, unknown> = proof();
    delete missing.stepId;
    expect(parseVerifiedExecutedRunSource(missing)).toBeNull();
  });

  it("refuses an empty, overlong or multi-line field, and a digest that is not lowercase hex", () => {
    for (const change of [
      { contextId: "" },
      { stepId: "a".repeat(513) },
      { executionAttemptId: "a\nb" },
      { contextId: "a\rb" },
      { sourceSha256: "A".repeat(64) },
      { executedSourceSha256: "b".repeat(63) },
      { declarationSourceSha256: "g".repeat(64) },
      { stepId: 7 },
    ]) {
      expect(parseVerifiedExecutedRunSource({ ...proof(), ...change })).toBeNull();
    }
  });

  it("refuses an accessor property, so a getter cannot answer twice", () => {
    const value = proof() as Record<string, unknown>;
    Object.defineProperty(value, "contextId", { get: () => "ctx-1", enumerable: true });
    expect(parseVerifiedExecutedRunSource(value)).toBeNull();
  });
});
