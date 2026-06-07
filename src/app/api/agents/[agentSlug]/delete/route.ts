import { NextResponse } from "next/server";

/**
 * This endpoint intentionally has no agent-specific delete branches.
 *
 * The ross-index and agent-transcript source packages do not need custom
 * deletion here. Custom deletion logic for agent-builder templates lives in
 * the agent-builder MCP handlers (`agent_template_delete`), not here.
 *
 * Keeping the route so existing clients get a clean 400 rather than a 404
 * until the caller is updated. Future agent sources that need bespoke deletion
 * logic can add a branch here.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ agentSlug: string }> },
) {
  const { agentSlug } = await context.params;
  return NextResponse.json(
    {
      error: `Agent deletion through this endpoint is no longer supported for "${agentSlug}". Use the agent-builder MCP tools (agent_template_delete) for custom agent templates.`,
    },
    { status: 400 },
  );
}
