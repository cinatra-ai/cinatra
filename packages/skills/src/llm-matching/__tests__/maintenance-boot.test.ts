/**
 * Match-store boot env-gating unit tests. Both opt-in schedulers gate on an env
 * var (no DB column → no migration): the maintenance tick
 * (SKILL_MATCH_MAINTENANCE_CRON, #1365) and the parity observation
 * (SKILL_MATCH_PARITY_CRON, #1366). `resolveMaintenanceCron` /
 * `resolveParityCron` are the pure gates: unset or invalid => disabled (null);
 * a valid 5/6-field cron => enabled.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/background-jobs", () => ({
  ensureBackgroundJobRuntime: vi.fn(),
  BACKGROUND_JOB_NAMES: {
    SKILL_MATCH_MAINTENANCE_TICK: "skill-match-maintenance-tick",
    SKILL_MATCH_PARITY_OBSERVE: "skill-match-parity-observe",
  },
}));

import { resolveMaintenanceCron, resolveParityCron } from "../drift-sampler-boot";
import { SKILL_MATCH_MAINTENANCE_CRON_ENV } from "../constants";

const PARITY_ENV = "SKILL_MATCH_PARITY_CRON";

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

describe("resolveParityCron", () => {
  it("returns null when unset / empty", () => {
    expect(resolveParityCron({})).toBeNull();
    expect(resolveParityCron({ [PARITY_ENV]: "   " })).toBeNull();
  });

  it("returns null (no throw) on an invalid cron", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveParityCron({ [PARITY_ENV]: "not a cron" })).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns the trimmed pattern for a valid cron", () => {
    expect(resolveParityCron({ [PARITY_ENV]: " 0 5 * * * " })).toBe("0 5 * * *");
  });
});
