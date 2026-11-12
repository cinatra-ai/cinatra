/**
 * cinatra#3862 leg 8, unit l8a2: the signed preview target and its secret
 * lookup leave.
 *
 * Unit l8a1 removed the gate capture pipeline, the only caller of the signed
 * preview target of `cms-preview-capture-policy.ts` (`resolveCaptureTarget`,
 * `parsePostId`, the per-platform preview routes and their bounds) and of the
 * tuple-scoped preview secret lookup `resolvePreviewSharedSecrets` in
 * `webhook-secret-service.ts`. Both leave now, and the class 3 ceiling of the
 * policy module falls with its top-level names.
 *
 * What stays: the registered-page capture of cinatra#4223 reads
 * `normalizeOrigin`, and the page-render primitives read the denial reasons and
 * their copy (old stored capture records carry them). The webhook secret
 * service keeps its bindingId-addressed contract.
 *
 * Source text, not behaviour: the invariant is the absence of every name (the
 * technique of `cms-preview-capture-entries-retired-3862.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SELF = path.resolve(__filename);

const POLICY = "src/lib/artifacts/cms-preview-capture-policy.ts";
const SECRET_SERVICE = "src/lib/webhook-secret-service.ts";

const RETIRED_NAMES = [
  "resolveCaptureTarget",
  "parsePostId",
  "CaptureTargetResolution",
  "PREVIEW_ADAPTERS",
  "MAX_POST_ID",
  "CMS_PREVIEW_PATH_PREFIX",
  "CMS_PREVIEW_PATH_PREFIX_DRUPAL",
  "resolvePreviewSharedSecrets",
];

// The screenshot capture record contract of the CI scripts has its own,
// unrelated `resolveCaptureTarget(rel, io)` (a write-path check). Only that one
// name is exempt, and only in these files.
const UNRELATED_SAME_NAME: Readonly<Record<string, readonly string[]>> = {
  resolveCaptureTarget: [
    "scripts/ci/lib/capture-record-contract.mjs",
    "scripts/ci/__tests__/capture-record-contract.test.mjs",
    "scripts/audit/lib/chat-hitl-capture-recorder.mjs",
  ],
};

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

/** The top-level value declarations of a module, as the class 3 ceiling counts them. */
function topLevelValueNames(text: string): string[] {
  const names = new Set<string>();
  const re = /^(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of text.matchAll(re)) names.add(match[1]!);
  return [...names].sort();
}

describe("cinatra#3862 leg 8 l8a2: the signed preview target and its secret lookup are gone", () => {
  it("the policy module keeps only the origin normalisation and the denial copy", () => {
    expect(topLevelValueNames(read(POLICY))).toEqual(["captureDenialCopy", "normalizeOrigin"]);
  });

  it("the webhook secret service has no tuple-scoped preview secret lookup", () => {
    const text = read(SECRET_SERVICE);
    expect(text).not.toMatch(/\bresolvePreviewSharedSecrets\b/);
    expect(text).toMatch(/export const webhookSecretService\b/);
  });

  it("no code, test, gate list or inventory under src/, packages/, scripts/ or config/ names a retired name", () => {
    const files = SCAN_ROOTS.flatMap((root) => scannedFiles(path.join(REPO_ROOT, root)));
    // The walk must reach the policy, the secret service, the page render and the floor, or an empty scan passes.
    for (const rel of [
      POLICY,
      SECRET_SERVICE,
      "src/lib/artifacts/registered-page-render.ts",
      "scripts/audit/application-border-gate.baseline.json",
    ]) {
      expect(files).toContain(path.join(REPO_ROOT, rel));
    }
    const hits: string[] = [];
    for (const file of files) {
      if (path.resolve(file) === SELF) continue;
      const rel = path.relative(REPO_ROOT, file);
      const text = readFileSync(file, "utf8");
      for (const name of RETIRED_NAMES) {
        if ((UNRELATED_SAME_NAME[name] ?? []).includes(rel)) continue;
        if (new RegExp(`\\b${name}\\b`).test(text)) hits.push(`${rel} :: ${name}`);
      }
    }
    expect(hits.sort()).toEqual([]);
  });

  it("the class 3 ceiling of the policy module is its two remaining names", () => {
    const floor = JSON.parse(read("scripts/audit/application-border-gate.baseline.json")) as Record<
      string,
      Record<string, { count: number }>
    >;
    expect(floor.ceilings?.[POLICY]?.count).toBe(2);
    expect(floor.names?.[`${POLICY} :: name :: cms`]?.count).toBe(1);
  });

  it("the page capture and the page render still read what stays", () => {
    const policy = read(POLICY);
    expect(policy).toMatch(/export function normalizeOrigin\b/);
    expect(policy).toMatch(/export function captureDenialCopy\b/);
    expect(policy).toMatch(/export type CaptureTargetDenial\b/);
    expect(policy).toMatch(/export interface RegisteredCaptureSite\b/);
    expect(read("src/lib/artifacts/registered-page-capture.ts")).toContain(
      'import { normalizeOrigin } from "./cms-preview-capture-policy"',
    );
    expect(read("src/lib/artifacts/registered-page-render.ts")).toMatch(
      /captureDenialCopy,[\s\S]*?from "\.\/cms-preview-capture-policy"/,
    );
  });
});
