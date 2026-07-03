import { describe, it, expect, beforeEach, afterEach } from "vitest";
// Bundled-payload digest recorder (cinatra#795) — parity + determinism suite.
//
// The recorder is a plain build-time .mjs (it cannot import the TS host
// module), so it keeps a LITERAL MIRROR of `contentHashOfEntries`
// (src/lib/extension-package-store-core.ts). This suite is the parity guard
// that makes the mirror trustworthy: both implementations must produce the
// SAME digest for the same entries, the exclusion set must contain the two
// build/runtime marker filenames it mirrors (the acquisition marker and the
// store sidecar), and the recorded digest must be deterministic — invariant
// under marker-file churn, node_modules population and entry order, sensitive
// to real payload changes.
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUNDLED_DIGEST_EXCLUDED_DIRNAMES,
  BUNDLED_DIGEST_EXCLUDED_FILENAMES,
  collectPayloadEntries,
  computeBundledPackageDigest,
  contentHashOfEntriesMirror,
  recordBundledDigests,
} from "../record-bundled-digests.mjs";
// Canonical TS implementation + grammar (imported by the host at runtime).
import {
  contentHashOfEntries,
  isStoreDigestSegment,
  STORE_SIDECAR_FILENAME,
} from "@/lib/extension-package-store-core";
// The acquisition-marker filename the recorder must exclude (identical
// payloads acquired at different times must digest identically — the marker
// carries `acquiredAt`).
import { ACQUISITION_MARKER_FILENAME } from "../../../packages/cli/src/prod-extension-acquisition.mjs";

const entries = (spec: Record<string, string>) =>
  Object.entries(spec).map(([relPath, text]) => ({
    relPath,
    bytes: new TextEncoder().encode(text),
  }));

describe("contentHashOfEntriesMirror — parity with the canonical TS fold", () => {
  it("agrees with contentHashOfEntries on a representative corpus", () => {
    const corpora = [
      entries({}),
      entries({ "package.json": '{"name":"x"}' }),
      entries({ "package.json": '{"name":"x"}', "src/index.ts": "export {};" }),
      entries({ "b.txt": "b", "a.txt": "a", "a/b.txt": "nested" }),
      entries({ "utf8.txt": "päylöad — digest ✓" }),
    ];
    for (const c of corpora) {
      expect(contentHashOfEntriesMirror(c)).toBe(contentHashOfEntries(c));
    }
  });

  it("is order-insensitive and emits the store digest-segment grammar", () => {
    const a = entries({ "x.txt": "1", "y.txt": "2" });
    const b = [...a].reverse();
    const digest = contentHashOfEntriesMirror(a);
    expect(contentHashOfEntriesMirror(b)).toBe(digest);
    expect(isStoreDigestSegment(digest)).toBe(true);
    expect(digest).toHaveLength(128); // hex sha512
  });
});

describe("exclusion sets mirror the build/runtime marker filenames", () => {
  it("excludes the acquisition marker and the store sidecar by their canonical names", () => {
    expect(BUNDLED_DIGEST_EXCLUDED_FILENAMES.has(ACQUISITION_MARKER_FILENAME)).toBe(true);
    expect(BUNDLED_DIGEST_EXCLUDED_FILENAMES.has(STORE_SIDECAR_FILENAME)).toBe(true);
    expect(BUNDLED_DIGEST_EXCLUDED_DIRNAMES.has("node_modules")).toBe(true);
    expect(BUNDLED_DIGEST_EXCLUDED_DIRNAMES.has(".git")).toBe(true);
  });
});

describe("computeBundledPackageDigest — determinism over a real directory", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bundled-digest-"));
    writeFileSync(join(dir, "package.json"), '{"name":"@cinatra-ai/x","version":"1.0.0"}');
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is stable across identical trees and invariant under excluded content", () => {
    const base = computeBundledPackageDigest(dir);
    expect(isStoreDigestSegment(base)).toBe(true);

    // Acquisition marker churn (differs per build) must not change the digest.
    writeFileSync(join(dir, ACQUISITION_MARKER_FILENAME), '{"acquiredAt":"2026-07-03T00:00:00Z"}');
    expect(computeBundledPackageDigest(dir)).toBe(base);
    writeFileSync(join(dir, ACQUISITION_MARKER_FILENAME), '{"acquiredAt":"2026-07-04T12:34:56Z"}');
    expect(computeBundledPackageDigest(dir)).toBe(base);

    // node_modules population (pnpm links between acquire and build) — invariant.
    mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = 1;");
    expect(computeBundledPackageDigest(dir)).toBe(base);

    // Symlinks are not payload — invariant.
    symlinkSync(join(dir, "package.json"), join(dir, "link.json"));
    expect(computeBundledPackageDigest(dir)).toBe(base);

    // A REAL payload change must change the digest.
    writeFileSync(join(dir, "src", "index.ts"), "export const changed = true;\n");
    expect(computeBundledPackageDigest(dir)).not.toBe(base);
  });

  it("collectPayloadEntries uses POSIX relPaths rooted at the package dir", () => {
    const rels = collectPayloadEntries(dir)
      .map((e) => e.relPath)
      .sort();
    expect(rels).toEqual(["package.json", "src/index.ts"]);
  });
});

describe("recordBundledDigests — document shape over a scope/slug tree", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bundled-digest-root-"));
    const pkg = join(root, "cinatra-ai", "x-connector");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@cinatra-ai/x-connector", version: "0.2.0", cinatra: { kind: "connector" } }),
    );
    // A dir without package.json is skipped, not fatal.
    mkdirSync(join(root, "cinatra-ai", "not-a-package"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("records name → { version, kind, digest } with the digest grammar", () => {
    const doc = recordBundledDigests(root);
    expect(doc.formatVersion).toBe(1);
    const entry = doc.packages["@cinatra-ai/x-connector"];
    expect(entry).toBeDefined();
    expect(entry.version).toBe("0.2.0");
    expect(entry.kind).toBe("connector");
    expect(isStoreDigestSegment(entry.digest)).toBe(true);
    expect(Object.keys(doc.packages)).toHaveLength(1);
  });

  it("throws on a missing extension root (fail-closed for the image build)", () => {
    expect(() => recordBundledDigests(join(root, "absent"))).toThrow(/does not exist/);
  });
});
