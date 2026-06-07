import "server-only";

import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import { readAgentRunById, readRunCoOwners } from "@cinatra-ai/agents";
import { subscribeToAgUiEventsWithId } from "@cinatra-ai/agent-ui-protocol/server";

// ---------------------------------------------------------------------------
// AG-UI SSE stream endpoint.
//
// REPLAYABLE CONTRACT:
//   This route streams AG-UI events from the unified Redis Streams log
//   (cinatra:a2a:events:{runId}). Events are durably persisted, so a
//   disconnected EventSource reconnecting with `Last-Event-ID: <id>`
//   resumes from the correct cursor — no events lost during transient
//   network drops. Initial page load may still seed state from the
//   DB-backed REST endpoint for a faster first paint.
//
// ERROR CONTRACT:
//   Transport failures close the stream silently and log server-side —
//   they do NOT emit synthetic RUN_ERROR frames. RUN_ERROR means the run
//   itself failed; transport hiccups are reconnected by the browser's
//   EventSource automatically with the cached Last-Event-ID.
//
// AUTH:
//   requireAuthSession + per-run ownership check (run.runBy !== actor is
//   403) — same pattern as GET /api/agents/runs/[runId].
// ---------------------------------------------------------------------------

type RouteContext = { params: Promise<{ runId: string }> };

const KEEPALIVE_MS = 15_000;

export async function GET(request: Request, context: RouteContext) {
  const session = await requireAuthSession().catch(() => null);
  const actorUserId = session?.user?.id ?? null;
  if (!actorUserId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { runId } = await context.params;
  const decodedRunId = decodeURIComponent(runId);

  // Last-Event-ID header parsing for resume. Malformed values are treated as
  // absent (defense-in-depth — the cursor is passed verbatim to XRANGE and
  // must be "<digits>-<digits>").
  const rawLastEventId = request.headers.get("last-event-id");
  const explicitFromId =
    rawLastEventId && /^\d+-\d+$/.test(rawLastEventId)
      ? rawLastEventId
      : undefined;

  const run = await readAgentRunById(decodedRunId);
  if (!run) {
    return new Response("Not Found", { status: 404 });
  }
  if (run.runBy && run.runBy !== actorUserId && !isPlatformAdmin(session)) {
    const coOwnerRows = await readRunCoOwners(run.id);
    const isCoOwner = coOwnerRows.some((c) => c.userId === actorUserId);
    if (!isCoOwner) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  // When a fresh subscriber connects (no Last-Event-ID) to a run that is
  // already pending_approval, replay from the start of the event log so the
  // INTERRUPT event is delivered and the UI can render the setup form without
  // requiring the job to re-emit it. This stays within the AG-UI event log
  // contract — "0-0" is the Redis Streams sentinel for "start of stream".
  const fromId =
    explicitFromId ??
    (run.status === "pending_approval" ? "0-0" : undefined);

  // Unify abort sources (client disconnect + internal) into one controller.
  const abortController = new AbortController();
  request.signal.addEventListener("abort", () => abortController.abort(), {
    once: true,
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // Controller already closed — fall through; next iteration is a no-op.
        }
      }, KEEPALIVE_MS);

      const onAbort = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };
      abortController.signal.addEventListener("abort", onAbort, { once: true });

      try {
        const gen = subscribeToAgUiEventsWithId(decodedRunId, {
          signal: abortController.signal,
          fromId,
        });
        for await (const { id, event } of gen) {
          if (closed) break;
          // SSE id: field enables browser EventSource auto-resume via
          // Last-Event-ID on reconnect. Redis Streams native IDs are
          // `<digits>-<digits>` — always safe per WHATWG SSE spec (no
          // forbidden chars).
          const frame = id
            ? `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`
            : `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        }
      } catch (err) {
        // Transport failure — log server-side, do NOT emit a synthetic
        // RUN_ERROR frame. Execution-state semantics live in the event stream;
        // a transport error is a connection problem the browser will retry.
        console.error(
          `[agent-runs/stream] SSE transport error for run ${decodedRunId}:`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        if (!closed) {
          closed = true;
          clearInterval(keepalive);
          abortController.signal.removeEventListener("abort", onAbort);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
