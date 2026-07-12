/**
 * Blog-pipeline-agent deterministic passthrough shapers.
 *
 * The orchestrator OAS declares `_shape: blog_pipeline_selected_idea` /
 * `blog_pipeline_draft_projection` passthrough nodes. The
 * /api/agents/passthrough route must shape them so the OAS nodes'
 * declared outputs (`selected_idea.idea`,
 * `draft_projection.{postTitle,postExcerpt,blogPostContent}`) are
 * actually produced (echoed via `result_input_passthrough` -> rawData).
 *
 *   pnpm exec vitest run src/__tests__/blog-pipeline-passthrough-shaper.test.ts
 */
import { describe, it, expect } from "vitest";
import { shapeBlogPipelineObjectsSave as __shapeBlogPipelineObjectsSave } from "../app/api/agents/passthrough/blog-pipeline-seam";

describe("blog-pipeline passthrough seam shapers", () => {
  it("blog_pipeline_selected_idea: parses selectedIdeaJson and matches an offered idea", () => {
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
    expect(out).not.toBeNull();
    expect(out!.typeHint).toBe("@dynamic/types:blog-pipeline-selected-idea");
    expect(out!.rawData.idea).toEqual({ title: "B", summary: "sb", outline: ["2"] });
    expect(out!.rawData.cinatra_agent_run_id).toBe("run-1");
  });

  it("blog_pipeline_selected_idea: THROWS on unparseable selectedIdeaJson (fail closed, no ideas[0] default)", () => {
    const ideas = [{ title: "Only", summary: "s", outline: [] }];
    expect(() =>
      __shapeBlogPipelineObjectsSave(
        { _shape: "blog_pipeline_selected_idea", selectedIdeaJson: "not json", ideas },
        "run-x",
      ),
    ).toThrow(/not a parseable BlogIdea/);
  });

  it("blog_pipeline_selected_idea: THROWS when the selected idea matches none of the offered ideas", () => {
    const ideas = [{ title: "Only", summary: "s", outline: [] }];
    expect(() =>
      __shapeBlogPipelineObjectsSave(
        {
          _shape: "blog_pipeline_selected_idea",
          selectedIdeaJson: JSON.stringify({ title: "Other", summary: "x", outline: [] }),
          ideas,
        },
        "run-x",
      ),
    ).toThrow(/does not match any of the 1 offered ideas/);
  });

  it("blog_pipeline_selected_idea: accepts a parsed idea when no offered list arrived (unenforceable match)", () => {
    const out = __shapeBlogPipelineObjectsSave(
      {
        _shape: "blog_pipeline_selected_idea",
        selectedIdeaJson: JSON.stringify({ title: "Solo", summary: "s", outline: [] }),
      },
      "run-x",
    );
    expect(out!.rawData.idea).toEqual({ title: "Solo", summary: "s", outline: [] });
    expect(out!.rawData.cinatra_agent_run_id).toBe("run-x");
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
