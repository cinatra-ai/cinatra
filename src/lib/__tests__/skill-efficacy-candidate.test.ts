/**
 * The deprecation-candidate rule (S10 efficacy loop, cinatra#1368).
 *
 * Encodes the acceptance criterion: candidates require a minimum ATTRIBUTABLE
 * sample + are never invoked + are active + not dismissed; non-attributable
 * modes never produce a candidate.
 */
import { describe, it, expect } from "vitest";
import {
  isDeprecationCandidate,
  SKILL_DEPRECATION_MIN_EXPOSURE_SAMPLE as MIN,
} from "../skill-efficacy";

const base = {
  lifecycleState: "active" as string | null,
  dismissedAt: null as string | null,
  invocationCount: 0,
  attributableExposureRunCount: MIN,
};

describe("isDeprecationCandidate", () => {
  it("flags an active, undismissed, never-invoked skill at the minimum attributable sample", () => {
    expect(isDeprecationCandidate(base)).toBe(true);
  });

  it("does NOT flag below the minimum attributable sample", () => {
    expect(
      isDeprecationCandidate({ ...base, attributableExposureRunCount: MIN - 1 }),
    ).toBe(false);
  });

  it("does NOT flag a skill that has been invoked", () => {
    expect(isDeprecationCandidate({ ...base, invocationCount: 1 })).toBe(false);
  });

  it("never flags a skill exposed only via non-attributable modes (attributable sample = 0)", () => {
    // High raw exposure but zero attributable exposures — Gemini inline /
    // Anthropic container / personal inline only. Never a candidate.
    expect(
      isDeprecationCandidate({ ...base, attributableExposureRunCount: 0 }),
    ).toBe(false);
  });

  it("does NOT flag a non-active skill (draft/deprecated/archived/derived)", () => {
    for (const state of ["draft", "deprecated", "archived", null]) {
      expect(isDeprecationCandidate({ ...base, lifecycleState: state })).toBe(false);
    }
  });

  it("does NOT flag a dismissed skill", () => {
    expect(
      isDeprecationCandidate({ ...base, dismissedAt: "2026-07-13T00:00:00Z" }),
    ).toBe(false);
  });
});
