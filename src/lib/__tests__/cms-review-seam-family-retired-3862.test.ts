/**
 * cinatra#3862 leg 7, slice S3 — the CMS review seam family leaves.
 *
 * The application no longer publishes `@cinatra-ai/host:cms-review` (slice
 * S1), every repair completes through the generic completer (slice S2) and the
 * dispatch drain no longer asks the CMS repair bridge for a repair's inputs
 * (#4424). Nothing calls the seam family any more, so it leaves: the seam, its
 * boot-only runtime binder and boot phase, the CMS repair bridge, the
 * repaired-capture port, the read-back store and the contract document.
 *
 * Source text, not behaviour: the invariant is the absence of the modules and
 * of every importer (the same technique as
 * `packages/agents/src/__tests__/blog-repair-new-run-road-structural.test.ts`).
 * The page snapshot writer and the picture pair's road stayed in this slice;
 * slice S4 and leg 8 remove them.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SELF = path.resolve(__filename);

const RETIRED_FILES = [
  "src/lib/cms-review-host-seam.ts",
  "src/lib/register-cms-review-host-seam-runtime.ts",
  "packages/agents/src/lifecycle-repair-cms-production-bridge.ts",
  "packages/agents/src/cms-repaired-capture-port.ts",
  "packages/agents/src/cms-snapshot-readback-store.ts",
  "docs/internals/contracts/cms-review-adapter-contract.md",
] as const;

// The module names as an importer, a mock or a gate list writes them.
const RETIRED_NAMES = RETIRED_FILES.map((file) => path.basename(file).replace(/\.(?:ts|md)$/, ""));

const SCAN_ROOTS = ["src", "packages", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "coverage", ".turbo"]);
const SCANNED_FILE = /\.(?:[cm]?[jt]sx?|json)$/;

function scannedFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) scannedFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile() && SCANNED_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

describe("cinatra#3862 leg 7 S3 — the CMS review seam family is gone", () => {
  it("the seam, the binder, the bridge, the port, the read-back store and the contract document do not exist", () => {
    expect(RETIRED_FILES.filter((rel) => existsSync(path.join(REPO_ROOT, rel)))).toEqual([]);
  });

  it("no code, test, gate list or package manifest under src/, packages/ or scripts/ names one of them", () => {
    const files = SCAN_ROOTS.flatMap((root) => scannedFiles(path.join(REPO_ROOT, root)));
    // The walk must reach the boot phases and the agents' manifest, or an empty scan passes.
    expect(files).toContain(path.join(REPO_ROOT, "src/lib/boot/phases/system-loops.ts"));
    expect(files).toContain(path.join(REPO_ROOT, "packages/agents/package.json"));
    const namers = files
      .filter((file) => path.resolve(file) !== SELF)
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return RETIRED_NAMES.some((name) => text.includes(name));
      })
      .map((file) => path.relative(REPO_ROOT, file))
      .sort();
    expect(namers).toEqual([]);
  });

  it("boot has no phase that binds the CMS review seam", () => {
    expect(read("src/lib/boot/phases/system-loops.ts")).not.toContain("bind-cms-review-host-seam");
  });

  it("the agents package exports neither the read-back store nor the repaired-capture port", () => {
    const manifest = JSON.parse(read("packages/agents/package.json")) as { exports?: Record<string, unknown> };
    const exported = Object.keys(manifest.exports ?? {});
    expect(exported).not.toContain("./cms-snapshot-readback-store");
    expect(exported).not.toContain("./cms-repaired-capture-port");
  });

  it("no document links the retired contract", () => {
    for (const rel of [
      "docs/internals/governance/lifecycle-review-policy.md",
      "docs/internals/workflows/authoring-lifecycle-producers.md",
    ]) {
      expect(read(rel)).not.toContain("cms-review-adapter-contract");
    }
  });
});
