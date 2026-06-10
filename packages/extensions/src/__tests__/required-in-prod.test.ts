// Required-in-prod declaration tests.
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../canonical-store", () => ({
  listInstalledExtensions: vi.fn(async () => []),
}));

import { listInstalledExtensions } from "../canonical-store";
import {
  readRequiredInProdPackages,
  readRequiredInProdEntries,
  parseRequiredExtensionEntry,
  satisfiesRequiredVersionRange,
  checkRequiredExtensionVersionPin,
  verifyRequiredInProdInstalled,
  isPackageRequiredInProd,
  _resetCachedRequiredForTesting,
} from "../required-in-prod";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

afterEach(() => {
  _resetCachedRequiredForTesting();
});

describe("root package.json declares required extensions", () => {
  it("root package.json includes cinatra.requiredExtensions list", () => {
    const rootPkg = path.join(REPO_ROOT, "package.json");
    const list = readRequiredInProdPackages(rootPkg);
    expect(list.length).toBeGreaterThan(0);
    // Sanity: canonical system extensions are listed.
    expect(list).toContain("@cinatra-ai/nango-connector");
    expect(list).toContain("@cinatra-ai/security-reviewer-agent");
    expect(list).toContain("@cinatra-ai/assistant-skills");
  });

  it("reports false for non-required packages", () => {
    _resetCachedRequiredForTesting();
    const rootPkg = path.join(REPO_ROOT, "package.json");
    readRequiredInProdPackages(rootPkg);
    expect(isPackageRequiredInProd("@some-third-party/random-thing")).toBe(false);
    expect(isPackageRequiredInProd("@cinatra-ai/nango-connector")).toBe(true);
  });

  it("handles missing or invalid package.json gracefully", () => {
    _resetCachedRequiredForTesting();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "required-test-"));
    const missingPath = path.join(dir, "no-such-package.json");
    expect(readRequiredInProdPackages(missingPath)).toEqual([]);

    _resetCachedRequiredForTesting();
    const badPath = path.join(dir, "package.json");
    fs.writeFileSync(badPath, "{ NOT VALID JSON");
    expect(readRequiredInProdPackages(badPath)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Versioned entries — the host → extension half of the compatibility contract.
// ---------------------------------------------------------------------------

function writeTmpPkg(entries: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "required-versioned-"));
  const p = path.join(dir, "package.json");
  fs.writeFileSync(p, JSON.stringify({ cinatra: { requiredExtensions: entries } }));
  return p;
}

describe("parseRequiredExtensionEntry (name@range format)", () => {
  it("parses a pinned scoped entry", () => {
    expect(parseRequiredExtensionEntry("@cinatra-ai/nango-connector@^0.1.0")).toEqual({
      packageName: "@cinatra-ai/nango-connector",
      versionRange: "^0.1.0",
    });
  });

  it("keeps a BARE scoped name unpinned (lastIndexOf('@') === 0)", () => {
    expect(parseRequiredExtensionEntry("@cinatra-ai/nango-connector")).toEqual({
      packageName: "@cinatra-ai/nango-connector",
      versionRange: null,
    });
  });

  it("keeps a bare unscoped name unpinned and treats a trailing '@' as unpinned", () => {
    expect(parseRequiredExtensionEntry("some-pkg")).toEqual({ packageName: "some-pkg", versionRange: null });
    expect(parseRequiredExtensionEntry("@cinatra-ai/foo@")).toEqual({ packageName: "@cinatra-ai/foo", versionRange: null });
  });

  it("drops an empty entry", () => {
    expect(parseRequiredExtensionEntry("   ")).toBeNull();
  });
});

describe("root package.json carries a version pin on EVERY required extension", () => {
  it("every cinatra.requiredExtensions entry parses to a name + non-null range", () => {
    _resetCachedRequiredForTesting();
    const entries = readRequiredInProdEntries(path.join(REPO_ROOT, "package.json"));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.packageName.startsWith("@cinatra-ai/")).toBe(true);
      expect(e.versionRange, `${e.packageName} must carry a version range`).not.toBeNull();
      // The pinned range itself must be in a supported form (a malformed pin
      // would fail closed against EVERY version — a bricked required set).
      // Judge each pin by its own lower bound — entries legitimately pin
      // different lines (e.g. ^0.1.0 vs ^0.2.0), so no single concrete
      // version exists across the whole set. (That each pin admits the REAL
      // acquired version is asserted in required-extensions-lock.test.ts.)
      const range = e.versionRange as string;
      const lowerBound = range.replace(/^(\^|~|>=|=)\s*/, "").trim();
      const lowerTriple = /^\d+\.\d+\.\d+$/.test(lowerBound) ? lowerBound : "0.0.0";
      expect(
        range === "*" || satisfiesRequiredVersionRange(lowerTriple, range),
        `${e.packageName} pin "${range}" must admit its own lower bound (a malformed pin fails closed)`,
      ).toBe(true);
    }
  });
});

