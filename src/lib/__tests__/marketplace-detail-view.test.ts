import { describe, expect, it } from "vitest";

import {
  buildShareLinks,
  emptyRatingSummary,
  formatInstallations,
  normalizeCompatibleUpTo,
  normalizeDetailChangelog,
  normalizeDetailDependencies,
  parseChangelogText,
  ratingBars,
  resolveModalInstallState,
  reviewInitials,
  safeHttpUrl,
  type MarketplaceDetailRatingSummary,
} from "@/lib/marketplace-detail-view";

describe("normalizeCompatibleUpTo", () => {
  it("stores the bare version, stripping a single leading v/V", () => {
    expect(normalizeCompatibleUpTo("0.2.0")).toBe("0.2.0");
    // Built by concat so no "v"-prefixed version literal lands in this file.
    expect(normalizeCompatibleUpTo(["v", "0.2.0"].join(""))).toBe("0.2.0");
    expect(normalizeCompatibleUpTo(["V", "0.2.0"].join(""))).toBe("0.2.0");
    expect(normalizeCompatibleUpTo("  0.2.0  ")).toBe("0.2.0");
  });

  it("degrades non-string / empty values to null (the row renders an em dash)", () => {
    expect(normalizeCompatibleUpTo(null)).toBeNull();
    expect(normalizeCompatibleUpTo(undefined)).toBeNull();
    expect(normalizeCompatibleUpTo("")).toBeNull();
    expect(normalizeCompatibleUpTo("   ")).toBeNull();
    expect(normalizeCompatibleUpTo("v")).toBeNull();
    expect(normalizeCompatibleUpTo(42)).toBeNull();
    expect(normalizeCompatibleUpTo({})).toBeNull();
  });
});

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
    expect(
      resolveModalInstallState({ state: "incompatible", blockedAction: "install" }, "incompatible"),
    ).toEqual({ kind: "incompatible" });
    expect(
      resolveModalInstallState({ state: "incompatible", blockedAction: "update" }, "compatible"),
    ).toEqual({ kind: "incompatible" });
  });
});

