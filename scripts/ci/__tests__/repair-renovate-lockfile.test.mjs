// Unit tests for the FULL Renovate lockfile repair pure core
// (scripts/ci/repair-renovate-lockfile.mjs). Pure functions only — no git, no
// pnpm, no IO. They guard the two fail-closed gates the orchestration relies on:
//   1. the ALLOWLIST — a Renovate branch may only change pnpm-lock.yaml and
//      dependency-VERSION values in package.json; anything else is refused;
//   2. the SANE-DIFF — after regeneration the lockfile must be a lockfile-only,
//      bump-only change: checksum restored + correct, importer key set equal to
//      base, and the ONLY importer specifier changes are exactly the bump.
import { describe, expect, it } from "vitest";

import {
  DEP_BUCKETS,
  classifyChangedPaths,
  diffPackageJsonDeps,
  extractChecksum,
  extractImporterKeys,
  extractImporterSpecifiers,
  isRegistrySpecifier,
  saneDiff,
} from "../repair-renovate-lockfile.mjs";

const CSUM = "sha256-T2r/ZlrLvWnpUdmw0n416n6+G5ZaTFZaOowYIHGiqDQ=";

// A structurally faithful (tiny) lockfile: checksum + a two-importer graph with
// the exact indentation pnpm writes (2/4/6/8 spaces).
function lock({ katex = "^0.16.47", eslint = "10.4.0", extra = "" } = {}) {
  return `lockfileVersion: '9.0'

pnpmfileChecksum: ${CSUM}

patchedDependencies:
  '@a2a-js/sdk@0.3.13': patches/x.patch

importers:

  .:
    dependencies:
      katex:
        specifier: ${katex}
        version: ${katex.replace(/[^0-9.]/g, "")}
    devDependencies:
      eslint:
        specifier: ${eslint}
        version: ${eslint}
  packages/chat:
    dependencies:
      katex:
        specifier: ${katex}
        version: ${katex.replace(/[^0-9.]/g, "")}
${extra}
packages:

  katex@0.16.47: {}
`;
}

describe("classifyChangedPaths", () => {
  it("allows pnpm-lock.yaml and any package.json, flags the rest", () => {
    const r = classifyChangedPaths([
      "pnpm-lock.yaml",
      "package.json",
      "packages/chat/package.json",
    ]);
    expect(r.lockChanged).toBe(true);
    expect(r.packageJson).toEqual(["package.json", "packages/chat/package.json"]);
    expect(r.disallowed).toEqual([]);
  });

  it("refuses pnpmfile / workspace / script / workflow / lock-pin changes", () => {
    const r = classifyChangedPaths([
      "pnpm-lock.yaml",
      ".pnpmfile.cjs",
      "pnpm-workspace.yaml",
      "scripts/ci/sync-dev-extensions.mjs",
      ".github/workflows/x.yml",
      "cinatra-dev-extensions.lock.json",
    ]);
    expect(r.disallowed).toEqual([
      ".pnpmfile.cjs",
      "pnpm-workspace.yaml",
      "scripts/ci/sync-dev-extensions.mjs",
      ".github/workflows/x.yml",
      "cinatra-dev-extensions.lock.json",
    ]);
  });
});

describe("diffPackageJsonDeps", () => {
  const base = {
    name: "root",
    scripts: { build: "next build" },
    dependencies: { katex: "^0.16.47", react: "19.2.7" },
    devDependencies: { eslint: "10.4.0" },
  };

  it("accepts a pure dependency-version bump", () => {
    const head = { ...base, dependencies: { katex: "^0.18.0", react: "19.2.7" } };
    const { violations, changed } = diffPackageJsonDeps(base, head, "package.json");
    expect(violations).toEqual([]);
    expect(changed).toEqual([{ bucket: "dependencies", name: "katex", from: "^0.16.47", to: "^0.18.0" }]);
  });

  it("bumps in devDependencies are attributed to that bucket", () => {
    const head = { ...base, devDependencies: { eslint: "10.7.0" } };
    const { violations, changed } = diffPackageJsonDeps(base, head);
    expect(violations).toEqual([]);
    expect(changed).toEqual([{ bucket: "devDependencies", name: "eslint", from: "10.4.0", to: "10.7.0" }]);
  });

  it("refuses a non-dependency field change", () => {
    const head = { ...base, scripts: { build: "evil && next build" } };
    const { violations } = diffPackageJsonDeps(base, head);
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatch(/non-dependency field/);
  });

  it("refuses adding or removing a dependency (key-set change)", () => {
    const added = { ...base, dependencies: { katex: "^0.16.47", react: "19.2.7", evil: "1.0.0" } };
    expect(diffPackageJsonDeps(base, added).violations[0]).toMatch(/dependencies key set changed/);
    const removed = { ...base, dependencies: { katex: "^0.16.47" } };
    expect(diffPackageJsonDeps(base, removed).violations[0]).toMatch(/dependencies key set changed/);
  });

  it("refuses a non-string version value", () => {
    const head = { ...base, dependencies: { katex: { malicious: true }, react: "19.2.7" } };
    expect(diffPackageJsonDeps(base, head).violations[0]).toMatch(/not a version string/);
  });

  it("refuses redirecting a dep to a non-registry source (tarball / git / alias / path)", () => {
    for (const evil of [
      "https://evil.example/x.tgz",
      "git+https://evil.example/x.git",
      "file:../../../etc/passwd",
      "link:../evil",
      "npm:evil@1.0.0",
      "evil-owner/evil-repo",
      ".",
      "..",
      "payload.tgz",
      "malware.tar.gz",
    ]) {
      const head = { ...base, dependencies: { katex: evil, react: "19.2.7" } };
      const { violations, changed } = diffPackageJsonDeps(base, head);
      expect(changed).toEqual([]);
      expect(violations.join()).toMatch(/not a registry semver bump/);
    }
  });

  it("covers exactly the four buckets", () => {
    expect(DEP_BUCKETS).toEqual([
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]);
  });
});

