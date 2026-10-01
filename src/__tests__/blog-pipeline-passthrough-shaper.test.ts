/**
 * Blog-pipeline-agent deterministic passthrough shapers.
 *
 * The orchestrator OAS declares `_shape: blog_pipeline_draft_projection`
 * passthrough nodes. The /api/agents/passthrough route must shape them so the
 * OAS nodes' declared outputs
 * (`draft_projection.{postTitle,postExcerpt,blogPostContent}`) are
 * actually produced (echoed via `result_input_passthrough` -> rawData). The
 * retired `blog_pipeline_selected_idea` shape is shaped no more (cinatra#3035).
 *
 *   pnpm exec vitest run src/__tests__/blog-pipeline-passthrough-shaper.test.ts
 */
import { describe, it, expect } from "vitest";
import { shapeBlogPipelineObjectsSave as __shapeBlogPipelineObjectsSave } from "../app/api/agents/passthrough/blog-pipeline-seam";

describe("blog-pipeline passthrough seam shapers", () => {
  it("blog_pipeline_selected_idea: retired — the seam returns null, so the host holds no save of the picked blog idea", () => {
    const ideas = [
      { title: "A", summary: "sa", outline: ["1"] },
      { title: "B", summary: "sb", outline: ["2"] },
    ];
    const out = __shapeBlogPipelineObjectsSave(
      {
        _shape: "blog_pipeline_selected_idea",
        selectedIdeaJson: JSON.stringify({ title: "B", summary: "sb", outline: ["2"] }),
        ideas,
        cinatra_agent_run_id: "run-1",
      },
      "run-fallback",
    );
    expect(out).toBeNull();
  });

  it("blog_pipeline_draft_projection: projects the draft object into linkedin string fields", () => {
    const out = __shapeBlogPipelineObjectsSave(
      {
        _shape: "blog_pipeline_draft_projection",
        draft: { title: "T", excerpt: "E", content: "C", sourcesUsed: ["u"] },
        cinatra_run_id: "run-2",
      },
      "fb",
    );
    expect(out).not.toBeNull();
    expect(out!.typeHint).toBe("@dynamic/types:blog-pipeline-draft-projection");
    expect(out!.rawData).toEqual({
      cinatra_agent_run_id: "run-2",
      postTitle: "T",
      postExcerpt: "E",
      blogPostContent: "C",
    });
  });

  it("blog_pipeline_draft_projection: empty/missing draft fields coerce to empty strings (never throws)", () => {
    const out = __shapeBlogPipelineObjectsSave(
      { _shape: "blog_pipeline_draft_projection" },
      "fb",
    );
    expect(out!.rawData).toEqual({
      cinatra_agent_run_id: "fb",
      postTitle: "",
      postExcerpt: "",
      blogPostContent: "",
    });
  });

  it("returns null for non-blog shapes (falls back to the base objects_save shaper)", () => {
    expect(
      __shapeBlogPipelineObjectsSave({ _shape: "email_outreach_context_setup" }, "x"),
    ).toBeNull();
    expect(__shapeBlogPipelineObjectsSave({}, "x")).toBeNull();
  });
});