describe("satisfiesRequiredVersionRange (fail-closed, npm 0.x caret semantics)", () => {
  it("caret on 0.x admits the patch line only", () => {
    expect(satisfiesRequiredVersionRange("0.1.0", "^0.1.0")).toBe(true);
    expect(satisfiesRequiredVersionRange("0.1.9", "^0.1.0")).toBe(true);
    expect(satisfiesRequiredVersionRange("0.2.0", "^0.1.0")).toBe(false);
    expect(satisfiesRequiredVersionRange("1.0.0", "^0.1.0")).toBe(false);
    expect(satisfiesRequiredVersionRange("0.1.0", "^0.1.2")).toBe(false);
  });

  it("caret on >=1.x admits the major line", () => {
    expect(satisfiesRequiredVersionRange("1.4.2", "^1.2.0")).toBe(true);
    expect(satisfiesRequiredVersionRange("2.0.0", "^1.2.0")).toBe(false);
    expect(satisfiesRequiredVersionRange("1.1.9", "^1.2.0")).toBe(false);
  });

  it("caret on 0.0.z admits only the exact patch", () => {
    expect(satisfiesRequiredVersionRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesRequiredVersionRange("0.0.4", "^0.0.3")).toBe(false);
  });

  it("exact, tilde, x-range, >= and * forms", () => {
    expect(satisfiesRequiredVersionRange("0.1.3", "0.1.3")).toBe(true);
    expect(satisfiesRequiredVersionRange("0.1.4", "0.1.3")).toBe(false);
    expect(satisfiesRequiredVersionRange("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfiesRequiredVersionRange("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfiesRequiredVersionRange("1.9.9", "1.x")).toBe(true);
    expect(satisfiesRequiredVersionRange("2.0.0", "1.x")).toBe(false);
    expect(satisfiesRequiredVersionRange("0.1.7", "0.1.x")).toBe(true);
    expect(satisfiesRequiredVersionRange("3.0.0", ">=2.0.0")).toBe(true);
    expect(satisfiesRequiredVersionRange("1.9.9", ">=2.0.0")).toBe(false);
    expect(satisfiesRequiredVersionRange("9.9.9", "*")).toBe(true);
  });

  it("FAILS CLOSED on non-concrete versions and unsupported/malformed ranges", () => {
    expect(satisfiesRequiredVersionRange("latest", "^0.1.0")).toBe(false);
    expect(satisfiesRequiredVersionRange("0.1.0-beta.1", "^0.1.0")).toBe(false);
    expect(satisfiesRequiredVersionRange("0.1.0", "^0.1.0 || ^0.2.0")).toBe(false);
    expect(satisfiesRequiredVersionRange("0.1.0", "1.0.0 - 2.0.0")).toBe(false);
    expect(satisfiesRequiredVersionRange("0.1.0", "not-a-range")).toBe(false);
  });
});

describe("checkRequiredExtensionVersionPin (the installer gate)", () => {
  it("passes a non-required package and an unpinned required package", () => {
    _resetCachedRequiredForTesting();
    const p = writeTmpPkg(["@cinatra-ai/pinned@^0.1.0", "@cinatra-ai/unpinned"]);
    expect(
      checkRequiredExtensionVersionPin({ packageName: "@some/other", version: "9.9.9", op: "install" }, p),
    ).toEqual({ ok: true });
    expect(
      checkRequiredExtensionVersionPin({ packageName: "@cinatra-ai/unpinned", version: undefined, op: "update" }, p),
    ).toEqual({ ok: true });
  });

  it("passes a pinned package at a concrete in-range version (install AND update)", () => {
    _resetCachedRequiredForTesting();
    const p = writeTmpPkg(["@cinatra-ai/pinned@^0.1.0"]);
    for (const op of ["install", "update"] as const) {
      expect(
        checkRequiredExtensionVersionPin({ packageName: "@cinatra-ai/pinned", version: "0.1.4", op }, p),
      ).toEqual({ ok: true });
    }
  });

  it("REFUSES a pinned package at an out-of-range version with an actionable reason", () => {
    _resetCachedRequiredForTesting();
    const p = writeTmpPkg(["@cinatra-ai/pinned@^0.1.0"]);
    const verdict = checkRequiredExtensionVersionPin(
      { packageName: "@cinatra-ai/pinned", version: "0.2.0", op: "update" },
      p,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.requiredRange).toBe("^0.1.0");
      expect(verdict.reason).toContain("update of @cinatra-ai/pinned@0.2.0 refused");
      expect(verdict.reason).toContain('pins the required extension to "^0.1.0"');
      expect(verdict.reason).toContain("change the host's pinned range");
    }
  });

  it("REFUSES a pinned package with an absent or dist-tag version (fail closed)", () => {
    _resetCachedRequiredForTesting();
    const p = writeTmpPkg(["@cinatra-ai/pinned@^0.1.0"]);
    expect(
      checkRequiredExtensionVersionPin({ packageName: "@cinatra-ai/pinned", version: undefined, op: "install" }, p).ok,
    ).toBe(false);
    const tag = checkRequiredExtensionVersionPin({ packageName: "@cinatra-ai/pinned", version: "latest", op: "install" }, p);
    expect(tag.ok).toBe(false);
    if (!tag.ok) expect(tag.reason).toContain("dist-tag");
  });
});

