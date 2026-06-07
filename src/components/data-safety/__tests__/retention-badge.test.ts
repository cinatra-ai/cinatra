// computeRetentionDisplay.

import { describe, expect, it } from "vitest";
import { computeRetentionDisplay } from "../retention-badge";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-05-24T00:00:00Z");

describe("computeRetentionDisplay", () => {
  it("indefinite → muted secondary badge", () => {
    expect(computeRetentionDisplay({ kind: "indefinite" }, null, NOW)).toEqual({
      label: "Retention: indefinite",
      variant: "secondary",
    });
  });

  it("duration without createdAt → static total-days secondary", () => {
    expect(
      computeRetentionDisplay({ kind: "duration", days: 90 }, null, NOW),
    ).toEqual({ label: "Retention: 90d", variant: "secondary" });
  });

  it("duration with plenty of time left → default variant + countdown", () => {
    const createdAt = new Date(NOW - 10 * DAY).toISOString(); // 10d in
    const r = computeRetentionDisplay({ kind: "duration", days: 90 }, createdAt, NOW);
    expect(r.variant).toBe("default");
    expect(r.label).toBe("Retention: 80d left");
  });

  it("within 10% of expiry → destructive", () => {
    const createdAt = new Date(NOW - 85 * DAY).toISOString(); // 5d left of 90
    const r = computeRetentionDisplay({ kind: "duration", days: 90 }, createdAt, NOW);
    expect(r.variant).toBe("destructive");
    expect(r.label).toBe("Retention: 5d left");
  });

  it("expired → 0d left, destructive (clamped, never negative)", () => {
    const createdAt = new Date(NOW - 200 * DAY).toISOString();
    const r = computeRetentionDisplay({ kind: "duration", days: 90 }, createdAt, NOW);
    expect(r.variant).toBe("destructive");
    expect(r.label).toBe("Retention: 0d left");
  });
});
