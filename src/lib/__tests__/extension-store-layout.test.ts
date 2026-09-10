/**
 * THE STORE-LAYOUT FACTS THE INSTALLED-DIRS WALK RESTATES (cinatra#3204).
 *
 * The installed-dirs walk in `extension-data-root.ts` restates two facts
 * instead of importing them — the `current` mirror's filename and the
 * digest-segment predicate (with the mirror reader built on it) — because one
 * of its callers is the skill extension scan that runs on every assignable-skill
 * query, and the module holding those facts also carries the materializer's
 * TypeScript-backed import classifier.
 *
 * A restated fact is only safe while a test keeps it honest. These are that
 * test: the two definitions must agree, byte for byte in the constant and
 * decision for decision in the predicate, or the store's writer and this reader
 * are walking two different layouts. The root itself is NOT restated — the walk
 * reads the env name and the container default from the resolver that owns
 * them, which the last test pins by walking a root the env var names.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  STORE_CURRENT_FILENAME as CORE_CURRENT_FILENAME,
  isStoreDigestSegment as coreIsStoreDigestSegment,
  parseCurrentFileText as coreParseCurrentFileText,
} from "@/lib/extension-package-store-core";
import {
  EXTENSION_DATA_ROOT_ENV,
  STORE_CURRENT_FILENAME,
  isStoreDigestSegment,
  listInstalledStorePackageDirs,
  parseCurrentFileText,
} from "@/lib/extension-data-root";

const SEGMENTS = [
  "a".repeat(63),
  "a".repeat(64),
  "b3".repeat(32),
  "f".repeat(128),
  "f".repeat(129),
  "A".repeat(64),
  "g".repeat(64),
  "",
  " " + "a".repeat(64),
  "a".repeat(64) + "/x",
];

describe("the installed-dirs walk restates the store layout without drifting", () => {
  it("names the same active-digest mirror file", () => {
    expect(STORE_CURRENT_FILENAME).toBe(CORE_CURRENT_FILENAME);
  });

  it("decides every digest segment the same way", () => {
    for (const segment of SEGMENTS) {
      expect([segment, isStoreDigestSegment(segment)]).toEqual([
        segment,
        coreIsStoreDigestSegment(segment),
      ]);
    }
  });

  it("reads the same digest out of a mirror's text", () => {
    for (const segment of SEGMENTS) {
      for (const raw of [segment, `${segment}\n`, `  ${segment}  `]) {
        expect(parseCurrentFileText(raw)).toBe(coreParseCurrentFileText(raw));
      }
    }
  });
});

describe("the walk reads the deploy-owned root", () => {
  const tmpRoots: string[] = [];
  let priorRoot: string | undefined;

  afterEach(() => {
    if (priorRoot === undefined) delete process.env[EXTENSION_DATA_ROOT_ENV];
    else process.env[EXTENSION_DATA_ROOT_ENV] = priorRoot;
    for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("lists the active payload dir of a package installed under the env-named root", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cinatra-store-root-"));
    tmpRoots.push(root);
    const digest = "b3".repeat(32);
    const slugDir = path.join(root, "artifact", "@acme", "note-artifact");
    const digestDir = path.join(slugDir, digest);
    mkdirSync(digestDir, { recursive: true });
    writeFileSync(path.join(digestDir, "package.json"), JSON.stringify({ name: "@acme/note-artifact" }));
    writeFileSync(path.join(slugDir, STORE_CURRENT_FILENAME), `${digest}\n`);

    priorRoot = process.env[EXTENSION_DATA_ROOT_ENV];
    process.env[EXTENSION_DATA_ROOT_ENV] = root;

    expect(listInstalledStorePackageDirs("artifact")).toEqual([
      { packageName: "@acme/note-artifact", dir: digestDir },
    ]);
    expect(listInstalledStorePackageDirs("skill")).toEqual([]);
  });
});
