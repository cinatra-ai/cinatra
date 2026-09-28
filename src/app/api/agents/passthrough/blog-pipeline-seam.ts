// blog-pipeline-agent deterministic seam shapers.
//
// Pure, zero-dependency module (no `server-only`, no MCP/handler graph)
// so it is unit-testable in isolation. `route.ts` imports the dispatcher
// and chains it ahead of the base `objects_save` shaper.
//
// The blog-pipeline-agent orchestrator bridges one OAS shape gap via
// /api/agents/passthrough (mirrors the email-outreach context_setup
// string-gate -> passthrough -> typed-output pattern):
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
 * Returns the shaped `{typeHint, rawData}` for the blog `_shape`,
 * or `null` when `raw` is not a blog-pipeline shape (the caller falls
 * back to the base objects_save shaper).
 */
export function shapeBlogPipelineObjectsSave(
  raw: Record<string, unknown>,
  agentRunId: string,
): BlogPipelineShaped | null {
  const runId = resolveRunId(raw, agentRunId);

  if (raw._shape === "blog_pipeline_draft_projection") {
    const draft =
      raw.draft && typeof raw.draft === "object" && !Array.isArray(raw.draft)
        ? (raw.draft as Record<string, unknown>)
        : {};
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return {
      typeHint: "@dynamic/types:blog-pipeline-draft-projection",
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
