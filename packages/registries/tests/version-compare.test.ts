import { describe, expect, it } from "vitest";
import { comparePluginVersions } from "../src/version-compare";

describe("comparePluginVersions", () => {
  it("returns 'not-installed' when installed is null/undefined", () => {
    expect(comparePluginVersions(null, "1.0.0")).toBe("not-installed");
    expect(comparePluginVersions(undefined, "1.0.0")).toBe("not-installed");
  });
  it("returns 'update-available' when latest > installed", () => {
    expect(comparePluginVersions("1.0.0", "1.1.0")).toBe("update-available");
    expect(comparePluginVersions("1.9.0", "1.10.0")).toBe("update-available");
  });
  it("returns 'current' when equal", () => {
    expect(comparePluginVersions("1.0.0", "1.0.0")).toBe("current");
  });
  it("returns 'installed-newer' when installed > latest", () => {
    expect(comparePluginVersions("2.0.0", "1.0.0")).toBe("installed-newer");
  });

  // -------------------------------------------------------------------------
  // cinatra#3522 — the marketplace card's "Update now" arm is decided HERE.
  //
  // The ratified drawing (the design spec specs/app-extensions.html §I) gives
  // the card "Update now when a newer version sits in the catalog", and the
  // catalogue's version is compared to the installed one by the package's OWN
  // versioning — never by string identity and never by lexical order. Both of
  // those disagree with semver exactly where it matters, so the disagreement is
  // pinned rather than assumed.
  // -------------------------------------------------------------------------
  describe("the ordering is semantic, not lexical (cinatra#3522)", () => {
    it("orders MULTI-DIGIT parts numerically: 1.2.10 is newer than 1.2.9", () => {
      // Lexically "1.2.10" < "1.2.9", so a string comparison would leave the
      // card on the disabled Installed pill while an update sat in the catalog.
      expect(comparePluginVersions("1.2.9", "1.2.10")).toBe("update-available");
      expect(comparePluginVersions("1.2.10", "1.2.9")).toBe("installed-newer");
      expect(comparePluginVersions("1.2.10", "1.2.10")).toBe("current");
      expect(comparePluginVersions("0.9.0", "0.10.0")).toBe("update-available");
    });

    it("orders a PRE-RELEASE below its own release and above the previous one", () => {
      // A prerelease in the catalog never offers an update over the release it
      // precedes...
      expect(comparePluginVersions("1.2.0", "1.3.0-beta.1")).toBe("update-available");
      expect(comparePluginVersions("1.3.0", "1.3.0-beta.1")).toBe("installed-newer");
      // ...and an installed prerelease does take the release that supersedes it.
      expect(comparePluginVersions("1.3.0-beta.1", "1.3.0")).toBe("update-available");
      // Prerelease identifiers themselves order numerically, not lexically.
      expect(comparePluginVersions("1.3.0-beta.9", "1.3.0-beta.10")).toBe("update-available");
      expect(comparePluginVersions("1.3.0-beta.1", "1.3.0-beta.1")).toBe("current");
    });
  });
});
