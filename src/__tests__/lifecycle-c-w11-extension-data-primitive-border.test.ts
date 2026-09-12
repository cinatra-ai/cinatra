/**
 * THE HOST TREE AFTER THE PACK'S GATE LEAVES IT (cinatra#3249, epic #3023;
 * stacked on the branch of the pull request that first added the gate here).
 *
 * Acceptance, in the issue's own words:
 *
 *   (1) "`src/lib/blog/stored-ideas-gate.ts` and
 *   `src/lib/blog/stored-ideas-gate-runner.ts` are removed from the host tree"
 *   — the two modules actually stand at `src/lib/stored-ideas-gate.ts` and
 *   `src/lib/stored-ideas-gate-runner.ts`, so both spellings are asserted gone;
 *
 *   (4) "No physical or logical table name belonging to one pack
 *   (`ext_cinatra_ai_blog_pipeline_agent_idea_drafts`, `idea_drafts`, or
 *   equivalent) appears anywhere in `src/lib/**` after the change."
 *
 * The names are ASSEMBLED from fragments rather than written out, so this file
 * can never itself be the occurrence a walk reports, and so a copy of this file
 * dropped into `src/lib` would still be caught by the walk below.
 *
 *   pnpm exec vitest run src/__tests__/lifecycle-c-w11-extension-data-primitive-border.test.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, "..", "lib");

const PACK_PHYSICAL_TABLE = ["ext", "cinatra", "ai", "blog", "pipeline", "agent", "idea", "drafts"].join("_");
const PACK_LOGICAL_TABLE = ["idea", "drafts"].join("_");
const PACK_NAMED_TOOL = ["blog", "pipeline", "ideas"].join("_");

/**
 * EVERY file, not a chosen set of extensions: the tree under `src/lib` also
 * carries `.json`, `.mjs`, `.md`, `.txt` and fixture bytes, and a name a walk
 * of `.ts` alone would miss is exactly the name this test exists to catch.
 * Reading a binary file as utf-8 does not throw; it simply never matches.
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    out.push(full);
  }
  return out;
}

const FILES = walk(LIB);
const hits = (needle: string) =>
  FILES.filter((f) => readFileSync(f, "utf8").includes(needle)).map((f) => path.relative(LIB, f));

describe("cinatra#3249 — no pack name is left inside the host library", () => {
  it("walks a library that is actually there", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("spells no pack's PHYSICAL table name anywhere under src/lib", () => {
    expect(hits(PACK_PHYSICAL_TABLE)).toEqual([]);
  });

  it("spells no pack's LOGICAL table name anywhere under src/lib", () => {
    expect(hits(PACK_LOGICAL_TABLE)).toEqual([]);
  });

  it("admits no passthrough tool under one pack's own name anywhere under src/lib", () => {
    expect(hits(PACK_NAMED_TOOL)).toEqual([]);
  });
});

describe("cinatra#3249 — the two host modules the gate lived in are gone", () => {
  it("neither module stands at the path the issue names", () => {
    expect(existsSync(path.join(LIB, "blog", "stored-ideas-gate.ts"))).toBe(false);
    expect(existsSync(path.join(LIB, "blog", "stored-ideas-gate-runner.ts"))).toBe(false);
  });

  it("neither module stands at the path it actually occupied", () => {
    expect(existsSync(path.join(LIB, "stored-ideas-gate.ts"))).toBe(false);
    expect(existsSync(path.join(LIB, "stored-ideas-gate-runner.ts"))).toBe(false);
  });

  it("nothing under src still carries the gate's file name", () => {
    const all = walk(path.resolve(HERE, ".."));
    expect(all.filter((f) => path.basename(f).startsWith("stored-ideas-gate"))).toEqual([]);
  });

  it("nothing under src still IMPORTS either module — a filename walk cannot see a dangling reference", () => {
    const SRC = path.resolve(HERE, "..");
    const MODULE = ["stored", "ideas", "gate"].join("-");
    const dangling = walk(SRC)
      .filter((f) => f !== path.resolve(HERE, path.basename(fileURLToPath(import.meta.url))))
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return (
          text.includes(`from "@/lib/${MODULE}`) ||
          text.includes(`from "./${MODULE}`) ||
          text.includes(`from "../${MODULE}`) ||
          text.includes(`import("@/lib/${MODULE}`) ||
          text.includes(`require("@/lib/${MODULE}`)
        );
      })
      .map((f) => path.relative(SRC, f));
    expect(dangling).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE SECOND LAYER NAMES NOTHING EITHER (cinatra#3249, second half).
//
// Acceptance, in the issue's own words: "nothing in core names a pack, a table,
// a type or a state — a test greps the new code for the blog pack's names".
//
// The walk above already covers every file under `src/lib`. These cases name the
// files the second layer ADDS and the manifest contract it lands beside them, so
// a later edit to exactly those files cannot slip a pack's name, its artifact
// TYPE or its state vocabulary in without turning this red.
// ---------------------------------------------------------------------------

const MANIFEST = path.resolve(HERE, "..", "..", "packages", "sdk-extensions", "src", "manifest.ts");

/**
 * The code THIS layer adds. The manifest module is read from the marker of the
 * declared-tools contract onward: everything above it is the W7 declared-tables
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

/** Assembled from fragments, so this file is never itself an occurrence. */
const PACK_PACKAGE_NAME = ["@cinatra", "ai/blog", "pipeline", "agent"].join("-");
const PACK_ARTIFACT_TYPE = ["blog", "idea", "artifact"].join("-");
const PACK_STATE_WORDS = [["reserved"], ["drafted"], ["released"]].map(([w]) => `"${w}"`);

describe("cinatra#3249 — the generic dispatch layer names no pack, table, type or state", () => {
  it("stands where the test says it does", () => {
    for (const entry of SECOND_LAYER) expect(existsSync(entry.file)).toBe(true);
  });

  it("names the pack's package nowhere", () => {
    for (const entry of SECOND_LAYER) {
      expect([entry.file, addedCode(entry).includes(PACK_PACKAGE_NAME)]).toEqual([
        entry.file,
        false,
      ]);
    }
  });

  it("names the pack's tables nowhere", () => {
    for (const entry of SECOND_LAYER) {
      const text = addedCode(entry);
      expect([entry.file, text.includes(PACK_PHYSICAL_TABLE)]).toEqual([entry.file, false]);
      expect([entry.file, text.includes(PACK_LOGICAL_TABLE)]).toEqual([entry.file, false]);
    }
  });

  it("names the pack's artifact type nowhere", () => {
    for (const entry of SECOND_LAYER) {
      expect([entry.file, addedCode(entry).includes(PACK_ARTIFACT_TYPE)]).toEqual([
        entry.file,
        false,
      ]);
    }
  });

  it("spells none of the pack's state values — a state is the caller's own column value", () => {
    for (const entry of SECOND_LAYER) {
      const text = addedCode(entry);
      for (const word of PACK_STATE_WORDS) {
        expect([entry.file, word, text.includes(word)]).toEqual([entry.file, word, false]);
      }
    }
  });

  it("admits no passthrough tool under one pack's own name", () => {
    for (const entry of SECOND_LAYER) {
      expect([entry.file, addedCode(entry).includes(PACK_NAMED_TOOL)]).toEqual([entry.file, false]);
    }
  });
});