describe("verifyRequiredInProdInstalled — version mismatch reporting", () => {
  const mocked = vi.mocked(listInstalledExtensions);

  function primeRequired(entries: string[]) {
    _resetCachedRequiredForTesting();
    const p = writeTmpPkg(entries);
    readRequiredInProdEntries(p); // prime the cache from the temp manifest
  }

  function row(packageName: string, version: string | null, status: "active" | "locked" | "archived" = "active") {
    return {
      packageName,
      status,
      source:
        version === null
          ? { type: "github", url: "https://github.com/cinatra-ai/x", packageId: "x" }
          : { type: "verdaccio", registryUrl: "https://registry.cinatra.ai", packageName, version, integrity: "sha512-x" },
    } as never;
  }

  it("ok when every pinned package is installed at an in-range version", async () => {
    primeRequired(["@cinatra-ai/a@^0.1.0", "@cinatra-ai/b@^0.1.0"]);
    mocked.mockResolvedValueOnce([row("@cinatra-ai/a", "0.1.2"), row("@cinatra-ai/b", "0.1.0", "locked")] as never);
    const res = await verifyRequiredInProdInstalled();
    expect(res.ok).toBe(true);
  });

  it("reports a version-mismatched row (installed vs pinned range) with an actionable reason", async () => {
    primeRequired(["@cinatra-ai/a@^0.1.0"]);
    mocked.mockResolvedValueOnce([row("@cinatra-ai/a", "0.2.0")] as never);
    const res = await verifyRequiredInProdInstalled();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing).toEqual([]);
      expect(res.mismatched).toEqual([
        { packageName: "@cinatra-ai/a", requiredRange: "^0.1.0", installedVersion: "0.2.0" },
      ]);
      expect(res.reason).toContain("version-mismatched");
      expect(res.reason).toContain("installed 0.2.0, requires ^0.1.0");
    }
  });

  it("EVERY active/locked row of a pinned package must satisfy (a single drifted row mismatches)", async () => {
    primeRequired(["@cinatra-ai/a@^0.1.0"]);
    mocked.mockResolvedValueOnce([row("@cinatra-ai/a", "0.1.1"), row("@cinatra-ai/a", "0.3.0", "locked")] as never);
    const res = await verifyRequiredInProdInstalled();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.mismatched).toHaveLength(1);
  });

  it("a non-registry source on a pinned package is a mismatch (version unverifiable), never a silent pass", async () => {
    primeRequired(["@cinatra-ai/a@^0.1.0"]);
    mocked.mockResolvedValueOnce([row("@cinatra-ai/a", null)] as never);
    const res = await verifyRequiredInProdInstalled();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.mismatched).toEqual([
        { packageName: "@cinatra-ai/a", requiredRange: "^0.1.0", installedVersion: null },
      ]);
      expect(res.reason).toContain("unverifiable non-registry source");
    }
  });

  it("still reports MISSING packages alongside mismatches; archived rows do not count", async () => {
    primeRequired(["@cinatra-ai/a@^0.1.0", "@cinatra-ai/b@^0.1.0"]);
    mocked.mockResolvedValueOnce([row("@cinatra-ai/a", "0.1.0", "archived"), row("@cinatra-ai/b", "0.9.0")] as never);
    const res = await verifyRequiredInProdInstalled();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.missing).toEqual(["@cinatra-ai/a"]);
      expect(res.mismatched).toHaveLength(1);
      expect(res.reason).toContain("missing");
      expect(res.reason).toContain("version-mismatched");
    }
  });

  it("an unpinned (bare) entry is presence-checked only", async () => {
    primeRequired(["@cinatra-ai/a"]);
    mocked.mockResolvedValueOnce([row("@cinatra-ai/a", "9.9.9")] as never);
    const res = await verifyRequiredInProdInstalled();
    expect(res.ok).toBe(true);
  });

  // Static-bundle ANCHOR rows (bundled-in-image provenance, see
  // static-bundle-anchor.ts) record the bundled version at seed time, so a
  // pinned required entry is verified against it like a registry version —
  // NOT treated as an unverifiable non-registry source.
  function anchorRow(packageName: string, hash: string, status: "active" | "locked" = "locked") {
    return {
      packageName,
      status,
      source: {
        type: "local",
        path: `static-bundle:${packageName}`,
        resolvedCommitOrTreeHash: hash,
      },
    } as never;
  }

  it("a static-bundle anchor with an in-range bundled version satisfies the pin", async () => {
    primeRequired(["@cinatra-ai/a@^0.1.0"]);
    mocked.mockResolvedValueOnce([anchorRow("@cinatra-ai/a", "bundled@0.1.2")] as never);
    const res = await verifyRequiredInProdInstalled();
    expect(res.ok).toBe(true);
  });

  it("a static-bundle anchor with an out-of-range bundled version is a mismatch", async () => {
    primeRequired(["@cinatra-ai/a@^0.1.0"]);
    mocked.mockResolvedValueOnce([anchorRow("@cinatra-ai/a", "bundled@0.2.0")] as never);
    const res = await verifyRequiredInProdInstalled();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.mismatched).toEqual([
        { packageName: "@cinatra-ai/a", requiredRange: "^0.1.0", installedVersion: "0.2.0" },
      ]);
    }
  });

  it("a static-bundle anchor WITHOUT a parseable bundled version fails closed (mismatch)", async () => {
    primeRequired(["@cinatra-ai/a@^0.1.0"]);
    mocked.mockResolvedValueOnce([anchorRow("@cinatra-ai/a", "not-a-version")] as never);
    const res = await verifyRequiredInProdInstalled();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.mismatched).toEqual([
        { packageName: "@cinatra-ai/a", requiredRange: "^0.1.0", installedVersion: null },
      ]);
    }
  });
});
