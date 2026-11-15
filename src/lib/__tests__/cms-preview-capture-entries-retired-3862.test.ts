/**
 * cinatra#3862 leg 8, unit l8a1 — the gate capture pipeline leaves.
 *
 * Since slices S3 and S4 nothing calls the capture entries of the CMS review
 * gate: the seam that captured the before/after pair at gate creation, the
 * post-apply read-back and the repaired capture are gone. So the pipeline
 * module (`cms-preview-capture.ts`) and the region composition it alone used
 * (`cms-preview-region-composition.ts`) leave, with their floor entries.
 *
 * What stays: the registered-page capture of cinatra#4223 still fetches a page
 * with the guarded GET and renders it in the isolated subprocess. Those
 * primitives (the trimmed host seams, the guarded fetch, the subprocess render,
 * the degrade reasons and their copy) move to `registered-page-render.ts`. The
 * pinned-capture store, its view and its route stay for leg 8b. The signed
 * preview target of the policy module and its secret lookup leave in l8a2.
 *
 * Source text, not behaviour: the invariant is the absence of the modules and
 * of every name of them (the technique of `cms-snapshot-writer-retired-3862.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SELF = path.resolve(__filename);

const PIPELINE = "src/lib/artifacts/cms-preview-capture.ts";
const COMPOSITION = "src/lib/artifacts/cms-preview-region-composition.ts";
const KEPT_PRIMITIVES = "src/lib/artifacts/registered-page-render.ts";

// Every exported entry of the pipeline that only the gate called, its private
// bindings that named a platform, and the composition entry. Matched as whole
// words, so a longer name of another suite (for example a `...ForGate` name a
// retirement suite lists) is no match of a shorter one.
const RETIRED_NAMES = [
  "capturePinnedPreview",
  "capturePinnedPreviewPair",
  "capturePostApplyPreview",
  "captureRepairedPreview",
  "captureStatesItsGap",
  "capturePinnedPreviewForGate",
  "capturePinnedPreviewPairForGate",
  "capturePostApplyPreviewForGate",
  "WORDPRESS_PREVIEW_BINDING",
  "DRUPAL_PREVIEW_BINDING",
  "PREVIEW_BINDINGS",
  "composeProposedRegions",
];
const RETIRED_NAME_RES = RETIRED_NAMES.map((name) => new RegExp(`\\b${name}\\b`));

// A reference to either module: its file name, or an import specifier that ends
// in the module name. The object type id `@cinatra-ai/objects:cms-preview-capture`
// and the sibling modules (`cms-preview-capture-store`, `-view`, `-policy`) are
// no match: they stay.
const MODULE_REFERENCE_RES = [
  /cms-preview-capture\.ts/,
  /["'`](?:@\/lib\/artifacts\/|\.\.?\/(?:[\w.-]+\/)*)cms-preview-capture["'`]/,
  /cms-preview-region-composition/,
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

describe("cinatra#3862 leg 8 l8a1 — the gate capture pipeline is gone", () => {
  it("the pipeline module and the region composition module do not exist", () => {
    expect(existsSync(path.join(REPO_ROOT, PIPELINE))).toBe(false);
    expect(existsSync(path.join(REPO_ROOT, COMPOSITION))).toBe(false);
  });

  it("no code, test, gate list or inventory under src/, packages/, scripts/ or config/ names either module or a retired entry", () => {
    const files = SCAN_ROOTS.flatMap((root) => scannedFiles(path.join(REPO_ROOT, root)));
    // The walk must reach the page capture, the store and the floor, or an empty scan passes.
    expect(files).toContain(path.join(REPO_ROOT, "src/lib/artifacts/registered-page-capture.ts"));
    expect(files).toContain(path.join(REPO_ROOT, "src/lib/artifacts/cms-preview-capture-store.ts"));
    expect(files).toContain(path.join(REPO_ROOT, "scripts/audit/application-border-gate.baseline.json"));
    const namers = files
      .filter((file) => path.resolve(file) !== SELF)
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return (
          RETIRED_NAME_RES.some((re) => re.test(text)) || MODULE_REFERENCE_RES.some((re) => re.test(text))
        );
      })
      .map((file) => path.relative(REPO_ROOT, file))
      .sort();
    expect(namers).toEqual([]);
  });

  it("the application border floor holds no entry of either module", () => {
    const floor = JSON.parse(read("scripts/audit/application-border-gate.baseline.json")) as Record<
      string,
      Record<string, unknown>
    >;
    for (const section of ["types", "names", "ceilings"]) {
      const keys = Object.keys(floor[section] ?? {});
      expect(keys.filter((key) => key.startsWith(PIPELINE) || key.startsWith(COMPOSITION))).toEqual([]);
    }
  });

  it("the page capture keeps its primitives in their own module, and the leg 8b modules stay", () => {
    expect(existsSync(path.join(REPO_ROOT, KEPT_PRIMITIVES))).toBe(true);
    const kept = read(KEPT_PRIMITIVES);
    for (const name of [
      "createPreviewCaptureDeps",
      "fetchPreviewGuarded",
      "renderIsolatedSubprocess",
      "captureDegradeCopy",
      "CaptureDegradeReason",
      "PreviewCaptureDeps",
    ]) {
      expect(kept).toMatch(new RegExp(`export (?:async function|function|type|interface) ${name}\\b`));
    }
    expect(read("src/lib/artifacts/registered-page-capture.ts")).toContain('from "./registered-page-render"');
    expect(read("src/lib/artifact-page-capture-tool.ts")).toContain('from "@/lib/artifacts/registered-page-render"');
    for (const rel of [
      "src/lib/artifacts/cms-preview-capture-store.ts",
      "src/lib/artifacts/cms-preview-capture-view.ts",
      "src/lib/artifacts/cms-preview-capture-policy.ts",
      "src/lib/artifacts/cms-preview-inertness.ts",
      "scripts/preview-capture/isolated-render.mjs",
    ]) {
      expect(existsSync(path.join(REPO_ROOT, rel))).toBe(true);
    }
  });
});
