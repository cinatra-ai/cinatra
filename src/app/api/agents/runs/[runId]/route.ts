import { NextResponse } from "next/server";
import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import {
  deriveRunHitlContext,
  readAgentRunById,
  readAgentRunMessages,
  readAgentTemplateById,
  readRunCoOwners,
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

    const [run, messages] = await Promise.all([
      readAgentRunById(decodedRunId),
      readAgentRunMessages(decodedRunId),
    ]);

    if (!run) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    // Per-run access: owner, co-owner, or platform admin can poll.
    if (run.runBy && run.runBy !== actorUserId && !isPlatformAdmin(session)) {
      const coOwnerRows = await readRunCoOwners(run.id);
      const isCoOwner = coOwnerRows.some((c) => c.userId === actorUserId);
      if (!isCoOwner) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

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