describe("isRegistrySpecifier", () => {
  it("accepts plain registry semver ranges", () => {
    for (const v of ["^0.18.0", "10.7.0", "~1.2.3", ">=1 <2", "1.x", "*", "^1.2.3-beta.1", "0.0.57", "v5.7.284"]) {
      expect(isRegistrySpecifier(v)).toBe(true);
    }
  });
  it("rejects any source protocol / path / alias / shorthand", () => {
    for (const v of [
      "https://x/y.tgz",
      "git+ssh://git@x/y.git",
      "git@github.com:x/y.git",
      "file:./x",
      "link:../x",
      "workspace:*",
      "npm:y@1.0.0",
      "github:owner/repo",
      "owner/repo#semver:^1",
      "",
    ]) {
      expect(isRegistrySpecifier(v)).toBe(false);
    }
  });

  it("rejects pnpm's IMPLICIT local forms (leading dot dir, bare archive, windows path)", () => {
    for (const v of [".", "..", "./local", ".\\evil", "payload.tgz", "x.tar", "x.tar.gz", "x.tar.zst"]) {
      expect(isRegistrySpecifier(v)).toBe(false);
    }
  });
});

describe("lockfile extraction", () => {
  it("extracts importer keys, specifiers and the checksum at the right indents", () => {
    const text = lock();
    expect(extractImporterKeys(text)).toEqual([".", "packages/chat"]);
    const specs = extractImporterSpecifiers(text);
    expect(specs.get(".|dependencies|katex")).toBe("^0.16.47");
    expect(specs.get(".|devDependencies|eslint")).toBe("10.4.0");
    expect(specs.get("packages/chat|dependencies|katex")).toBe("^0.16.47");
    // a `version:` line at the same 8-space indent must NOT be mistaken for a spec
    expect([...specs.keys()].some((k) => k.endsWith("|version"))).toBe(false);
    expect(extractChecksum(text)).toBe(CSUM);
  });

  it("stops at the next top-level key (does not bleed into packages:)", () => {
    // `katex@0.16.47:` lives under packages: and must never be read as an importer.
    expect(extractImporterKeys(lock())).not.toContain("katex@0.16.47");
  });
});

describe("saneDiff", () => {
  const baseLock = lock({ katex: "^0.16.47" });
  const bumped = new Map([
    [".|dependencies|katex", "^0.18.0"],
    ["packages/chat|dependencies|katex", "^0.18.0"],
  ]);

  it("passes a clean, bump-only regeneration", () => {
    const regenLock = lock({ katex: "^0.18.0" });
    const v = saneDiff({ baseLock, regenLock, expectedChecksum: CSUM, bumpedSpecifiers: bumped });
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.changedSpecifierKeys.sort()).toEqual(
      [".|dependencies|katex", "packages/chat|dependencies|katex"].sort(),
    );
  });

  it("fails a missing checksum", () => {
    const regenLock = lock({ katex: "^0.18.0" }).replace(/pnpmfileChecksum: .*/, "");
    expect(saneDiff({ baseLock, regenLock, expectedChecksum: CSUM, bumpedSpecifiers: bumped }).problems.join())
      .toMatch(/no pnpmfileChecksum/);
  });

  it("fails a wrong checksum", () => {
    const regenLock = lock({ katex: "^0.18.0" }).replace(CSUM, "sha256-WRONG=");
    expect(saneDiff({ baseLock, regenLock, expectedChecksum: CSUM, bumpedSpecifiers: bumped }).problems.join())
      .toMatch(/pnpmfileChecksum mismatch/);
  });

  it("fails when the importer set changed (a stripped importer not restored)", () => {
    const regenLock = lock({ katex: "^0.18.0", extra: "" }).replace(/ {2}packages\/chat:[\s\S]*?(?=\npackages:)/, "");
    const v = saneDiff({ baseLock, regenLock, expectedChecksum: CSUM, bumpedSpecifiers: bumped });
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/importer set != base/);
  });

  it("fails an UNEXPECTED specifier change (something beyond the bump moved)", () => {
    const regenLock = lock({ katex: "^0.18.0", eslint: "10.7.0" }); // eslint moved but not in the bump map
    const v = saneDiff({ baseLock, regenLock, expectedChecksum: CSUM, bumpedSpecifiers: bumped });
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/unexpected importer specifier change.*eslint/);
  });

  it("fails when the declared bump is not reflected in the lockfile", () => {
    const regenLock = lock({ katex: "^0.16.47" }); // regeneration did not actually bump
    const v = saneDiff({ baseLock, regenLock, expectedChecksum: CSUM, bumpedSpecifiers: bumped });
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/Renovate bump not reflected/);
  });

  it("fails when there is no bump at all", () => {
    const v = saneDiff({ baseLock, regenLock: baseLock, expectedChecksum: CSUM, bumpedSpecifiers: new Map() });
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toMatch(/no dependency-version bump/);
  });
});
