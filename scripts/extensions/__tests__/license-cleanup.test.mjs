import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  targetLicenseFor,
  applyLicenseToManifest,
  listExtensionManifests,
} from "../apply-license-cleanup.mjs";

describe("targetLicenseFor (license policy)", () => {
  it("an unknown vendor scope → null (fail closed; the gate flags it)", () => {
    expect(targetLicenseFor("@unknown-vendor/some-extension")).toBe(null);
  });
  it("wordpress-agent + drupal-agent → Apache-2.0 (API-driving agents, NOT derivative works of the GPL CMSes)", () => {
    expect(targetLicenseFor("@cinatra-ai/wordpress-agent")).toBe("Apache-2.0");
    expect(targetLicenseFor("@cinatra-ai/drupal-agent")).toBe("Apache-2.0");
  });
  it("every other cinatra-ai extension → Apache-2.0 (incl. anthropic-connector)", () => {
    expect(targetLicenseFor("@cinatra-ai/nango-connector")).toBe("Apache-2.0");
    expect(targetLicenseFor("@cinatra-ai/anthropic-connector")).toBe("Apache-2.0");
    expect(targetLicenseFor("@cinatra-ai/email-outreach-agent")).toBe("Apache-2.0");
  });
  it("an unknown scope → null (fail closed; not silently Apache)", () => {
    expect(targetLicenseFor("@some-vendor/whatever")).toBe(null);
    expect(targetLicenseFor("bare-name")).toBe(null);
  });
});

describe("applyLicenseToManifest (minimal-diff, idempotent)", () => {
  it("inserts after the name line when license is absent", () => {
    const before = `{\n  "name": "@cinatra-ai/x",\n  "version": "0.1.0"\n}\n`;
    const after = applyLicenseToManifest(before, "Apache-2.0");
    expect(after).toContain(`"name": "@cinatra-ai/x",\n  "license": "Apache-2.0",`);
    // still valid JSON
    expect(() => JSON.parse(after)).not.toThrow();
    expect(JSON.parse(after).license).toBe("Apache-2.0");
  });
  it("replaces an existing license value (MIT → Apache-2.0)", () => {
    const before = `{\n  "name": "@cinatra-ai/x",\n  "license": "MIT",\n  "version": "0.1.0"\n}\n`;
    const after = applyLicenseToManifest(before, "Apache-2.0");
    expect(JSON.parse(after).license).toBe("Apache-2.0");
    expect(after).not.toContain("MIT");
  });
  it("returns null when already compliant (idempotent)", () => {
    const t = `{\n  "name": "@cinatra-ai/x",\n  "license": "Apache-2.0"\n}\n`;
    expect(applyLicenseToManifest(t, "Apache-2.0")).toBe(null);
  });
  it("produces VALID JSON when \"name\" is the LAST property (regression)", () => {
    // name has NO trailing comma → naive insertion would emit broken JSON.
    const before = `{\n  "name": "@cinatra-ai/x"\n}\n`;
    const after = applyLicenseToManifest(before, "Apache-2.0");
    expect(() => JSON.parse(after)).not.toThrow();
    const parsed = JSON.parse(after);
    expect(parsed).toEqual({ name: "@cinatra-ai/x", license: "Apache-2.0" });
    // name line gained a comma; license line is the new last property (no comma)
    expect(after).toContain(`"name": "@cinatra-ai/x",`);
    expect(after).toContain(`"license": "Apache-2.0"\n}`);
  });
  it("produces VALID JSON when name is NOT last (comma preserved on both)", () => {
    const before = `{\n  "name": "@cinatra-ai/x",\n  "version": "0.1.0"\n}\n`;
    const after = applyLicenseToManifest(before, "Apache-2.0");
    expect(JSON.parse(after)).toEqual({ name: "@cinatra-ai/x", license: "Apache-2.0", version: "0.1.0" });
  });
});

describe("every extension manifest is policy-compliant (post-migration)", () => {
  it("has the correct license field", () => {
    const offenders = [];
    for (const p of listExtensionManifests()) {
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      const want = targetLicenseFor(pkg.name);
      if (pkg.license !== want) offenders.push(`${pkg.name}: ${pkg.license} != ${want}`);
    }
    expect(offenders).toEqual([]);
  });
});
