/**
 * cinatra#3862 leg 8, unit l8b (first part): the review surfaces stop drawing
 * the stored capture pair.
 *
 * The approved design draws no pinned capture pair on any page: the lifecycle
 * cards spec, section III ("What the target shows"), says so in so many words
 * ("A pinned capture pair is not drawn anywhere") and names the drawn fallback
 * (the target's renderer, else the metadata floor). Its section VII draws the
 * verification reading without a picture block, and the artifact review spec,
 * section XI.8, draws the CMS page as one view with no picture pair. Since unit
 * l8a nothing writes new captures, so only old reviews still hold a stored pair.
 *
 * So the review gate's "Visual before / after" pair and the verification view's
 * "Reviewed / applied" (and "Reviewed / repaired") pair leave, with every road
 * that read them for a surface: the page's loader, the repair pairing, the
 * island's capture road and the streamed promise each target carried.
 *
 * What stays for the next unit: the capture route, the capture store and its
 * view module (the route still serves old stored bytes until it leaves).
 *
 * Source text, not behaviour: the invariant is the absence of every name (the
 * technique of `cms-preview-signed-target-retired-3862.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

const REVIEW_DIR = "src/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]";
const PAIR_COMPONENT = `${REVIEW_DIR}/review-pinned-capture.tsx`;
const SURFACE_MODEL = "src/lib/artifacts/review-surface-model.ts";

// The capture route reads the store until the next unit removes it with the
// store; it is the one place under src/app that may still name the store.
const STAYS_FOR_NOW = "src/app/api/lifecycle-views/capture/";

const RETIRED_NAMES = [
  "ReviewPinnedCapture",
  "loadPinnedCapturePair",
  "loadPinnedRepairPair",
  "capturePair",
  "visualPair",
  "buildBrokerCapturePair",
  "PinnedCapturePairView",
  "versionPinnedCaptureImageUrl",
  "repairPairingOnce",
  "RepairPairing",
];

const RETIRED_MODULES = [
  "review-pinned-capture",
  "cms-preview-capture-view",
  "cms-preview-capture-store",
  "widget-capture-egress",
];

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

describe("cinatra#3862 leg 8 l8b: the review surfaces draw no stored capture pair", () => {
  it("the pair component is gone", () => {
    expect(existsSync(path.join(REPO_ROOT, PAIR_COMPONENT))).toBe(false);
  });

  it("no code or test under src/app, and not the surface model, names a retired name or module", () => {
    const files = [
      ...scannedFiles(path.join(REPO_ROOT, "src/app")),
      path.join(REPO_ROOT, SURFACE_MODEL),
    ];
    // The walk must reach the readers, or an empty scan passes.
    for (const rel of [
      `${REVIEW_DIR}/page.tsx`,
      `${REVIEW_DIR}/review-target-panel.tsx`,
      `${REVIEW_DIR}/verification-view.tsx`,
      "src/app/lifecycle/review-island/page.tsx",
      "src/app/artifacts/[id]/review-gate-ports.ts",
      "src/app/artifacts/[id]/review-surface-roads.ts",
    ]) {
      expect(files).toContain(path.join(REPO_ROOT, rel));
    }
    const hits: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file);
      if (rel.startsWith(STAYS_FOR_NOW)) continue;
      const text = readFileSync(file, "utf8");
      for (const name of RETIRED_NAMES) {
        if (new RegExp(`\\b${name}\\b`).test(text)) hits.push(`${rel} :: ${name}`);
      }
      for (const mod of RETIRED_MODULES) {
        if (text.includes(mod)) hits.push(`${rel} :: ${mod}`);
      }
    }
    expect(hits.sort()).toEqual([]);
  });

  it("a streamed review target carries its identity and its preparation only", () => {
    const model = read(SURFACE_MODEL);
    const body = /export interface ReviewTargetStream \{([\s\S]*?)\n\}/.exec(model)?.[1];
    expect(body).toBeDefined();
    const fields = [...body!.matchAll(/^ {2}([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]);
    expect(fields).toEqual(["target", "prepared"]);
  });

  it("the verification view still mounts the one verification card", () => {
    const view = read(`${REVIEW_DIR}/verification-view.tsx`);
    expect(view).toMatch(/<\s*VerificationSummaryCard\b/);
  });

  it("the capture route, the store and its view stay for the next unit", () => {
    for (const rel of [
      "src/app/api/lifecycle-views/capture/route.ts",
      "src/lib/artifacts/cms-preview-capture-store.ts",
      "src/lib/artifacts/cms-preview-capture-view.ts",
    ]) {
      expect(existsSync(path.join(REPO_ROOT, rel))).toBe(true);
    }
  });
});
