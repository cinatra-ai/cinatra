// Required-in-prod declaration tests.
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  readRequiredInProdPackages,
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
