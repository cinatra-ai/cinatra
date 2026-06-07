// System-extension inventory and locked enforcement.
import { describe, expect, it } from "vitest";

import {
  SYSTEM_EXTENSIONS,
  isSystemExtension,
} from "../system-extension-inventory";
import { readRequiredInProdPackages, _resetCachedRequiredForTesting } from "../required-in-prod";

import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

describe("system-extension inventory", () => {
  it("inventory is a non-empty list of @cinatra-ai/* package names", () => {
    expect(SYSTEM_EXTENSIONS.length).toBeGreaterThan(0);
    for (const name of SYSTEM_EXTENSIONS) {
      expect(name.startsWith("@cinatra-ai/")).toBe(true);
    }
  });

  it("isSystemExtension classifies correctly", () => {
    expect(isSystemExtension("@cinatra-ai/nango-connector")).toBe(true);
    expect(isSystemExtension("@cinatra-ai/random-non-system")).toBe(false);
    expect(isSystemExtension("not-a-cinatra-package")).toBe(false);
  });

  it("system inventory is a SUBSET of cinatra.requiredExtensions", () => {
    // Adding a package to SYSTEM_EXTENSIONS without also declaring it in
    // cinatra.requiredExtensions would leave the prod-boot verifier
    // unable to ensure system extensions are installed.
    _resetCachedRequiredForTesting();
    const required = new Set(
      readRequiredInProdPackages(path.join(REPO_ROOT, "package.json")),
    );
    for (const pkg of SYSTEM_EXTENSIONS) {
      expect(
        required.has(pkg),
        `${pkg} is in SYSTEM_EXTENSIONS but not in cinatra.requiredExtensions`,
      ).toBe(true);
    }
  });
});
