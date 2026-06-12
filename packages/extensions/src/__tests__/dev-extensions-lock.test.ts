// Dev-extensions clone-back lock ↔ cinatraDevExtensions consistency
// (cinatra#141 — the pinning half of the reproducible-CI contract).
//
// CI materializes the companion extension repos DETACHED at committed shas
// (scripts/ci/sync-dev-extensions.mjs --pinned). The pin set is PARTITIONED:
// cinatra-required-extensions.lock.json is the single authority for the prod
// bootable set; cinatra-dev-extensions.lock.json pins every OTHER
// `cinatraDevExtensions` entry. This suite is the gate of record that the
// partition stays exact:
//   - disjoint: no package pinned in both locks;
//   - complete: every cinatraDevExtensions entry has exactly one pin across
//     the two locks (the pinned clone-back would fail closed at run time,
//     but THIS catches it at PR time, before 15 jobs each discover it);
//   - no stale pins: every dev-lock entry is a cinatraDevExtensions entry;
//   - shape-valid + sorted (deterministic diffs) + repo slug matches the
//     committed config URL (a retargeted repo requires a re-pin).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const DEV_LOCK_PATH = resolve(REPO_ROOT, "cinatra-dev-extensions.lock.json");
const REQUIRED_LOCK_PATH = resolve(REPO_ROOT, "cinatra-required-extensions.lock.json");

type DevLockEntry = {
  packageName: string;
  repo: string;
  resolvedSha: string;
};

function readDevConfig(): Record<string, unknown> {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));
  return pkg?.cinatraDevExtensions ?? pkg?.cinatra?.devExtensions ?? {};
}

function readDevLock(): DevLockEntry[] {
  return JSON.parse(readFileSync(DEV_LOCK_PATH, "utf8")).packages as DevLockEntry[];
}

function readRequiredLockNames(): Set<string> {
  const doc = JSON.parse(readFileSync(REQUIRED_LOCK_PATH, "utf8"));
  return new Set((doc.packages as { packageName: string }[]).map((p) => p.packageName));
}

function configUrlOf(spec: unknown): string {
  return spec && typeof spec === "object" ? String((spec as { url?: unknown }).url ?? "") : String(spec);
}

describe("dev-extensions clone-back lock (pinned CI universe)", () => {
  it("partitions the universe with the required lock: disjoint + complete", () => {
    const config = readDevConfig();
    const requiredNames = readRequiredLockNames();
    const devNames = readDevLock().map((p) => p.packageName);

    // disjoint: the required lock is the single authority for its packages
    expect(devNames.filter((n) => requiredNames.has(n))).toEqual([]);

    // complete: every declared dev extension is pinned in exactly one lock
    const pinned = new Set([...devNames, ...requiredNames]);
    const unpinned = Object.keys(config).filter((n) => !pinned.has(n));
    expect(unpinned).toEqual([]);

    // no stale pins: the dev lock carries nothing undeclared
    const stale = devNames.filter((n) => !(n in config));
    expect(stale).toEqual([]);

    // no duplicate dev-lock entries
    expect(new Set(devNames).size).toBe(devNames.length);
  });

  it("entries are shape-valid and sorted by packageName", () => {
    const lock = readDevLock();
    expect(lock.length).toBeGreaterThan(0);
    for (const p of lock) {
      expect(p.packageName).toMatch(/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
      expect(p.repo).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(p.resolvedSha).toMatch(/^[0-9a-f]{40}$/);
      // The git commit sha IS the content pin for a clone-back; tarball
      // integrity fields (packageVersion/treeSha256) are prod-acquisition-only
      // and must NOT leak into this lock (two authorities would drift).
      expect(p).not.toHaveProperty("treeSha256");
      expect(p).not.toHaveProperty("packageVersion");
    }
    const names = lock.map((p) => p.packageName);
    expect(names).toEqual([...names].sort());
  });

  it("every pin's repo slug matches the committed config URL (retarget requires re-pin)", () => {
    const config = readDevConfig();
    for (const p of readDevLock()) {
      const url = configUrlOf(config[p.packageName]);
      const m = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
      expect(m, `${p.packageName}: config URL "${url}" must be a github https URL`).not.toBeNull();
      expect(p.repo.toLowerCase()).toBe(m![1].toLowerCase());
    }
  });
});
