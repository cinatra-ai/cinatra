// Risk-column resolution contract (issue #85).
//
// The registry catalog LIST view shows a riskLevel column sourced from
// registry summaries (fast path) with a packument-only backfill for names the
// fetched page missed (q filter / row cap / viewer scope). These tests pin
// the pure resolver in screens/registry-risk.ts:
//   - fast path seeds from the already-fetched summaries (no reads),
//   - ONLY missing names are backfilled, deduplicated,
//   - a failed/malformed backfill leaves the name absent (the screen renders
//     a neutral placeholder, never a guessed level).

import { describe, expect, it, vi } from "vitest";
import {
  parsePackumentRiskLevel,
  resolveRiskLevelsByPackageName,
} from "../screens/registry-risk";

function manifestWithRisk(riskLevel: unknown): Record<string, unknown> {
  return { name: "@acme/pkg", version: "1.0.0", cinatra: { riskLevel } };
}

describe("parsePackumentRiskLevel", () => {
  it("extracts each of the four registry levels from manifest.cinatra", () => {
    for (const level of ["low", "medium", "high", "critical"] as const) {
      expect(parsePackumentRiskLevel(manifestWithRisk(level))).toBe(level);
    }
  });

  it("returns null for a null manifest", () => {
    expect(parsePackumentRiskLevel(null)).toBeNull();
  });

  it("returns null when the cinatra block is missing or not an object", () => {
    expect(parsePackumentRiskLevel({ name: "@acme/pkg" })).toBeNull();
    expect(parsePackumentRiskLevel({ cinatra: "agent" })).toBeNull();
  });

  it("returns null for values outside the four-level union (never guesses)", () => {
    expect(parsePackumentRiskLevel(manifestWithRisk("severe"))).toBeNull();
    expect(parsePackumentRiskLevel(manifestWithRisk(3))).toBeNull();
    expect(parsePackumentRiskLevel(manifestWithRisk(undefined))).toBeNull();
  });
});

describe("resolveRiskLevelsByPackageName", () => {
  it("seeds from the fetched summaries without any backfill reads", async () => {
    const readPublishedSummary = vi.fn();
    const result = await resolveRiskLevelsByPackageName({
      summaries: [
        { packageName: "@acme/alpha", riskLevel: "low" },
        { packageName: "@acme/beta", riskLevel: "critical" },
      ],
      packageNames: ["@acme/alpha", "@acme/beta"],
      readPublishedSummary,
    });
    expect(result.get("@acme/alpha")).toBe("low");
    expect(result.get("@acme/beta")).toBe("critical");
    expect(readPublishedSummary).not.toHaveBeenCalled();
  });

  it("backfills ONLY names the summaries page missed, deduplicated", async () => {
    const readPublishedSummary = vi
      .fn()
      .mockResolvedValue({ manifest: manifestWithRisk("high") });
    const result = await resolveRiskLevelsByPackageName({
      summaries: [{ packageName: "@acme/alpha", riskLevel: "low" }],
      // "@acme/gamma" appears twice (an active row AND an archived row) but
      // must be read once. null/empty names (legacy rows) are skipped.
      packageNames: ["@acme/alpha", "@acme/gamma", "@acme/gamma", null, ""],
      readPublishedSummary,
    });
    expect(readPublishedSummary).toHaveBeenCalledTimes(1);
    expect(readPublishedSummary).toHaveBeenCalledWith("@acme/gamma");
    expect(result.get("@acme/gamma")).toBe("high");
    expect(result.get("@acme/alpha")).toBe("low");
  });

  it("leaves a name absent when its backfill read rejects (others still resolve)", async () => {
    const readPublishedSummary = vi.fn((packageName: string) =>
      packageName === "@acme/broken"
        ? Promise.reject(new Error("registry unreachable"))
        : Promise.resolve({ manifest: manifestWithRisk("medium") }),
    );
    const result = await resolveRiskLevelsByPackageName({
      summaries: [],
      packageNames: ["@acme/broken", "@acme/ok"],
      readPublishedSummary,
    });
    expect(result.has("@acme/broken")).toBe(false);
    expect(result.get("@acme/ok")).toBe("medium");
  });

  it("leaves a name absent when the packument manifest has no parseable risk", async () => {
    const readPublishedSummary = vi
      .fn()
      .mockResolvedValue({ manifest: { name: "@acme/legacy" } });
    const result = await resolveRiskLevelsByPackageName({
      summaries: [],
      packageNames: ["@acme/legacy"],
      readPublishedSummary,
    });
    expect(result.has("@acme/legacy")).toBe(false);
  });
});
