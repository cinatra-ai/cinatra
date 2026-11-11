/**
 * cinatra#3035 — the blog pipeline's two passthrough shapers are RETIRED.
 *
 * The passthrough once shaped two blog-pipeline `_shape` opt-ins on
 * `objects_save`: `blog_pipeline_selected_idea` (the picked idea, reshaped and
 * saved) and `blog_pipeline_draft_projection` (the draft, projected into three
 * strings and saved). Both were declared `retiredBy: "cinatra#3035"`. The
 * pipeline pin the host installs calls neither: the idea gate keeps the pick in
 * the pack's own `idea_drafts` table, and the draft is written as an artifact
 * mid-run. This guard pins the removal: no shaper module, no dispatch in the
 * route, no reference anywhere in the passthrough.
 *
 *   pnpm exec vitest run src/__tests__/blog-pipeline-passthrough-shaper.test.ts
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PASSTHROUGH_DIR = resolve(__dirname, "../app/api/agents/passthrough");

const RETIRED_NAMES = [
  "blog_pipeline_selected_idea",
  "blog_pipeline_draft_projection",
  "blog-pipeline-selected-idea",
  "blog-pipeline-draft-projection",
  "blog-pipeline-seam",
  "shapeBlogPipelineObjectsSave",
];

// Every module form, at any depth below the folder. Two kinds of folder are
// skipped: test folders (`__tests__`), because a test may name a retired value
// to prove that it is refused, and `node_modules`, which holds no passthrough
// module of this repository.
const MODULE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const SKIPPED_DIRS = new Set(["__tests__", "node_modules"]);

function moduleSources(root: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && MODULE_FILE.test(e.name)) {
        out.push({ file: relative(root, full), text: readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}

function retiredHits(root: string): string[] {
  const hits: string[] = [];
  for (const { file, text } of moduleSources(root)) {
    for (const name of RETIRED_NAMES) {
      if (file.includes(name) || text.includes(name)) hits.push(`${file}: ${name}`);
    }
  }
  return hits;
}

describe("cinatra#3035 — the blog pipeline's passthrough shapers are retired", () => {
  it("the blog-pipeline seam module no longer exists, in any module form or folder", () => {
    const seams = moduleSources(PASSTHROUGH_DIR).filter((s) =>
      /(^|\/)blog-pipeline-seam\.[a-z]+$/.test(s.file),
    );
    expect(seams).toEqual([]);
  });

  it("the route no longer chains a blog-pipeline shaper ahead of objects_save", () => {
    const route = readFileSync(join(PASSTHROUGH_DIR, "route.ts"), "utf8");
    expect(route).not.toMatch(/shapeBlogPipelineObjectsSave/);
    expect(route).not.toMatch(/baseObjectsSaveShaper/);
    expect(route).not.toMatch(/TOOL_INPUT_SHAPERS\.objects_save\s*=/);
  });

  it("no passthrough module names either retired shape, its type or its module", () => {
    expect(moduleSources(PASSTHROUGH_DIR).some((s) => s.file === "route.ts")).toBe(true);
    expect(retiredHits(PASSTHROUGH_DIR)).toEqual([]);
  });

  it("the scan reads every module form at any depth and skips test folders and node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "guard-3035-"));
    try {
      mkdirSync(join(root, "shapers"));
      mkdirSync(join(root, "a", "b", "c"), { recursive: true });
      mkdirSync(join(root, "__tests__"));
      mkdirSync(join(root, "node_modules"));
      const retired = ["blog", "pipeline", "draft", "projection"].join("_");
      // One file per module form, so that dropping any extension from the scan turns this case red.
      const forms = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
      for (const ext of forms) writeFileSync(join(root, `legacy.${ext}`), `export const s = "${retired}";\n`);
      // A module three folders deep.
      writeFileSync(join(root, "a", "b", "c", "deep.ts"), `export const s = "${retired}";\n`);
      writeFileSync(join(root, "shapers", "legacy.ts"), `export const s = "${retired}";\n`);
      // Skipped: test folders and node_modules. Not a module form: a markdown file.
      writeFileSync(join(root, "__tests__", "refusal.test.ts"), `const s = "${retired}";\n`);
      writeFileSync(join(root, "node_modules", "legacy.cjs"), `module.exports = "${retired}";\n`);
      writeFileSync(join(root, "notes.md"), `${retired}\n`);
      expect(retiredHits(root).sort()).toEqual(
        [
          ...forms.map((ext) => `legacy.${ext}: ${retired}`),
          `a/b/c/deep.ts: ${retired}`,
          `shapers/legacy.ts: ${retired}`,
        ].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the scan finds a module by its file name alone, even when its text names nothing retired", () => {
    const root = mkdtempSync(join(tmpdir(), "guard-3035-name-"));
    try {
      mkdirSync(join(root, "shapers"));
      const retired = ["blog", "pipeline", "selected", "idea"].join("_");
      writeFileSync(join(root, "shapers", `${retired}.ts`), "export {};\n");
      writeFileSync(join(root, "shapers", "other.ts"), "export {};\n");
      expect(retiredHits(root)).toEqual([`shapers/${retired}.ts: ${retired}`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