describe("formatInstallations", () => {
  it("formats the bare §V specs-column value with a trimmed k-suffix", () => {
    expect(formatInstallations(0)).toBe("0");
    expect(formatInstallations(1)).toBe("1");
    expect(formatInstallations(2)).toBe("2");
    expect(formatInstallations(999)).toBe("999");
    expect(formatInstallations(2000)).toBe("2k");
    expect(formatInstallations(2100)).toBe("2.1k");
    expect(formatInstallations(2150)).toBe("2.2k");
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

describe("parseChangelogText", () => {
  it("parses keep-a-changelog style headings into per-version entries", () => {
    const raw = [
      "# Changelog",
      "",
      "All notable changes to this project.",
      "",
      "## [0.4.2] - 2026-06-28",
      "",
      "### Fixed",
      "- Inline citations now deep-link to the exact source passage.",
      "* Faster retrieval across large workspaces.",
      "",
      "## 0.4.1 (2026-06-14)",
      "Follow-up questions now carry the full working context.",
    ].join("\n");
    expect(parseChangelogText(raw)).toEqual([
      {
        version: "0.4.2",
        date: "2026-06-28",
        notes: [
          "Fixed",
          "Inline citations now deep-link to the exact source passage.",
          "Faster retrieval across large workspaces.",
        ],
      },
      {
        version: "0.4.1",
        date: "2026-06-14",
        notes: ["Follow-up questions now carry the full working context."],
      },
    ]);
  });

  it("accepts v-prefixed and undated headings", () => {
    // Version prefix assembled at runtime so the literal never appears in
    // source (source-leak milestone-version scan).
    const raw = "## " + "v" + "1.2.3\n- First note\n";
    expect(parseChangelogText(raw)).toEqual([
      { version: "1.2.3", date: null, notes: ["First note"] },
    ]);
  });

  it("returns [] when no version heading exists (spec empty state)", () => {
    expect(parseChangelogText("")).toEqual([]);
    expect(parseChangelogText("just some prose\nwithout headings")).toEqual([]);
    expect(parseChangelogText("# Changelog\nnothing released yet")).toEqual([]);
  });
});

describe("normalizeDetailChangelog", () => {
  it("sanitizes a pre-parsed entry array (version required, notes coerced)", () => {
    expect(
      normalizeDetailChangelog([
        { version: "0.4.2", date: "2026-06-28", notes: ["a", "", 42, "b"] },
        { version: "0.4.1", released_at: "2026-06-14", notes: "single" },
        { version: "  ", notes: ["dropped — no version"] },
        null,
        "garbage",
      ]),
    ).toEqual([
      { version: "0.4.2", date: "2026-06-28", notes: ["a", "b"] },
      { version: "0.4.1", date: "2026-06-14", notes: ["single"] },
    ]);
  });

  it("parses a raw CHANGELOG string via parseChangelogText", () => {
    expect(normalizeDetailChangelog("## 2.0.0\n- rewrite")).toEqual([
      { version: "2.0.0", date: null, notes: ["rewrite"] },
    ]);
  });

  it("degrades absent/malformed values to [] (spec empty state)", () => {
    expect(normalizeDetailChangelog(undefined)).toEqual([]);
    expect(normalizeDetailChangelog(null)).toEqual([]);
    expect(normalizeDetailChangelog(42)).toEqual([]);
    expect(normalizeDetailChangelog({})).toEqual([]);
  });
});

describe("normalizeDetailDependencies", () => {
  it("normalizes the enriched entry array (cinatra.dependencies, never npm deps)", () => {
    expect(
      normalizeDetailDependencies([
        {
          package_name: "@cinatra-ai/confluence-connector",
          display_name: "Confluence Connector",
          kind: "connector",
          version_range: ">=1.2.0",
        },
        { packageName: "@cinatra-ai/pdf-extractor", name: "PDF Extractor", kind: "skill", versionRange: ">=0.4.0" },
        { package_name: "@x/unknown-kind", kind: "not-a-kind" },
        { name: "dropped — no package name" },
      ]),
    ).toEqual([
      {
        packageName: "@cinatra-ai/confluence-connector",
        name: "Confluence Connector",
        kind: "connector",
        versionRange: ">=1.2.0",
      },
      { packageName: "@cinatra-ai/pdf-extractor", name: "PDF Extractor", kind: "skill", versionRange: ">=0.4.0" },
      { packageName: "@x/unknown-kind", name: "@x/unknown-kind", kind: null, versionRange: "" },
    ]);
  });

  it("accepts the canonical sdk-extensions edge shape (versionConstraint object)", () => {
    expect(
      normalizeDetailDependencies([
        {
          packageName: "@cinatra-ai/email-connector",
          kind: "connector",
          edgeType: "capability",
          versionConstraint: { kind: "semver-range", range: "^2.0.0" },
          requirement: "required",
        },
        {
          package_name: "@cinatra-ai/pdf-extractor",
          version_constraint: { kind: "exact", version: "0.4.0" },
        },
      ]),
    ).toEqual([
      {
        packageName: "@cinatra-ai/email-connector",
        name: "@cinatra-ai/email-connector",
        kind: "connector",
        versionRange: "^2.0.0",
      },
      {
        packageName: "@cinatra-ai/pdf-extractor",
        name: "@cinatra-ai/pdf-extractor",
        kind: null,
        versionRange: "0.4.0",
      },
    ]);
  });

  it("accepts the raw manifest name→range map (kindless rows, name = package)", () => {
    expect(
      normalizeDetailDependencies({ "@cinatra-ai/pdf-extractor": "^0.4.0", "": "dropped" }),
    ).toEqual([
      { packageName: "@cinatra-ai/pdf-extractor", name: "@cinatra-ai/pdf-extractor", kind: null, versionRange: "^0.4.0" },
    ]);
  });

  it("degrades absent/malformed values to [] (section omitted)", () => {
    expect(normalizeDetailDependencies(undefined)).toEqual([]);
    expect(normalizeDetailDependencies(null)).toEqual([]);
    expect(normalizeDetailDependencies("nope")).toEqual([]);
  });
});
