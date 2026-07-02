// blog-pipeline-agent deterministic seam shapers.
//
// Pure, zero-dependency module (no `server-only`, no MCP/handler graph)
// so it is unit-testable in isolation. `route.ts` imports the dispatcher
// and chains it ahead of the base `objects_save` shaper.
//
// The blog-pipeline-agent orchestrator bridges two OAS shape gaps via
// /api/agents/passthrough (mirrors the email-outreach context_setup
// string-gate -> passthrough -> typed-output pattern):
//   - `blog_pipeline_selected_idea`  : idea-array -> draft `idea` object
//   - `blog_pipeline_draft_projection`: draft object -> linkedin strings
// Each persists a thin transient record via objects_save (same infra as
// email's context_setup) and the route's `result_input_passthrough`
// echoes `rawData` (the typed output fields) into the OAS node outputs.

export type BlogPipelineShaped = {
  typeHint: string;
  rawData: Record<string, unknown>;
};

function resolveRunId(
  raw: Record<string, unknown>,
  agentRunId: string,
): string {
  if (typeof raw.cinatra_agent_run_id === "string") return raw.cinatra_agent_run_id;
  if (typeof raw.cinatra_run_id === "string") return raw.cinatra_run_id;
  return agentRunId;
}

/**
 * Returns the shaped `{typeHint, rawData}` for the two blog `_shape`s,
 * or `null` when `raw` is not a blog-pipeline shape (the caller falls
 * back to the base objects_save shaper).
 *
 * `blog_pipeline_selected_idea` FAILS CLOSED: when `selectedIdeaJson`
 * does not parse to a plain object, or does not match one of the offered
 * ideas (by title), it THROWS instead of silently defaulting to
 * `ideas[0]` / an empty idea — a silent default let a placeholder
 * `userResponse` flow into the draft writer and produce an empty draft.
 * The route surfaces the throw as an HTTP 400.
 */
export function shapeBlogPipelineObjectsSave(
  raw: Record<string, unknown>,
  agentRunId: string,
): BlogPipelineShaped | null {
  const runId = resolveRunId(raw, agentRunId);

  if (raw._shape === "blog_pipeline_selected_idea") {
    const selectedIdeaJson =
      typeof raw.selectedIdeaJson === "string" ? raw.selectedIdeaJson : "";
    const ideas = Array.isArray(raw.ideas)
      ? (raw.ideas as Array<Record<string, unknown>>)
      : [];
    let selected: Record<string, unknown> | null = null;
    if (selectedIdeaJson) {
      try {
        const p = JSON.parse(selectedIdeaJson) as Record<string, unknown>;
        if (p && typeof p === "object" && !Array.isArray(p)) selected = p;
      } catch {
        // selected stays null -> throw below (fail closed, no ideas[0] default)
      }
    }
    if (!selected || Object.keys(selected).length === 0) {
      throw new Error(
        "blog_pipeline_selected_idea: `selectedIdeaJson` is not a parseable BlogIdea object " +
          `(got ${JSON.stringify(selectedIdeaJson).slice(0, 200)}). ` +
          "Select one of the generated ideas at the idea-selection gate.",
      );
    }
    // Validate against the offered ideas (match by title) — the gate
    // contract is "pick one of these". Only enforceable when the offered
    // list arrived; with no offered list we accept the parsed object.
    const title = typeof selected.title === "string" ? selected.title : "";
    const matched = ideas.find(
      (i) => typeof i?.title === "string" && i.title === title,
    );
    if (ideas.length > 0 && !matched) {
      throw new Error(
        "blog_pipeline_selected_idea: selected idea " +
          `(title ${JSON.stringify(title).slice(0, 200)}) does not match any of the ` +
          `${ideas.length} offered ideas. Select one of the generated ideas at the idea-selection gate.`,
      );
    }
    return {
      typeHint: "@cinatra-ai/dynamic:blog-pipeline-selected-idea",
      rawData: { cinatra_agent_run_id: runId, idea: matched ?? selected },
    };
  }

  if (raw._shape === "blog_pipeline_draft_projection") {
    const draft =
      raw.draft && typeof raw.draft === "object" && !Array.isArray(raw.draft)
        ? (raw.draft as Record<string, unknown>)
        : {};
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return {
      typeHint: "@cinatra-ai/dynamic:blog-pipeline-draft-projection",
      rawData: {
        cinatra_agent_run_id: runId,
        postTitle: str(draft.title),
        postExcerpt: str(draft.excerpt),
        blogPostContent: str(draft.content),
      },
    };
  }

  return null;
}
