import { NextResponse } from "next/server";
import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import {
  readAgentRunById,
  readAgentRunMessages,
  readAgentTemplateById,
  readRunCoOwners,
} from "@cinatra-ai/agents";
import { readLatestAgUiInterrupt } from "@cinatra-ai/agent-ui-protocol/server";

type RouteContext = { params: Promise<{ runId: string }> };

type HitlContext = {
  xRenderer: string;
  childRunId: string;
  reviewTaskId: string;
  inputSchema: Record<string, unknown>;
  currentValues: Record<string, unknown>;
  fieldName?: string;
};

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

    // ---------------------------------------------------------------------------
    // Only the setup-* synthetic fallback remains for HITL context probing:
    // provider-agnostic and self-contained.
    // ---------------------------------------------------------------------------
    // Fetch the template once and reuse it in BOTH the hitlContext probe block
    // AND the inline-card metadata response below.
    const template = await readAgentTemplateById(run.templateId);

    let hitlContext: HitlContext | null = null;
    if (run.status === "pending_approval") {

      // Setup-loop runs (no a2aTaskId — fired before any execution started).
      // Surface a synthetic setup-{runId} reviewTaskId so the workspace panel
      // can render a generic approval banner. WR-04: use template.inputSchema
      // so REST polling clients have field metadata.
      if (!run.a2aTaskId) {
        hitlContext = {
          xRenderer: "@cinatra-ai/agent-builder:schema-field-fallback",
          childRunId: "",
          reviewTaskId: `setup-${decodedRunId}`,
          inputSchema: (template?.inputSchema && typeof template.inputSchema === "object"
            ? (template.inputSchema as Record<string, unknown>)
            : {}),
          currentValues: run.inputParams && typeof run.inputParams === "object"
            ? (run.inputParams as Record<string, unknown>)
            : {},
        };
      } else {
        // WayFlow gate identity. `run.a2aTaskId` is updated per gate by
        // `handleWayflowTaskState`, so `wayflow-<a2aTaskId>` is a stable
        // identity for "which gate is the run paused on right now".
        //
        // Also surface the actual xRenderer + schema + values from the
        // persisted AG-UI INTERRUPT event in the Redis Streams log. The REST
        // snapshot cannot depend on the AG-UI SSE stream to hydrate it
        // post-mount because navigation to the run-detail page can happen
        // BEFORE the BullMQ worker emits the INTERRUPT, so SSE opens reading
        // from "$" (only-new) and misses the past INTERRUPT. The REST-side
        // reverse read is bounded (single XREVRANGE COUNT 300) and gracefully
        // returns null on Redis errors, so this never blocks the page.
        const interrupt = await readLatestAgUiInterrupt(decodedRunId).catch(
          () => null,
        );
        const runInputParams =
          run.inputParams && typeof run.inputParams === "object"
            ? (run.inputParams as Record<string, unknown>)
            : {};
        hitlContext = {
          xRenderer: interrupt?.xRenderer ?? "",
          childRunId: "",
          reviewTaskId: interrupt?.reviewTaskId || `wayflow-${run.a2aTaskId}`,
          inputSchema: interrupt?.schema ?? {},
          currentValues: { ...runInputParams, ...(interrupt?.values ?? {}) },
          ...(interrupt?.fieldName ? { fieldName: interrupt.fieldName } : {}),
        };
      }
    }

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
