/**
 * Pricing snapshot staleness canary tests.
 *
 * The pricing snapshot in `constants.ts` is hand-maintained. A console.warn
 * fires the FIRST time `estimateBatchCost()` is called within a process if
 * `SKILL_MATCH_PRICING_USD.capturedAt` is older than 90 days. The warning
 * is idempotent within a process — once warned, never repeats.
 *
 * The test drives `Date.now()` deterministically by passing `now` to
 * `emitPricingStaleWarningIfNeeded()` directly (it accepts a `now: Date`
 * parameter for exactly this reason). The test resets the per-process
 * dedupe flag between cases via `__resetPricingStaleDedupeForTests`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  estimateBatchCost,
  emitPricingStaleWarningIfNeeded,
  getPricingFreshness,
  SKILL_MATCH_PRICING_STALE_DAYS,
  __resetPricingStaleDedupeForTests,
  type PairForEstimation,
} from "../cost-estimate";
import { SKILL_MATCH_PRICING_USD } from "../constants";
import type { AgentForMatching, SkillForMatching } from "../types";

const buildPair = (i: number): PairForEstimation => {
  const agent: AgentForMatching = {
    packageId: `@cinatra/agent-${i}`,
    name: `Agent ${i}`,
    description: "a".repeat(200),
    tags: ["x", "y"],
  };
  const skill: SkillForMatching = {
    skillId: `skill-${i}`,
    name: `skill-${i}`,
    level: "system",
    content: "b".repeat(200),
  };
  return { agent, skill };
};

const CAPTURED_AT = SKILL_MATCH_PRICING_USD.capturedAt; // YYYY-MM-DD
const CAPTURED_AT_TS = Date.parse(CAPTURED_AT);

function dayOffset(days: number): Date {
  return new Date(CAPTURED_AT_TS + days * 86_400_000);
}

describe("pricing snapshot freshness", () => {
  beforeEach(() => {
    __resetPricingStaleDedupeForTests();
  });

  it("PRICING-FRESH-01: getPricingFreshness — 0 days after capturedAt is NOT stale", () => {
    const result = getPricingFreshness(dayOffset(0));
    expect(result.capturedAt).toBe(CAPTURED_AT);
    expect(result.ageDays).toBe(0);
    expect(result.isStale).toBe(false);
  });

  it("PRICING-FRESH-02: getPricingFreshness — 89 days after capturedAt is NOT stale", () => {
    const result = getPricingFreshness(dayOffset(89));
    expect(result.ageDays).toBe(89);
    expect(result.isStale).toBe(false);
  });

  it("PRICING-FRESH-03: getPricingFreshness — exactly 90 days is NOT stale (strict >)", () => {
    const result = getPricingFreshness(dayOffset(SKILL_MATCH_PRICING_STALE_DAYS));
    expect(result.ageDays).toBe(SKILL_MATCH_PRICING_STALE_DAYS);
    expect(result.isStale).toBe(false);
  });

  it("PRICING-FRESH-04: getPricingFreshness — 91 days IS stale", () => {
    const result = getPricingFreshness(dayOffset(SKILL_MATCH_PRICING_STALE_DAYS + 1));
    expect(result.ageDays).toBe(SKILL_MATCH_PRICING_STALE_DAYS + 1);
    expect(result.isStale).toBe(true);
  });

  it("PRICING-WARN-01: NO warning when capturedAt is fresh (1 day ago)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    emitPricingStaleWarningIfNeeded(dayOffset(1));
    const staleWarnings = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes('"event":"skill-match-pricing-stale"'),
    );
    expect(staleWarnings).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("PRICING-WARN-02: warning fires when ageDays > 90", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    emitPricingStaleWarningIfNeeded(dayOffset(120));
    const staleWarnings = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes('"event":"skill-match-pricing-stale"'),
    );
    expect(staleWarnings).toHaveLength(1);
    const payload = JSON.parse(staleWarnings[0][0] as string);
    expect(payload.event).toBe("skill-match-pricing-stale");
    expect(payload.capturedAt).toBe(CAPTURED_AT);
    expect(payload.ageDays).toBe(120);
    expect(payload.staleThresholdDays).toBe(SKILL_MATCH_PRICING_STALE_DAYS);
    expect(payload.pricingVersion).toBe(SKILL_MATCH_PRICING_USD.source);
    warnSpy.mockRestore();
  });

  it("PRICING-WARN-03: warning fires ONLY ONCE per process (dedupe)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Call three times with stale timestamps; only the first should emit.
    emitPricingStaleWarningIfNeeded(dayOffset(120));
    emitPricingStaleWarningIfNeeded(dayOffset(150));
    emitPricingStaleWarningIfNeeded(dayOffset(200));
    const staleWarnings = warnSpy.mock.calls.filter((call) =>
      typeof call[0] === "string" && call[0].includes('"event":"skill-match-pricing-stale"'),
    );
    expect(staleWarnings).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("PRICING-WARN-04: estimateBatchCost call site triggers the warning on first call", () => {
    // Set up Date.now() to return a stale date so the production call path
    // (estimateBatchCost → emitPricingStaleWarningIfNeeded → getPricingFreshness(new Date()))
    // sees the stale snapshot.
    const staleDate = dayOffset(120);
    vi.spyOn(Date, "now").mockReturnValue(staleDate.getTime());
    const realDate = global.Date;
    // Stub `new Date()` (no args) to return staleDate. We do this by
    // wrapping the constructor — vi.useFakeTimers() would also work but
    // is heavier than needed here.
    const DateMock = function (this: unknown, ...args: unknown[]) {
      if (args.length === 0) return new realDate(staleDate.getTime());
      return new (realDate as unknown as new (...a: unknown[]) => Date)(...args);
    } as unknown as DateConstructor;
    DateMock.now = () => staleDate.getTime();
    DateMock.parse = realDate.parse;
    DateMock.UTC = realDate.UTC;
    Object.setPrototypeOf(DateMock, realDate);
    Object.setPrototypeOf(DateMock.prototype, realDate.prototype);
    global.Date = DateMock;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      estimateBatchCost([buildPair(0)]);
      const staleWarnings = warnSpy.mock.calls.filter((call) =>
        typeof call[0] === "string" && call[0].includes('"event":"skill-match-pricing-stale"'),
      );
      expect(staleWarnings).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      global.Date = realDate;
      vi.restoreAllMocks();
    }
  });

  it("PRICING-WARN-05: estimateBatchCost called twice still emits only ONE warning (dedupe)", () => {
    const staleDate = dayOffset(120);
    const realDate = global.Date;
    const DateMock = function (this: unknown, ...args: unknown[]) {
      if (args.length === 0) return new realDate(staleDate.getTime());
      return new (realDate as unknown as new (...a: unknown[]) => Date)(...args);
    } as unknown as DateConstructor;
    DateMock.now = () => staleDate.getTime();
    DateMock.parse = realDate.parse;
    DateMock.UTC = realDate.UTC;
    Object.setPrototypeOf(DateMock, realDate);
    Object.setPrototypeOf(DateMock.prototype, realDate.prototype);
    global.Date = DateMock;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      estimateBatchCost([buildPair(0)]);
      estimateBatchCost([buildPair(1)]);
      estimateBatchCost([buildPair(2)]);
      const staleWarnings = warnSpy.mock.calls.filter((call) =>
        typeof call[0] === "string" && call[0].includes('"event":"skill-match-pricing-stale"'),
      );
      expect(staleWarnings).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
      global.Date = realDate;
    }
  });
});
