import { NextResponse } from "next/server";
import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import { AuthzError } from "@/lib/authz";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  deriveRunHitlContext,
  readAgentRunById,
  readAgentRunMessages,
  readAgentTemplateById,
  type ActorRoleHints,
} from "@cinatra-ai/agents";

type RouteContext = { params: Promise<{ runId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await requireAuthSession();
    const actorUserId = session?.user?.id ?? null;
    if (!actorUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { runId } = await context.params;
    const decodedRunId = decodeURIComponent(runId);

    // Thread the caller through readAgentRunById so enforceRunAccess runs the
    // real per-run authorization: owner / co-owner / same-org / platform-admin.
    // This closes the cross-tenant read gap for unowned (runBy: null) runs,
    // which the previous hand-rolled guard let through to ALLOW. AuthzError is
    // mapped to 404 (hidden) or 403 (forbidden); messages are fetched only after
    // the access check succeeds so a denied caller never receives them.
    const actor: PrimitiveActorContext = {
      actorType: "human",
      source: "route",
      userId: actorUserId,
    };
    const roles: ActorRoleHints = {
      platformRole: isPlatformAdmin(session) ? "platform_admin" : "member",
      actorOrganizationId: session?.session?.activeOrganizationId ?? undefined,
    };

    let run: Awaited<ReturnType<typeof readAgentRunById>>;
    try {
      run = await readAgentRunById(decodedRunId, actor, roles);
    } catch (err) {
      if (err instanceof AuthzError) {
        return NextResponse.json(
          { error: err.statusCode === 404 ? "Run not found" : "Forbidden" },
          { status: err.statusCode },
        );
      }
      throw err;
    }

    if (!run) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    const messages = await readAgentRunMessages(run.id);

    // Fetch the template once and reuse it in BOTH the hitlContext derivation
    // AND the inline-card metadata response below.
    const template = await readAgentTemplateById(run.templateId);

    // Shared derivation (also used by the A2A snapshot path — see
    // packages/agents/src/hitl-context.ts): persisted AG-UI INTERRUPT first
    // (bounded Redis Streams reverse read — the SSE stream can open AFTER the
    // worker emitted the INTERRUPT and miss it), then the synthetic
    // wayflow-<a2aTaskId> / setup-<runId> gate-identity fallbacks.
    const hitlContext = await deriveRunHitlContext(run, { template });

    // Surface the template+run metadata fields the chat-inline
    // <AgenticRunPanel> wrapper needs (templateId for HITL-assist endpoints,
    // agentPackageName for renderer override resolution, agUiEnabled to pick
    // SSE-vs-poll, a2aTaskId for cancel logic, traceId for trace links).
    // These are SSR-loaded directly from the DB on the run-detail page; the
    // chat wrapper has to fetch via this REST endpoint. The template is
    // already loaded above (reused — single DB round-trip).
    return NextResponse.json({
      status: run.status,
      error: run.error,
      inputParams: run.inputParams ?? {},
      startedAt: run.startedAt ? run.startedAt.toISOString() : null,
      completedAt: run.completedAt ? run.completedAt.toISOString() : null,
      templateId: run.templateId,
      agentPackageName: template?.packageName ?? null,
      agUiEnabled: run.agUiEnabled ?? null,
      taskId: run.a2aTaskId ?? null,
      traceId: run.traceId ?? null,
      messages: messages.map((m) => ({
        id: m.id,
        runId: m.runId,
        sequence: m.sequence,
        role: m.role,
        messageType: m.messageType,
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
      })),
      hitlContext,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
