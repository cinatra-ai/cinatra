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
});
