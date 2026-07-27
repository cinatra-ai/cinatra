/**
 * cinatra#2047 — the LIFECYCLE ACTIVATION SWITCHES after the owner ruling of
 * 2026-07-27: BOTH switches are DEFAULT-ON with an explicit opt-out.
 *
 * This file is the direct pin of the grammar every consumer inherits:
 *   - UNSET  ⇒ ACTIVE (the flip's whole point — no deployment has to opt in);
 *   - `off`  ⇒ INACTIVE (trimmed, case-insensitive) — the ONLY deactivating value;
 *   - anything else, including the legacy `on`, an empty string, `true`, `0`,
 *     `false`, `0ff` ⇒ ACTIVE (fail-ACTIVE on a typo, so a mistyped opt-out is
 *     loud rather than a silent inert deployment).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  LIFECYCLE_ACTIVATION_OPT_OUT_VALUE,
  LIFECYCLE_RECOMMENDATION_CHIP_ROW_ENV,
  LIFECYCLE_REVIEW_ORCHESTRATION_ENV,
  isLifecycleReviewOrchestrationActive,
  isRecommendationChipRowHoldActive,
} from "../lifecycle-activation";

const SWITCHES = [
  {
    name: "review orchestration",
    env: LIFECYCLE_REVIEW_ORCHESTRATION_ENV,
    read: isLifecycleReviewOrchestrationActive,
  },
  {
    name: "recommendation chip-row hold",
    env: LIFECYCLE_RECOMMENDATION_CHIP_ROW_ENV,
    read: isRecommendationChipRowHoldActive,
  },
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const s of SWITCHES) {
    saved.set(s.env, process.env[s.env]);
    delete process.env[s.env];
  }
});
afterEach(() => {
  for (const s of SWITCHES) {
    const v = saved.get(s.env);
    if (v === undefined) delete process.env[s.env];
    else process.env[s.env] = v;
  }
});

it("the opt-out vocabulary is the module's own `off`", () => {
  expect(LIFECYCLE_ACTIVATION_OPT_OUT_VALUE).toBe("off");
});

it("the two switches are distinct env vars", () => {
  expect(LIFECYCLE_REVIEW_ORCHESTRATION_ENV).toBe("CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION");
  expect(LIFECYCLE_RECOMMENDATION_CHIP_ROW_ENV).toBe(
    "CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW",
  );
  expect(LIFECYCLE_REVIEW_ORCHESTRATION_ENV).not.toBe(LIFECYCLE_RECOMMENDATION_CHIP_ROW_ENV);
});

for (const s of SWITCHES) {
  describe(`${s.name} — default-ON with explicit opt-out`, () => {
    it("UNSET ⇒ ACTIVE (the shipped default after the #2047 flip)", () => {
      expect(process.env[s.env]).toBeUndefined();
      expect(s.read()).toBe(true);
    });

    it("`off` ⇒ INACTIVE, trimmed and case-insensitive", () => {
      for (const v of ["off", "OFF", "Off", "  off  ", "\toff\n"]) {
        process.env[s.env] = v;
        expect(s.read()).toBe(false);
      }
    });

    it("every other value ⇒ ACTIVE (including the legacy `on`)", () => {
      for (const v of ["on", "ON", "  on ", "", "   ", "true", "false", "0", "1", "0ff", "offf"]) {
        process.env[s.env] = v;
        expect(s.read()).toBe(true);
      }
    });

    it("is read on EVERY call (never memoised) — a mid-process change takes effect", () => {
      expect(s.read()).toBe(true);
      process.env[s.env] = "off";
      expect(s.read()).toBe(false);
      delete process.env[s.env];
      expect(s.read()).toBe(true);
    });
  });
}

it("the switches are INDEPENDENT — opting one out leaves the other active", () => {
  process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] = "off";
  expect(isLifecycleReviewOrchestrationActive()).toBe(false);
  expect(isRecommendationChipRowHoldActive()).toBe(true);

  delete process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV];
  process.env[LIFECYCLE_RECOMMENDATION_CHIP_ROW_ENV] = "off";
  expect(isLifecycleReviewOrchestrationActive()).toBe(true);
  expect(isRecommendationChipRowHoldActive()).toBe(false);
});
