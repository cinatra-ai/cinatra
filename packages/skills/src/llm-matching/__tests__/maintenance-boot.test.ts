/**
 * Maintenance-boot env-gating unit tests (cinatra #1365 / S7).
 *
 * The maintenance tick is opt-in via the SKILL_MATCH_MAINTENANCE_CRON env var
 * (no DB column → no migration). `resolveMaintenanceCron` is the pure gate:
 * unset or invalid => disabled (null); a valid 5/6-field cron => enabled.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/background-jobs", () => ({
  ensureBackgroundJobRuntime: vi.fn(),
  BACKGROUND_JOB_NAMES: { SKILL_MATCH_MAINTENANCE_TICK: "skill-match-maintenance-tick" },
}));

import { resolveMaintenanceCron } from "../drift-sampler-boot";
import { SKILL_MATCH_MAINTENANCE_CRON_ENV } from "../constants";

describe("resolveMaintenanceCron", () => {
  it("returns null when the env var is unset", () => {
    expect(resolveMaintenanceCron({})).toBeNull();
  });

  it("returns null when the env var is empty/whitespace", () => {
    expect(resolveMaintenanceCron({ [SKILL_MATCH_MAINTENANCE_CRON_ENV]: "   " })).toBeNull();
  });

  it("returns null (and does not throw) on an invalid cron pattern", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveMaintenanceCron({ [SKILL_MATCH_MAINTENANCE_CRON_ENV]: "not a cron" })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns the trimmed pattern for a valid daily cron", () => {
    expect(resolveMaintenanceCron({ [SKILL_MATCH_MAINTENANCE_CRON_ENV]: " 0 4 * * * " })).toBe("0 4 * * *");
  });
});
