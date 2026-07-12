// Pure derivation for the §III installed-card update chip (cinatra#1041
// outcome 3) — the five render states + their precedence.
import { describe, expect, it } from "vitest";

import {
  deriveInstalledUpdateChipState,
  type LatestCompatVerdict,
} from "../screens/installed-update-chip";

function derive(
  over: Partial<{
    installedVersion: string | null;
    latestVersion: string | null;
    latestCompat: LatestCompatVerdict;
    stale: boolean;
  }> = {},
) {
  return deriveInstalledUpdateChipState({
    installedVersion: "0.4.1",
    latestVersion: "0.4.2",
    latestCompat: "compatible",
    stale: false,
    ...over,
  });
}

describe("deriveInstalledUpdateChipState", () => {
  describe("non-comparable installed source (outcome 4 — no string-equality guess)", () => {
    it("null installed version (github ref / local — no provenance) → non-comparable", () => {
      expect(derive({ installedVersion: null })).toBe("non-comparable");
    });

    it("a github ref string (not exact semver) → non-comparable", () => {
      expect(derive({ installedVersion: "github:acme/parser#a1b2c3" })).toBe("non-comparable");
    });

    it("a dist-tag / range (not exact semver) → non-comparable", () => {
      expect(derive({ installedVersion: "^1.0.0" })).toBe("non-comparable");
      expect(derive({ installedVersion: "latest" })).toBe("non-comparable");
    });

    it("a 0.0.0-dev.* dev build (valid semver but a dev source) → non-comparable", () => {
      expect(derive({ installedVersion: "0.0.0-dev.abc1234" })).toBe("non-comparable");
    });

    it("non-comparable WINS over an otherwise-updatable read model", () => {
      // A dev build with a fresh, newer, compatible latest still shows NO chip.
      expect(
        derive({
          installedVersion: "0.0.0-dev.abc1234",
          latestVersion: "9.9.9",
          latestCompat: "compatible",
          stale: false,
        }),
      ).toBe("non-comparable");
    });
  });

  describe("fail-quiet (stale / missing / no resolvable latest)", () => {
    it("a stale readout → none", () => {
      expect(derive({ stale: true })).toBe("none");
    });

    it("a fresh readout with no resolvable semver latest → none", () => {
      expect(derive({ latestVersion: null, stale: false })).toBe("none");
    });
  });

  describe("up-to-date", () => {
    it("installed equals latest → up-to-date", () => {
      expect(derive({ installedVersion: "1.2.0", latestVersion: "1.2.0" })).toBe("up-to-date");
    });

    it("installed newer than latest → up-to-date (never a downgrade prompt)", () => {
      expect(derive({ installedVersion: "2.0.0", latestVersion: "1.0.0" })).toBe("up-to-date");
    });
  });

  describe("a newer version exists", () => {
    it("newer + compatible ABI → update-available", () => {
      expect(
        derive({ installedVersion: "0.4.1", latestVersion: "0.4.2", latestCompat: "compatible" }),
      ).toBe("update-available");
    });

    it("newer + unknown ABI (no declared range) → update-available (lenient, like the install gate)", () => {
      expect(derive({ latestCompat: "unknown" })).toBe("update-available");
    });

    it("newer but ABI-incompatible → incompatible (greyed, no chip)", () => {
      expect(
        derive({ installedVersion: "0.4.1", latestVersion: "0.9.1", latestCompat: "incompatible" }),
      ).toBe("incompatible");
    });
  });
});
