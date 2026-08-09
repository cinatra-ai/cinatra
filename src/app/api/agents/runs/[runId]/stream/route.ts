import "server-only";

import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import { AuthzError } from "@/lib/authz";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  deriveRecommendationHoldInterrupt,
  readAgentRunById,
  readRecommendationHoldFromEvent,
  recommendationHoldThreadId,
  type ActorRoleHints,
} from "@cinatra-ai/agents";
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
//   requireAuthSession + enforceRunAccess("read") via readAgentRunById(actor)
//   (owner / co-owner / same-org / platform-admin; unowned runs require an
//   org/admin match) — same pattern as GET /api/agents/runs/[runId].
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

  // Authorize BEFORE subscribing to the event stream: thread the caller through
  // readAgentRunById so enforceRunAccess runs the real per-run authorization
  // (owner / co-owner / same-org / platform-admin). This closes the cross-tenant
  // gap for unowned (runBy: null) runs, which the previous hand-rolled guard let
  // through to ALLOW. AuthzError maps to 404 (hidden) / 403 (forbidden).
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
      return new Response(err.statusCode === 404 ? "Not Found" : "Forbidden", {
        status: err.statusCode,
      });
    }
    throw err;
  }
  if (!run) {
    return new Response("Not Found", { status: 404 });
  }

  // When a fresh subscriber connects (no Last-Event-ID) to a run that is
  // already pending_approval, replay from the start of the event log so the
  // INTERRUPT event is delivered and the UI can render the setup form without
  // requiring the job to re-emit it. This stays within the AG-UI event log
  // contract — "0-0" is the Redis Streams sentinel for "start of stream".
  const fromId =
    explicitFromId ??
    (run.status === "pending_approval" ? "0-0" : undefined);

  // ---------------------------------------------------------------------
  // The recommendation hold's LIVE-STATE SNAPSHOT (cinatra#2568, epic #2564
  // S4). A held run is `pending_input`, so it is NOT covered by the
  // pending_approval replay above, and it must not be: the log is durable and
  // a run can be parked, decided, dispatched and parked AGAIN, so replaying
  // history would resurrect a hold the human already answered — the stale-gate
  // failure cinatra#809 fixed for terminal runs, in a new place.
  //
  // So the hold is reconstructed from the PARK, never from the log: derive the
  // run's CURRENT hold (if any) and emit that one synthesized frame first. A
  // fresh subscribe, a reload and a Last-Event-ID reconnect all take this path,
  // which is what makes a late joiner see the hold at all.
  //
  // Deliberately NOT given an SSE `id:` — it is a synthesized frame, not a log
  // entry, so it must never become the client's resume cursor.
  const holdThreadId = recommendationHoldThreadId(run);
  const holdSnapshot = await deriveRecommendationHoldInterrupt({
    runId: decodedRunId,
    threadId: holdThreadId,
  }).catch(() => null);
  let liveHoldId =
    (holdSnapshot &&
      readRecommendationHoldFromEvent(holdSnapshot, decodedRunId)?.holdId) ||
    null;

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
        // The synthesized hold frame goes out BEFORE any log event, so a client
        // that also receives a live hold interrupt in the same connection
        // converges on the newer one rather than the reverse.
        if (holdSnapshot) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(holdSnapshot)}\n\n`),
          );
        }
        const gen = subscribeToAgUiEventsWithId(decodedRunId, {
          signal: abortController.signal,
          fromId,
        });
        for await (const { id, event } of gen) {
          if (closed) break;
          // STALE-HOLD FILTER. A hold interrupt in the log is a historical
          // announcement; the park is the authority on whether it is still the
          // run's hold. Forward one only when its hold id IS the live one —
          // otherwise re-read the park once (a hold minted while this stream
          // was open is legitimately newer than the snapshot) and drop it if
          // the park does not confirm. The re-read costs one query per hold
          // frame that does not match, and a run emits a handful at most.
          const holdOnEvent = readRecommendationHoldFromEvent(
            event,
            decodedRunId,
          );
          if (holdOnEvent) {
            if (holdOnEvent.holdId !== liveHoldId) {
              const current = await deriveRecommendationHoldInterrupt({
                runId: decodedRunId,
                threadId: holdThreadId,
              }).catch(() => null);
              const currentHoldId =
                (current &&
                  readRecommendationHoldFromEvent(current, decodedRunId)
                    ?.holdId) ||
                null;
              if (!currentHoldId || currentHoldId !== holdOnEvent.holdId) {
                continue; // decided, superseded, or never this run's — drop it
              }
              liveHoldId = currentHoldId;
            }
          }
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
