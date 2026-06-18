// Lock ↔ extensions consistency — the acquisition half of the
// host↔extension compatibility contract.
//
// `cinatra.extensions` (root package.json) declares the prod
// base-image bootable set as versioned `name@range` entries; the committed
// cinatra-required-extensions.lock.json pins each entry to an immutable
// commit SHA + concrete packageVersion + treeSha256 that prod acquires from
// EXCLUSIVELY. This suite is the gate of record that the two stay one
// contract:
//   - bijection: every declared package has exactly one lock entry and the
//     lock carries nothing undeclared;
//   - every locked packageVersion SATISFIES its declared range, judged by
//     the same fail-closed checker the host runtime uses
//     (satisfiesRequiredVersionRange);
//   - lock entries are shape-valid and sorted (deterministic diffs).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseRequiredExtensionEntry,
  satisfiesRequiredVersionRange,
} from "../required-in-prod";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const LOCK_PATH = resolve(REPO_ROOT, "cinatra-required-extensions.lock.json");

type LockEntry = {
  packageName: string;
  repo: string;
  resolvedSha: string;
  packageVersion: string;
  treeSha256: string;
};

function readDeclared() {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
  const raw: string[] = pkg?.cinatra?.extensions ?? [];
  return raw
    .map((entry) => parseRequiredExtensionEntry(entry))
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

function readLock(): LockEntry[] {
  const doc = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  return doc.packages as LockEntry[];
}

describe("required-extensions acquisition lock", () => {
  it("is a bijection with cinatra.extensions", () => {
    const declared = readDeclared().map((e) => e.packageName);
    const locked = readLock().map((p) => p.packageName);
    expect(new Set(declared).size).toBe(declared.length); // no duplicate declarations
    expect(new Set(locked).size).toBe(locked.length); // no duplicate lock entries
    expect([...locked].sort()).toEqual([...declared].sort());
  });

  it("every locked packageVersion satisfies its declared range (fail-closed checker)", () => {
    const lockByName = new Map(readLock().map((p) => [p.packageName, p]));
    for (const entry of readDeclared()) {
      const locked = lockByName.get(entry.packageName);
      expect(locked, `${entry.packageName} missing from the lock`).toBeDefined();
      if (!locked) continue;
      // The canonical manifest pins every entry; an unpinned entry would make
      // the acquisition pin unverifiable against the declaration.
      expect(entry.versionRange, `${entry.packageName} must declare a version range`).not.toBeNull();
      expect(
        satisfiesRequiredVersionRange(locked.packageVersion, entry.versionRange as string),
        `${entry.packageName}: locked ${locked.packageVersion} must satisfy declared "${entry.versionRange}"`,
      ).toBe(true);
    }
  });

  it("entries are shape-valid and sorted by packageName", () => {
    const lock = readLock();
    expect(lock.length).toBeGreaterThan(0);
    for (const p of lock) {
      expect(p.packageName).toMatch(/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
      expect(p.repo).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(p.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
      expect(p.packageVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(p.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const names = lock.map((p) => p.packageName);
    expect(names).toEqual([...names].sort());
  });
});
