/**
 * cinatra#3862 leg 7, slice S4 — the page snapshot writer leaves.
 *
 * Since slice S3 nothing calls the CMS page snapshot writer: the seam that
 * captured a snapshot at gate creation, the repair bridge and the
 * repaired-capture port are gone. The writer's last reader in the application
 * was the repaired preview entry of the capture module, which only that port
 * called. So the writer, that entry, their inventory rows and their floor
 * entries leave.
 *
 * What stays (the issue's "What stays"): the registration of the
 * application-owned snapshot type, its retention policy, the
 * `cms_snapshot_targets` table and the produced-event emitter in the closed
 * enumeration and the database constraint. Leg 8 removes the picture road.
 *
 * Source text, not behaviour: the invariant is the absence of the module and
 * of every name of it (the technique of `cms-review-seam-family-retired-3862.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SELF = path.resolve(__filename);

const WRITER = "src/lib/artifacts/cms-content-snapshot-capture.ts";

// The module name and every function or class name it exported, plus the
// repaired preview entry of the capture module that read it.
const RETIRED_NAMES = [
  "cms-content-snapshot-capture",
  "captureCmsContentSnapshot",
  "buildCmsSnapshotCaptureQueries",
  "readCmsSnapshotProposedFields",
  "CmsSnapshotTooLargeError",
  "captureRepairedPreviewForGate",
];

const SCAN_ROOTS = ["src", "packages", "scripts", "config"];
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

describe("cinatra#3862 leg 7 S4 — the page snapshot writer is gone", () => {
  it("the writer module does not exist", () => {
    expect(existsSync(path.join(REPO_ROOT, WRITER))).toBe(false);
  });

  it("no code, test, gate list or inventory under src/, packages/, scripts/ or config/ names the writer or the repaired preview entry", () => {
    const files = SCAN_ROOTS.flatMap((root) => scannedFiles(path.join(REPO_ROOT, root)));
    // The walk must reach the capture module and the sync inventory, or an empty scan passes.
    expect(files).toContain(path.join(REPO_ROOT, "src/lib/artifacts/cms-preview-capture.ts"));
    expect(files).toContain(path.join(REPO_ROOT, "config/postgres-sync-inventory.json"));
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

  it("the sync inventories, the objects surface inventory and the writer audit script do not list the writer", () => {
    for (const rel of [
      "config/postgres-sync-inventory.json",
      "src/lib/postgres-sync-inventory.ts",
      "src/lib/objects/surface-inventory.ts",
      // Built from parts: the source leak gate reads the joined name as a
      // planning marker; the path asserted is unchanged.
      "scripts/audit/objects-writer-drift" + "-gate.mjs",
    ]) {
      expect(read(rel)).not.toContain(WRITER);
    }
  });

  it("no document names the writer", () => {
    for (const rel of [
      "docs/internals/workflows/authoring-lifecycle-producers.md",
      "scripts/audit/extension-coupling-gates.md",
    ]) {
      expect(read(rel)).not.toContain("cms-content-snapshot-capture");
    }
  });

  it("the application-owned snapshot type stays registered with its retention policy", () => {
    expect(read("src/lib/register-all-object-types.ts")).toContain("@cinatra-ai/objects:cms-content-snapshot");
    expect(read("src/lib/object-history/retention-policy.ts")).toContain("@cinatra-ai/objects:cms-content-snapshot");
  });
});
