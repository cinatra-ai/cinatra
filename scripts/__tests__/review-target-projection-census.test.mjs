// THE REVIEW TARGET'S PROJECTION CENSUS: a WARN-ONLY cross-check.
//
// A pinned target's identity leaves the projection section of the protocol's
// lifecycle cards as a `ReviewTargetKey`, a compile-time label whose runtime
// value is the revision id (`review-target-projection.test.ts` pins the slips
// its type refuses). The census lists, as warnings, some lines the type does
// not see. This file pins how it classifies a line and that it never fails a
// build; it does not, and cannot, prove the census complete.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MODULE_FILE, NOT_TARGET_RULES, census, moduleProjections } from "../review-target-projection-census.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "review-target-projection-census.mjs");

describe("the review target's projection census", () => {
  it("runs over the repository, prints its warnings, and never fails a build", () => {
    const run = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/^hits \d+ unlisted \d+ stale \d+ \(warnings only\)$/m);
  });

  it("prints an unlisted hit and stale rules as warnings, and still exits 0", () => {
    // The repository itself may carry no warning, so the exit code is pinned
    // on a tree that does: the script, the real projection section and ONE
    // consumer that composes a key itself. The exemption rules name files this
    // tree lacks, so they print as stale as well.
    const root = mkdtempSync(path.join(tmpdir(), "projection-census-"));
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", path.basename(SCRIPT)), readFileSync(SCRIPT, "utf8"));
    mkdirSync(path.join(root, path.dirname(MODULE_FILE)), { recursive: true });
    writeFileSync(path.join(root, MODULE_FILE), readFileSync(path.join(ROOT, MODULE_FILE), "utf8"));
    mkdirSync(path.join(root, "src", "lib"), { recursive: true });
    writeFileSync(
      path.join(root, "src", "lib", "consumer.ts"),
      "export const k = (t: { artifactId: string; representationRevisionId: string }) =>\n" +
        "  `${t.artifactId}:${t.representationRevisionId}`;\n",
    );
    const run = spawnSync(process.execPath, [path.join(root, "scripts", path.basename(SCRIPT))], { encoding: "utf8" });
    expect(run.stderr).toMatch(/^WARN UNLISTED src\/lib\/consumer\.ts:2 \[id-template\] /m);
    expect(run.stderr).toMatch(/^WARN STALE RULE /m);
    expect(run.stdout).toMatch(/^hits \d+ unlisted 1 stale [1-9]\d* \(warnings only\)$/m);
    expect(run.status).toBe(0);
  });

  it("names a reason for every exemption", () => {
    for (const [file, needle, reason] of NOT_TARGET_RULES) {
      expect(file.length, needle).toBeGreaterThan(0);
      expect(needle.length, file).toBeGreaterThan(0);
      expect(reason.length, `${file}: ${needle}`).toBeGreaterThan(0);
    }
  });

  it("reads the projections from the section itself", () => {
    expect(moduleProjections(ROOT)).toEqual(
      expect.arrayContaining([
        "reviewTargetIdRefusal",
        "projectReviewTargetPathSegment",
        "reviewTargetVersionPath",
        "projectReviewIslandTargetSelector",
        "projectReviewTargetKey",
        "readReviewIslandTargetSelector",
        "selectReviewIslandTargets",
        "composeReviewIslandAddress",
        "withReviewIslandTarget",
        "projectReviewTargetHeaderRevision",
        "reviewGateTargetPairKeys",
        "mintReviewTargetIslandAddresses",
        "readReviewTargetIslandAddresses",
        "reviewTargetIslandAddressOf",
        "reviewGateTargetDrawing",
        "reviewTargetStreamKey",
        "reviewTargetRevisionMarker",
      ]),
    );
  });
});

