import { describe, expect, it } from "vitest";

import {
  buildShareLinks,
  emptyRatingSummary,
  formatInstallations,
  ratingBars,
  resolveModalInstallState,
  reviewInitials,
  safeHttpUrl,
  type MarketplaceDetailRatingSummary,
} from "@/lib/marketplace-detail-view";

describe("emptyRatingSummary", () => {
  it("is a well-formed zeroed 5→1 summary", () => {
    expect(emptyRatingSummary()).toEqual({
      average: 0,
      total: 0,
      counts: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
    });
  });
});

describe("buildShareLinks", () => {
  it("builds the five icon-only share intents from a permalink", () => {
    const links = buildShareLinks("https://marketplace.cinatra.ai/product/weather-agent");
    expect(links.map((l) => l.network)).toEqual([
      "facebook",
      "x",
      "pinterest",
      "linkedin",
      "telegram",
    ]);
    const encoded = encodeURIComponent("https://marketplace.cinatra.ai/product/weather-agent");
    expect(links.every((l) => l.href.includes(encoded))).toBe(true);
    expect(links[0].href).toContain("facebook.com/sharer");
  });

  it("returns [] for a null / empty / non-http(s) permalink", () => {
    expect(buildShareLinks(null)).toEqual([]);
    expect(buildShareLinks("")).toEqual([]);
    expect(buildShareLinks("   ")).toEqual([]);
    expect(buildShareLinks("javascript:alert(1)")).toEqual([]);
    expect(buildShareLinks("ftp://host/x")).toEqual([]);
  });
});

describe("safeHttpUrl", () => {
  it("passes through http(s) URLs unchanged", () => {
    expect(safeHttpUrl("https://cdn.example/i.png")).toBe("https://cdn.example/i.png");
    expect(safeHttpUrl("http://cdn.example/i.png")).toBe("http://cdn.example/i.png");
  });

  it("drops non-http(s), relative, empty, and null values to null", () => {
    // The icon fallback chain (iconAssetUrl / card icon+vendor-logo) is not
    // scheme-checked upstream, so these must never reach an <img src>/href.
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html;base64,PHN2Zz4=")).toBeNull();
    expect(safeHttpUrl("ftp://host/x")).toBeNull();
    expect(safeHttpUrl("/relative/path.png")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl("")).toBeNull();
    expect(safeHttpUrl("   ")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});

describe("ratingBars", () => {
  it("computes 5→1 rows with per-level percentage of the total", () => {
    const summary: MarketplaceDetailRatingSummary = {
      average: 3,
      total: 10,
      counts: { "5": 5, "4": 0, "3": 0, "2": 0, "1": 5 },
    };
    const bars = ratingBars(summary);
    expect(bars.map((b) => b.star)).toEqual([5, 4, 3, 2, 1]);
    expect(bars.map((b) => b.pct)).toEqual([50, 0, 0, 0, 50]);
    expect(bars.map((b) => b.count)).toEqual([5, 0, 0, 0, 5]);
  });

  it("yields all-zero percentages when there are no reviews", () => {
    const bars = ratingBars(emptyRatingSummary());
    expect(bars.every((b) => b.pct === 0 && b.count === 0)).toBe(true);
  });
});

describe("resolveModalInstallState", () => {
  it("shows Incompatible only for a not-installed listing this host cannot satisfy", () => {
    expect(resolveModalInstallState({ state: "install", disabled: false }, "incompatible")).toEqual({
      kind: "incompatible",
    });
    // compatible / unknown fall through to the normal install state.
    expect(resolveModalInstallState({ state: "install", disabled: false }, "unknown")).toEqual({
      kind: "install",
      disabled: false,
    });
    expect(resolveModalInstallState({ state: "install", disabled: true }, "compatible")).toEqual({
      kind: "install",
      disabled: true,
    });
  });

  it("never forces Incompatible on an installed/updatable/archived listing", () => {
    expect(resolveModalInstallState({ state: "installed" }, "incompatible")).toEqual({ kind: "installed" });
    expect(resolveModalInstallState({ state: "update", disabled: false }, "incompatible")).toEqual({
      kind: "update",
      disabled: false,
    });
    expect(resolveModalInstallState({ state: "restore" }, "incompatible")).toEqual({ kind: "restore" });
  });

  it("passes a pre-resolved six-state incompatible CTA through unchanged (cinatra#988)", () => {
    // The card resolver (resolveMarketplaceCardCta) now folds the ABI verdict
    // in itself; the modal must honour it regardless of the compat argument.
    expect(resolveModalInstallState({ state: "incompatible" }, "incompatible")).toEqual({
      kind: "incompatible",
    });
    expect(resolveModalInstallState({ state: "incompatible" }, "compatible")).toEqual({
      kind: "incompatible",
    });
  });
});

describe("formatInstallations", () => {
  it("formats singular/plural and thousands with a trimmed k-suffix", () => {
    expect(formatInstallations(0)).toBe("0 installations");
    expect(formatInstallations(1)).toBe("1 installation");
    expect(formatInstallations(2)).toBe("2 installations");
    expect(formatInstallations(999)).toBe("999 installations");
    expect(formatInstallations(2000)).toBe("2k installations");
    expect(formatInstallations(2100)).toBe("2.1k installations");
    expect(formatInstallations(2150)).toBe("2.2k installations");
  });

  it("returns null for absent / negative / non-finite counts", () => {
    expect(formatInstallations(null)).toBeNull();
    expect(formatInstallations(-5)).toBeNull();
    expect(formatInstallations(Number.NaN)).toBeNull();
    expect(formatInstallations(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("reviewInitials", () => {
  it("derives up-to-two-letter initials", () => {
    expect(reviewInitials("Ada Lovelace")).toBe("AL");
    expect(reviewInitials("Grace")).toBe("GR");
    expect(reviewInitials("mary jane watson")).toBe("MW");
    expect(reviewInitials("")).toBe("?");
    expect(reviewInitials("   ")).toBe("?");
  });
});
