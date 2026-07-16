// Install-profile capability declaration tests (cinatra#1238 target-side
// capability signal for `cinatra install demo`, cinatra-cli#122).
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  INSTALL_PROFILE_NAMES,
  isInstallProfileName,
  parseInstallProfiles,
  readDeclaredInstallProfiles,
  targetSupportsInstallProfile,
  targetSupportsDemoProfile,
  _resetCachedInstallProfilesForTesting,
} from "../install-profiles";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

afterEach(() => {
  _resetCachedInstallProfilesForTesting();
});

function writeTmpPkg(cinatra: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-profiles-test-"));
  const p = path.join(dir, "package.json");
  fs.writeFileSync(p, JSON.stringify({ cinatra }));
  return p;
}

describe("root package.json declares cinatra.installProfiles (demo-overlay capability signal)", () => {
  it("declares support for demo (the signal the CLI's assertTargetSupportsDemo reads)", () => {
    const rootPkg = path.join(REPO_ROOT, "package.json");
    const declared = readDeclaredInstallProfiles(rootPkg);
    // The exact capability contract cinatra-cli#122 enforces against the target.
    expect(declared).toContain("demo");
    expect(targetSupportsDemoProfile(rootPkg)).toBe(true);
  });

  it("declares the full canonical vocabulary (dev, prod, demo)", () => {
    _resetCachedInstallProfilesForTesting();
    const rootPkg = path.join(REPO_ROOT, "package.json");
    const declared = readDeclaredInstallProfiles(rootPkg);
    for (const profile of INSTALL_PROFILE_NAMES) {
      expect(declared).toContain(profile);
      expect(targetSupportsInstallProfile(profile, rootPkg)).toBe(true);
    }
  });
});

describe("isInstallProfileName", () => {
  it("accepts exactly the recognized vocabulary", () => {
    expect(isInstallProfileName("dev")).toBe(true);
    expect(isInstallProfileName("prod")).toBe(true);
    expect(isInstallProfileName("demo")).toBe(true);
  });
  it("rejects unknown / non-string values", () => {
    for (const v of ["DEMO", "staging", "", " demo ", 1, null, undefined, ["demo"], {}]) {
      expect(isInstallProfileName(v)).toBe(false);
    }
  });
});

describe("parseInstallProfiles — fail-closed validation", () => {
  it("keeps only recognized vocabulary, normalized to canonical order", () => {
    expect(parseInstallProfiles(["demo", "dev", "prod"])).toEqual(["dev", "prod", "demo"]);
    expect(parseInstallProfiles(["demo"])).toEqual(["demo"]);
  });

  it("drops unknown strings without failing the whole array", () => {
    expect(parseInstallProfiles(["dev", "staging", "demo", "DEMO"])).toEqual(["dev", "demo"]);
  });

  it("de-dupes repeated values", () => {
    expect(parseInstallProfiles(["demo", "demo", "dev", "dev"])).toEqual(["dev", "demo"]);
  });

  it("returns [] for a non-array or empty declaration (fail-closed)", () => {
    expect(parseInstallProfiles(undefined)).toEqual([]);
    expect(parseInstallProfiles(null)).toEqual([]);
    expect(parseInstallProfiles("demo")).toEqual([]);
    expect(parseInstallProfiles({ demo: true })).toEqual([]);
    expect(parseInstallProfiles([])).toEqual([]);
    expect(parseInstallProfiles([1, 2, 3])).toEqual([]);
  });
});

describe("readDeclaredInstallProfiles — tmp manifests + fail-closed IO", () => {
  it("reads a well-formed declaration", () => {
    const p = writeTmpPkg({ installProfiles: ["dev", "prod", "demo"] });
    expect(readDeclaredInstallProfiles(p)).toEqual(["dev", "prod", "demo"]);
  });

  it("drops demo but keeps dev/prod when the array omits demo (target does NOT support demo)", () => {
    _resetCachedInstallProfilesForTesting();
    const p = writeTmpPkg({ installProfiles: ["dev", "prod"] });
    const declared = readDeclaredInstallProfiles(p);
    expect(declared).toEqual(["dev", "prod"]);
    expect(declared).not.toContain("demo");
    expect(targetSupportsInstallProfile("demo", p)).toBe(false);
  });

  it("does NOT leak a stale cross-path result from the cache (explicit paths always re-read)", () => {
    const a = writeTmpPkg({ installProfiles: ["dev", "prod", "demo"] });
    const b = writeTmpPkg({ installProfiles: ["dev"] });
    // Back-to-back, no reset between: each explicit path returns its OWN result.
    expect(readDeclaredInstallProfiles(a)).toEqual(["dev", "prod", "demo"]);
    expect(readDeclaredInstallProfiles(b)).toEqual(["dev"]);
    expect(readDeclaredInstallProfiles(a)).toEqual(["dev", "prod", "demo"]);
  });

  it("returns [] when there is no installProfiles declaration", () => {
    _resetCachedInstallProfilesForTesting();
    const p = writeTmpPkg({ systemExtensions: [] });
    expect(readDeclaredInstallProfiles(p)).toEqual([]);
  });

  it("handles a missing or invalid package.json gracefully (fail-closed)", () => {
    _resetCachedInstallProfilesForTesting();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-profiles-io-"));
    const missingPath = path.join(dir, "no-such-package.json");
    expect(readDeclaredInstallProfiles(missingPath)).toEqual([]);

    _resetCachedInstallProfilesForTesting();
    const badPath = path.join(dir, "package.json");
    fs.writeFileSync(badPath, "{ NOT VALID JSON");
    expect(readDeclaredInstallProfiles(badPath)).toEqual([]);
  });
});
