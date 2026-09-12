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