describe("the census classifies a line", () => {
  // A tree with the real projection section and ONE consumer, so the search
  // runs exactly as it runs on the repository.
  function outcomesOf(consumer, file = "consumer.ts") {
    const root = mkdtempSync(path.join(tmpdir(), "projection-census-"));
    mkdirSync(path.join(root, path.dirname(MODULE_FILE)), { recursive: true });
    writeFileSync(path.join(root, MODULE_FILE), readFileSync(path.join(ROOT, MODULE_FILE), "utf8"));
    mkdirSync(path.join(root, "src", "lib"), { recursive: true });
    writeFileSync(path.join(root, "src", "lib", file), consumer);
    return census(root)
      .hits.filter((hit) => hit.path === `src/lib/${file}`)
      .map((hit) => `${hit.kinds} ${hit.outcome}`);
  }

  it("a consumer that encodes a target id itself is UNLISTED", () => {
    expect(
      outcomesOf(
        "export const href = (t: { representationRevisionId: string }) =>\n" +
          "  `/x/${encodeURIComponent(t.representationRevisionId)}`;\n",
      ),
    ).toEqual(["encode,id-template UNLISTED"]);
  });

  it("a consumer that keys a drawing by a target id itself is UNLISTED", () => {
    expect(
      outcomesOf(
        "export const k = (t: { artifactId: string; representationRevisionId: string }) =>\n" +
          "  `${t.artifactId}:${t.representationRevisionId}`;\n",
      ),
    ).toEqual(["id-template UNLISTED"]);
  });

  it("a template around a section call is UNLISTED: it composes a key the section did not make", () => {
    expect(
      outcomesOf(
        "// representationRevisionId\n" +
          "export const k = (i: number, target: { artifactId: string; representationRevisionId: string }) =>\n" +
          "  `${i}:${reviewTargetStreamKey(i, target)}`;\n",
      ),
    ).toEqual(["id-template UNLISTED"]);
  });

  it("a React key over a section call is UNLISTED, whole or wrapped: no line is labelled VIA-MODULE", () => {
    expect(
      outcomesOf(
        "// representationRevisionId\n" +
          "export const el = (index: number, stream: { target: { artifactId: string; representationRevisionId: string } }) =>\n" +
          "  <div key={reviewTargetStreamKey(index, stream.target)} />;\n" +
          "export const wrapped = (index: number, stream: { target: { artifactId: string; representationRevisionId: string } }) =>\n" +
          '  <div key={reviewTargetStreamKey(index, stream.target) + ":x"} />;\n',
        "consumer.tsx",
      ),
    ).toEqual(["react-key UNLISTED", "react-key UNLISTED"]);
  });

  it("the hatches a type cannot see are UNLISTED: a minting cast, an id in a data attribute, the target parameter, a hand-indexed address set", () => {
    expect(
      outcomesOf(
        "// representationRevisionId\n" +
          "export const minted = (id: string) => id as unknown as ReviewTargetKey;\n" +
          "export const a = (header: { revisionId: string }) => <i data-review-target-pair={header.revisionId} />;\n" +
          "export const read = (sp: Record<string, string>) => sp[REVIEW_ISLAND_TARGET_QUERY_PARAM];\n" +
          "export const one = (answer: { islandSrcByRevision: Record<string, string> }, id: string) => answer.islandSrcByRevision[id];\n" +
          "export const wire = (islandSrcByRevision: Map<string, string>) => Object.fromEntries(islandSrcByRevision);\n",
        "consumer.tsx",
      ),
    ).toEqual([
      "key-cast UNLISTED",
      "data-identity UNLISTED",
      "query-read,target-param UNLISTED",
      "address-set UNLISTED",
      "address-set UNLISTED",
    ]);
  });

  it("a presence marker with no identity is no hit", () => {
    expect(
      outcomesOf(
        "// representationRevisionId\n" +
          'export const a = (paired: boolean) => <i data-review-target-pair={paired ? "" : undefined} />;\n',
        "consumer.tsx",
      ),
    ).toEqual([]);
  });

  it("a message that names an id is no hit", () => {
    expect(
      outcomesOf(
        "export const m = (t: { representationRevisionId: string }) =>\n" +
          "  `revision ${t.representationRevisionId} is not pinned`;\n",
      ),
    ).toEqual([]);
  });

  it("refuses a tree whose section has lost its markers", () => {
    const root = mkdtempSync(path.join(tmpdir(), "projection-census-"));
    mkdirSync(path.join(root, path.dirname(MODULE_FILE)), { recursive: true });
    writeFileSync(path.join(root, MODULE_FILE), "export function lone() {}\n");
    expect(() => moduleProjections(root)).toThrow(/markers are missing/);
  });
});
