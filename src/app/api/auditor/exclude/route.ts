import "server-only";
import { NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// POST /api/auditor/exclude  (cinatra#1625, #1794)
//
// Post-resume resume-mutation companion for the auditor HITL flow. The review
// gate emits ONE string output (`reviewResult`), so `excludedPromptIds` can no
// longer ride its own array output, and WayFlow's pyagentspec templating cannot
// JSON-decode a field out of a string in-graph. This dedicated route therefore
// JSON-parses the reviewResult envelope, extracts `excludedPromptIds`, and calls
// the run-bound `agent_run_hitl_prompts_exclude` primitive server-side.
//
// Trust model mirrors /api/agents/passthrough EXACTLY for the run-scoped
// primitive: the body-selected agent_run_id is BOUND to the run executing this
// bridge callback (bindBridgeRunId, proven by the auth-injected context id), and
// the primitive is invoked inside an mcpRequestContextStorage frame carrying the
// VERIFIED run id as `verifiedRunScopeId` (never the caller-controlled ambient
// run id). The primitive validates every id against the run's own
// (run, declaring-agent) prompt set and rejects the whole batch on any unknown
// id. Idempotent — a resumed re-run is safe.
//
// This is a DEDICATED route, NOT an entry on the passthrough allowlist.
//
// Auth: bridge shared-secret OR requireAuthSession + run-ownership guard.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import { bindBridgeRunId } from "@/lib/authz/bridge-run-binding";
import { buildActorContextFromRun } from "@/lib/authz/build-actor-context-from-run";
import { readAgentRunById, readRunCoOwners } from "@cinatra-ai/agents";
import { collectAllPrimitiveHandlers } from "@/lib/primitive-handlers";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { withActorContext } from "@cinatra-ai/llm/actor-context";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import type { ActorContext } from "@/lib/authz/actor-context";

const RequestBodySchema = z.object({
  agent_run_id: z.string().min(1),
  reviewResult: z.string().min(1),
});

const ReviewResultEnvelopeSchema = z.object({
  acceptedPatchIds: z.array(z.string()).optional().default([]),
  dismissedPatchIds: z.array(z.string()).optional().default([]),
  excludedPromptIds: z.array(z.string()).optional().default([]),
});

export async function POST(request: Request): Promise<Response> {
  const isBridge = isAuthorizedBridgeRequest(request);
  const session = isBridge ? null : await requireAuthSession().catch(() => null);
  const actorUserId = session?.user?.id ?? null;
  if (!isBridge && !actorUserId) {
    return new Response("Unauthorized", { status: 401 });
  }

  let parsed: z.infer<typeof RequestBodySchema>;
  try {
    parsed = RequestBodySchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: "Invalid request body", detail: String(error) },
      { status: 400 },
    );
  }

  let excludedPromptIds: string[];
  try {
    const decoded = ReviewResultEnvelopeSchema.parse(JSON.parse(parsed.reviewResult));
    excludedPromptIds = decoded.excludedPromptIds;
  } catch (error) {
    return NextResponse.json(
      { error: "Invalid reviewResult envelope", detail: String(error) },
      { status: 400 },
    );
  }

  // Bind the body-selected agent_run_id to the executing run before deriving
  // authority. Session callers keep the full ownership check below.
  if (isBridge) {
    const binding = await bindBridgeRunId(request, parsed.agent_run_id);
    if (!binding.ok) {
      return NextResponse.json({ error: binding.error }, { status: binding.status });
    }
  }

  const run = await readAgentRunById(parsed.agent_run_id);
  if (!run) return new Response("Not Found", { status: 404 });
  if (
    !isBridge &&
    run.runBy &&
    run.runBy !== actorUserId &&
    !isPlatformAdmin(session)
  ) {
    const coOwners = await readRunCoOwners(run.id);
    if (!coOwners.some((c) => c.userId === actorUserId)) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  // Nothing to exclude → idempotent no-op (a clean review dismissed nothing).
  if (excludedPromptIds.length === 0) {
    return NextResponse.json({ applied: 0 });
  }

  let actor: PrimitiveActorContext;
  let alsActorContext: ActorContext;
  try {
    const actorContext = await buildActorContextFromRun({
      id: run.id,
      runBy: run.runBy,
      orgId: run.orgId,
    });
    alsActorContext = actorContext;
    actor = {
      actorType: actorContext.principalType === "HumanUser" ? "human" : "system",
      userId:
        actorContext.principalType === "HumanUser" ? actorContext.principalId : undefined,
      source: "a2a",
      orgId: actorContext.organizationId,
      platformRole: actorContext.platformRole,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `failed to build actor context: ${message}` },
      { status: 400 },
    );
  }

  const handlers = await collectAllPrimitiveHandlers();
  const handler = handlers["agent_run_hitl_prompts_exclude"];
  if (typeof handler !== "function") {
    return NextResponse.json(
      { error: "agent_run_hitl_prompts_exclude has no registered handler." },
      { status: 500 },
    );
  }

  // Run-scoped invocation: the primitive reads `verifiedRunScopeId` (bound
  // above), NEVER the caller-controlled ambient run id.
  const result = (await mcpRequestContextStorage.run(
    {
      runId: parsed.agent_run_id,
      verifiedRunScopeId: parsed.agent_run_id,
      userId: run.runBy ?? undefined,
      orgId: run.orgId,
      ...(run.oboCeiling ? { oboCeiling: run.oboCeiling } : {}),
    },
    () =>
      withActorContext(alsActorContext, () =>
        handler({
          primitiveName: "agent_run_hitl_prompts_exclude",
          input: { ids: excludedPromptIds },
          actor,
          mode: "agentic",
        }),
      ),
  )) as { applied?: number; requested?: number; error?: string };

  if (result && typeof result === "object" && "error" in result && result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ applied: result?.applied ?? 0 });
}
