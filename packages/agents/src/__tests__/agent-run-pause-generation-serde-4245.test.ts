/**
 * cinatra#4245 PR A1: the run record carries the pause generation, parsed
 * strictly. A later reader of the pause (the pause-task verifier) refuses a
 * record whose generation is absent, so a value the serde cannot read must
 * come out absent, never as 0 and never as a coerced number.
 *
 * Red at main: `parsePauseGeneration` does not exist and `deserializeRun`
 * carries no `pauseGeneration`.
 */
import { describe, expect, it, vi } from "vitest";

// deserializeRun is pure; its module also holds DB readers, so the client is stubbed.
vi.mock("../db", () => ({ db: {} }));

import { deserializeRun, parsePauseGeneration } from "../agent-run-serde";

const row = (pauseGeneration: unknown) =>
  ({
    id: "run-4245",
    templateId: "tpl-4245",
    versionId: null,
    runBy: null,
    status: "pending_approval",
    inputParams: "{}",
    stepResults: null,
    startedAt: null,
    completedAt: null,
    error: null,
    title: null,
    createdAt: new Date("2026-10-22T00:00:00Z"),
    sourceType: "agent_builder",
    sourceId: null,
    orgId: "org-4245",
    pauseGeneration,
    pauseClaimToken: "never-surfaced",
    pauseClaimPhase: "claimed",
    pauseClaimExpiresAt: new Date("2026-10-22T00:02:00Z"),
  }) as unknown as Parameters<typeof deserializeRun>[0];

describe("the run record's pause generation (cinatra#4245)", () => {
  it("surfaces a stored generation as the same integer, 0 included", () => {
    expect(deserializeRun(row(0)).pauseGeneration).toBe(0);
    expect(deserializeRun(row(7)).pauseGeneration).toBe(7);
    expect(deserializeRun(row("12")).pauseGeneration).toBe(12);
  });

  it("does not surface the claim token, phase or expiry on the record", () => {
    const record = deserializeRun(row(3)) as Record<string, unknown>;
    expect(Object.keys(record).filter((key) => key.startsWith("pauseClaim"))).toEqual([]);
  });

  it.each([
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", 2 ** 53],
    ["a negative string", "-1"],
    ["a zero-padded string", "01"],
    ["an exponent string", "1e3"],
    ["a padded string", " 1"],
    ["an empty string", ""],
    ["an unsafe numeric string", "9007199254740993"],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
    ["a bigint", BigInt(1)],
    ["an object", {}],
  ])("reads %s as absent, never as a generation", (_label, raw) => {
    expect(parsePauseGeneration(raw)).toBeUndefined();
    expect(deserializeRun(row(raw)).pauseGeneration).toBeUndefined();
  });

  it("reads a negative zero as the generation 0, never as -0", () => {
    expect(Object.is(parsePauseGeneration(-0), 0)).toBe(true);
    expect(Object.is(deserializeRun(row(-0)).pauseGeneration, 0)).toBe(true);
  });

  it("accepts the largest safe integer, as a number and as its decimal text", () => {
    expect(parsePauseGeneration(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(parsePauseGeneration(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });
});
