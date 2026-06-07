import { NextResponse } from "next/server";

/**
 * Deprecated agent package branches have been removed.
 *
 * This endpoint no longer handles agent-scrape, agent-research,
 * agent-enrichment, or agent-ross-index instance-name lookups against
 * their per-package stores. Those packages were archived, so only the
 * agent-builder template lookup remains.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agentId");
  const instanceId = searchParams.get("instanceId");

  if (!agentId || !instanceId) {
    return NextResponse.json({ error: "agentId and instanceId are required" }, { status: 400 });
  }

  try {
    const { readAgentTemplateBySlug } = await import("@cinatra-ai/agents");
    const template = await readAgentTemplateBySlug(agentId);
    const name = template?.name ?? null;
    return NextResponse.json({ name }, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (error) {
    console.error("[instance-name] failed to resolve agent instance name", { agentId, instanceId, error });
    return NextResponse.json({ error: "Failed to resolve instance name" }, { status: 500 });
  }
}
