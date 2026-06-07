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
 * back to the base objects_save shaper). Never throws.
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
    let selected: Record<string, unknown> = {};
    if (selectedIdeaJson) {
      try {
        const p = JSON.parse(selectedIdeaJson) as Record<string, unknown>;
        if (p && typeof p === "object" && !Array.isArray(p)) selected = p;
      } catch {
        // empty object -> draft agent's degenerate-input branch handles it.
      }
    }
    // Validate against the offered ideas (match by title); fall back to
    // the parsed object, else the first offered idea — the gate contract
    // is "pick one of these".
    const title = typeof selected.title === "string" ? selected.title : "";
    const matched =
      ideas.find((i) => typeof i?.title === "string" && i.title === title) ??
      (Object.keys(selected).length > 0 ? selected : ideas[0] ?? {});
    return {
      typeHint: "@cinatra-ai/dynamic:blog-pipeline-selected-idea",
      rawData: { cinatra_agent_run_id: runId, idea: matched },
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
