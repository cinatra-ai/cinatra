// System-extension inventory and locked enforcement.
//
// Since cinatra#35 (IOC-43) the inventory is DATA: the host-owned
// `cinatra.systemExtensions` declaration in the root package.json, read
// fail-closed by `readSystemExtensions`. These tests pin (1) the data
// sourcing (no code-resident list), (2) the fail-closed reader behavior,
// and (3) the ⊆ extensions drift invariant.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  SYSTEM_EXTENSIONS,
  isSystemExtension,
  readSystemExtensions,
  assertCanRemoveExtension,
  SystemExtensionRemovalError,
  SYSTEM_EXTENSION_REMOVAL_MESSAGE,
  type ExtensionRemovalIntent,
} from "../system-extension-inventory";
import { readRequiredInProdPackages, _resetCachedRequiredForTesting } from "../required-in-prod";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const tmpDirs: string[] = [];
function tmpPackageJson(contents: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "system-ext-inventory-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "package.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("system-extension inventory", () => {
  it("inventory is a non-empty list of @cinatra-ai/* package names", () => {
    expect(SYSTEM_EXTENSIONS.length).toBeGreaterThan(0);
    for (const name of SYSTEM_EXTENSIONS) {
      expect(name.startsWith("@cinatra-ai/")).toBe(true);
    }
  });

  it("inventory is sourced from root package.json cinatra.systemExtensions (data, not code)", () => {
    const declared = readSystemExtensions(path.join(REPO_ROOT, "package.json"));
    expect([...SYSTEM_EXTENSIONS]).toEqual([...declared]);
  });

  it("isSystemExtension classifies correctly", () => {
    expect(isSystemExtension("@cinatra-ai/nango-connector")).toBe(true);
    expect(isSystemExtension("@cinatra-ai/random-non-system")).toBe(false);
    expect(isSystemExtension("not-a-cinatra-package")).toBe(false);
  });

  it("system inventory is a SUBSET of cinatra.extensions", () => {
    // Adding a package to cinatra.systemExtensions without also declaring it
    // in cinatra.extensions would leave the prod-boot verifier
    // unable to ensure system extensions are installed.
    _resetCachedRequiredForTesting();
    const required = new Set(
      readRequiredInProdPackages(path.join(REPO_ROOT, "package.json")),
    );
    for (const pkg of SYSTEM_EXTENSIONS) {
      expect(
        required.has(pkg),
        `${pkg} is in cinatra.systemExtensions but not in cinatra.extensions`,
      ).toBe(true);
    }
  });

  describe("readSystemExtensions — fail-closed reader", () => {
    it("throws when the declaration is missing", () => {
      const file = tmpPackageJson({ name: "x", cinatra: {} });
      expect(() => readSystemExtensions(file)).toThrow(/systemExtensions/);
    });

    it("throws when the declaration is empty", () => {
      const file = tmpPackageJson({ name: "x", cinatra: { systemExtensions: [] } });
      expect(() => readSystemExtensions(file)).toThrow(/non-empty/);
    });

    it("throws on a non-name entry (version ranges live in extensions)", () => {
      for (const bad of ["@cinatra-ai/nango-connector@^0.1.0", "bare-name", 42, null]) {
        const file = tmpPackageJson({ name: "x", cinatra: { systemExtensions: [bad] } });
        expect(() => readSystemExtensions(file)).toThrow(/invalid|scoped/);
      }
    });

    it("throws when package.json is unreadable", () => {
      expect(() => readSystemExtensions(path.join(tmpdir(), "does-not-exist", "package.json"))).toThrow(
        /cannot read/,
      );
    });

    it("dedupes + freezes the returned set", () => {
      const file = tmpPackageJson({
        name: "x",
        cinatra: { systemExtensions: ["@cinatra-ai/a-pkg", "@cinatra-ai/a-pkg", "@cinatra-ai/b-pkg"] },
      });
      const set = readSystemExtensions(file);
      expect([...set]).toEqual(["@cinatra-ai/a-pkg", "@cinatra-ai/b-pkg"]);
      expect(Object.isFrozen(set)).toBe(true);
    });
  });
});

// cinatra#1036 — the removal choke-point. System extensions can be UPDATED but
// never removed from the live runtime; this is the single kind-agnostic gate.
describe("assertCanRemoveExtension — removal choke-point", () => {
  const INTENTS: ExtensionRemovalIntent[] = [
    "uninstall",
    "force_delete",
    "archive",
    "disable",
    "purge",
    "registry_remove",
  ];

  it("throws SystemExtensionRemovalError with the exact copy for a system package (every intent)", () => {
    // Uses a REAL system package name from the host declaration so the test
    // exercises the actual inventory, not a fixture.
    const systemPkg = SYSTEM_EXTENSIONS[0];
    expect(isSystemExtension(systemPkg)).toBe(true);
    for (const intent of INTENTS) {
      let thrown: unknown;
      try {
        assertCanRemoveExtension(systemPkg, intent);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(SystemExtensionRemovalError);
      expect((thrown as SystemExtensionRemovalError).message).toBe(
        "System extension — can be updated but not deleted.",
      );
      expect((thrown as SystemExtensionRemovalError).message).toBe(SYSTEM_EXTENSION_REMOVAL_MESSAGE);
      expect((thrown as SystemExtensionRemovalError).code).toBe("SYSTEM_EXTENSION_PROTECTED");
      expect((thrown as SystemExtensionRemovalError).packageName).toBe(systemPkg);
      expect((thrown as SystemExtensionRemovalError).intent).toBe(intent);
    }
  });

  it("guards nango-connector specifically (the issue's motivating example)", () => {
    expect(() => assertCanRemoveExtension("@cinatra-ai/nango-connector", "uninstall")).toThrow(
      SystemExtensionRemovalError,
    );
  });

  it("is a no-op (no throw) for a non-system package — update/uninstall of a normal ext is unaffected", () => {
    expect(isSystemExtension("@acme/not-a-system-ext")).toBe(false);
    for (const intent of INTENTS) {
      expect(() => assertCanRemoveExtension("@acme/not-a-system-ext", intent)).not.toThrow();
    }
  });
});
