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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

function passthroughSources(): Array<{ file: string; text: string }> {
  return readdirSync(PASSTHROUGH_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name))
    .map((e) => ({
      file: e.name,
      text: readFileSync(join(PASSTHROUGH_DIR, e.name), "utf8"),
    }));
}

describe("cinatra#3035 — the blog pipeline's passthrough shapers are retired", () => {
  it("the blog-pipeline seam module no longer exists", () => {
    expect(existsSync(join(PASSTHROUGH_DIR, "blog-pipeline-seam.ts"))).toBe(false);
  });

  it("the route no longer chains a blog-pipeline shaper ahead of objects_save", () => {
    const route = readFileSync(join(PASSTHROUGH_DIR, "route.ts"), "utf8");
    expect(route).not.toMatch(/shapeBlogPipelineObjectsSave/);
    expect(route).not.toMatch(/baseObjectsSaveShaper/);
    expect(route).not.toMatch(/TOOL_INPUT_SHAPERS\.objects_save\s*=/);
  });

  it("no passthrough module names either retired shape, its type or its module", () => {
    const sources = passthroughSources();
    expect(sources.some((s) => s.file === "route.ts")).toBe(true);
    const hits: string[] = [];
    for (const { file, text } of sources) {
      for (const name of RETIRED_NAMES) {
        if (text.includes(name)) hits.push(`${file}: ${name}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
