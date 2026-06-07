// SPDX license detection tests.

import { describe, it, expect } from "vitest";
import { detectSpdxLicense, type LicenseDetectionResult } from "@cinatra-ai/extensions/license-detection";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createPackageDir(
  license: string | undefined,
  files: Record<string, string> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "license-test-"));
  const pkg = license !== undefined
    ? { name: "x", version: "0.0.0", license }
    : { name: "x", version: "0.0.0" };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe("detectSpdxLicense - permissive", () => {
  for (const id of ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "0BSD"]) {
    it(`returns tier: 'permissive' for ${id}`, async () => {
      const dir = createPackageDir(id);
      const result = await detectSpdxLicense(dir);
      expect(result).toEqual<LicenseDetectionResult>({ tier: "permissive", spdxId: id });
    });
  }
});

describe("detectSpdxLicense - copyleft", () => {
  for (const id of ["GPL-2.0", "GPL-3.0", "AGPL-3.0", "LGPL-2.1", "LGPL-3.0", "MPL-2.0"]) {
    it(`returns tier: 'copyleft' for ${id}`, async () => {
      const dir = createPackageDir(id);
      const result = await detectSpdxLicense(dir);
      expect(result).toEqual<LicenseDetectionResult>({ tier: "copyleft", spdxId: id });
    });
  }
});

describe("detectSpdxLicense - reject", () => {
  it("returns tier: 'reject' reason: 'missing' when license absent", async () => {
    const dir = createPackageDir(undefined);
    const result = await detectSpdxLicense(dir);
    expect(result).toEqual({ tier: "reject", reason: "missing" });
  });

  it("returns tier: 'reject' reason: 'unknown' for unrecognized SPDX id", async () => {
    const dir = createPackageDir("Proprietary-Closed");
    const result = await detectSpdxLicense(dir);
    expect(result).toEqual({ tier: "reject", reason: "unknown" });
  });

  it("returns tier: 'reject' reason: 'multi-license' for SPDX expression 'MIT OR Apache-2.0'", async () => {
    const dir = createPackageDir("MIT OR Apache-2.0");
    const result = await detectSpdxLicense(dir);
    expect(result).toEqual({ tier: "reject", reason: "multi-license" });
  });

  it("falls back to LICENSE file with SPDX header when package.json#license is absent", async () => {
    const dir = createPackageDir(undefined, {
      LICENSE: "SPDX-License-Identifier: MIT\n\nMIT License text here.",
    });
    const result = await detectSpdxLicense(dir);
    expect(result).toEqual<LicenseDetectionResult>({ tier: "permissive", spdxId: "MIT" });
  });
});
