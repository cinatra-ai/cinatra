/**
 * THE GENERIC DISPATCH LAYER NAMES NOTHING (cinatra#3525, the Cinatra half).
 *
 * The border, in the task's own words: "no extension name and no tool name in
 * Cinatra's code". The layer this lands — the dispatch, the module loader, the
 * passthrough's scoped-tool admission, and the manifest contract they read —
 * must therefore carry no extension's package name, no extension's table name,
 * no extension's artifact type and none of its state vocabulary.
 *
 * The names are ASSEMBLED from fragments rather than written out, so this file
 * can never itself be the occurrence a walk reports.
 *
 *   pnpm exec vitest run src/__tests__/lifecycle-c-w11-extension-data-primitive-border.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, "..", "lib");
const MANIFEST = path.resolve(HERE, "..", "..", "packages", "sdk-extensions", "src", "manifest.ts");

const PACK_PHYSICAL_TABLE = ["ext", "cinatra", "ai", "blog", "pipeline", "agent", "idea", "drafts"].join("_");
const PACK_LOGICAL_TABLE = ["idea", "drafts"].join("_");
const PACK_NAMED_TOOL = ["blog", "pipeline", "ideas"].join("_");
const PACK_PACKAGE_NAME = ["@cinatra", "ai/blog", "pipeline", "agent"].join("-");
const PACK_ARTIFACT_TYPE = ["blog", "idea", "artifact"].join("-");
const PACK_STATE_WORDS = [["reserved"], ["drafted"], ["released"]].map(([w]) => `"${w}"`);

/**
 * The code THIS layer adds. The manifest module is read from the marker of the
 * declared-tools contract onward: everything above it is the declared-tables
 * work, whose own prose already carries a worked example of the prefix
 * derivation ("`ext_`, then the extension's scope and slug"), and a walk of the
 * whole file would report that pre-existing line instead of anything added here.
 */
const SECOND_LAYER: Array<{ file: string; from?: string }> = [
  { file: path.join(LIB, "extension-tool-dispatch.ts") },
  { file: path.join(LIB, "extension-tool-module-loader.ts") },
  { file: path.join(LIB, "extension-scoped-tools.ts") },
  { file: MANIFEST, from: ["THE DECLARED", "TOOLS CONTRACT"].join("-") },
];

/** The added code of one entry, and a failure when its marker is not there. */
function addedCode(entry: { file: string; from?: string }): string {
  const text = readFileSync(entry.file, "utf8");
  if (entry.from === undefined) return text;
  const at = text.indexOf(entry.from);
  expect([entry.file, at >= 0]).toEqual([entry.file, true]);
  return text.slice(at);
}

describe("cinatra#3525 — the generic dispatch layer names no extension, table, type or state", () => {
  it("stands where the test says it does", () => {
    for (const entry of SECOND_LAYER) expect(existsSync(entry.file)).toBe(true);
  });

  it("names the extension's package nowhere", () => {
    for (const entry of SECOND_LAYER) {
      expect([entry.file, addedCode(entry).includes(PACK_PACKAGE_NAME)]).toEqual([
        entry.file,
        false,
      ]);
    }
  });

  it("names the extension's tables nowhere", () => {
    for (const entry of SECOND_LAYER) {
      const text = addedCode(entry);
      expect([entry.file, text.includes(PACK_PHYSICAL_TABLE)]).toEqual([entry.file, false]);
      expect([entry.file, text.includes(PACK_LOGICAL_TABLE)]).toEqual([entry.file, false]);
    }
  });

  it("names the extension's artifact type nowhere", () => {
    for (const entry of SECOND_LAYER) {
      expect([entry.file, addedCode(entry).includes(PACK_ARTIFACT_TYPE)]).toEqual([
        entry.file,
        false,
      ]);
    }
  });

  it("spells none of the extension's state values — a state is the caller's own column value", () => {
    for (const entry of SECOND_LAYER) {
      const text = addedCode(entry);
      for (const word of PACK_STATE_WORDS) {
        expect([entry.file, word, text.includes(word)]).toEqual([entry.file, word, false]);
      }
    }
  });

  it("admits no passthrough tool under one extension's own name", () => {
    for (const entry of SECOND_LAYER) {
      expect([entry.file, addedCode(entry).includes(PACK_NAMED_TOOL)]).toEqual([entry.file, false]);
    }
  });
});
