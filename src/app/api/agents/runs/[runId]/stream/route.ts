import "server-only";

import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import { AuthzError } from "@/lib/authz";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  buildRecommendationHoldRetirement,
  declaresLifecycleInteraction,
  deriveRecommendationHoldSnapshot,
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
  // The recommendation hold's LIVE-STATE SNAPSHOT + STALE-HOLD FILTER
  // (cinatra#2568, epic #2564 S4).
  //
  // The event log is durable and a run can be parked, decided, dispatched and
  // parked AGAIN, so its log can carry several hold announcements of which at
  // most one is live. Every fresh subscriber replays that whole log (the
  // reader treats an absent `fromId` as "from the start"), so without a filter
  // a late joiner would be handed every hold the run ever had. The PARK is the
  // authority: the run's CURRENT hold is SYNTHESIZED from it, and a hold frame
  // out of the log is forwarded only when the park still confirms it.
  //
  // PRESENCE GATES, VALIDITY PERMITS. Any frame that DECLARES a lifecycle
  // interaction is subject to this policy — including one whose ref cannot be
  // decoded (minted under a rotated secret, forward-versioned, forged).
  // Forwarding those unfiltered would deliver them to clients as ordinary
  // review-task gates, which is exactly the confusion the discriminator exists
  // to prevent.
  const holdThreadId = recommendationHoldThreadId(run);
  const deriveHold = () =>
    deriveRecommendationHoldSnapshot({
      runId: decodedRunId,
      threadId: holdThreadId,
    }).catch(() => ({ status: "unknown" }) as const);

  /** What the park last told us. `unknown` never authorizes anything. */
  let live: Awaited<ReturnType<typeof deriveHold>> = { status: "unknown" };

  /**
   * Should this log frame reach the client? `true` for everything that is not a
   * lifecycle frame — the ordinary wire is untouched.
   *
   * Both arms FAIL CLOSED on `unknown`: an unreadable park cannot authorize
   * showing a hold, and it cannot authorize retiring one either.
   */
  const forwardHoldFrame = async (event: unknown): Promise<boolean> => {
    if (!declaresLifecycleInteraction(event)) return true;
    const claimed = readRecommendationHoldFromEvent(event, decodedRunId);
    if (!claimed) return false; // undecodable / foreign / another run's
    const type = (event as { type?: unknown }).type;
    if (type === "RESUME") {
      // A retirement ALWAYS re-reads the park. "Is this hold over?" is exactly
      // the transition a cached value cannot answer — and a RESUME naming the
      // hold we last saw live is the likeliest case of the park having moved
      // since we looked.
      //
      // A lifecycle RESUME is a "no interaction is live" signal — a client
      // cannot tell WHICH hold it names, the ref being opaque to it — so it is
      // forwarded only when the park says the run has NO live hold at all.
      // While the run is waiting (on this hold or a later one) a replayed
      // retirement would clear a card the run is still behind.
      live = await deriveHold();
      return live.status === "not_held";
    }
    // Re-read whenever an ANNOUNCEMENT disagrees with what we last knew: a hold
    // minted while this stream was open is legitimately newer than the snapshot.
    if (live.status !== "held" || live.holdId !== claimed.holdId) {
      live = await deriveHold();
    }
    // An announcement is forwarded only while it IS the live hold.
    return live.status === "held" && live.holdId === claimed.holdId;
  };

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
        // Derived HERE — as late as the stream allows, and never before the
        // response has begun — so the window between reading the park and
        // announcing it is as small as it can be. Anything that happens after
        // it still reaches the client: the log replay carries the paired frames,
        // and the card's own authorized refetch is what actually decides what is
        // drawn (a snapshot-restored shell renders nothing without it).
        //
        // Deliberately NOT given an SSE `id:` — it is a synthesized frame, not
        // a log entry, so it must never become the client's resume cursor. It
        // goes out first so any newer log frame supersedes it rather than the
        // reverse.
        live = await deriveHold();
        // "NOT HELD" IS ALSO AN ANSWER, and it has to be SAID. An EventSource
        // reconnects on its own, so a client can come back holding a card for a
        // hold that ended while it was away — and if the retirement was lost
        // (the publish is best-effort) or filtered as history, silence would
        // leave that card up forever. So every (re)connect carries the current
        // answer: the hold, or an explicit retirement.
        //
        // `unknown` says NOTHING. A park we could not read must not be reported
        // as "not held" — that would retire the card of a run that is still
        // waiting. The client keeps what it has and its own authorized refetch
        // remains the truth.
        const snapshotFrame =
          live.status === "held"
            ? live.event
            : live.status === "not_held"
              ? buildRecommendationHoldRetirement({
                  runId: decodedRunId,
                  threadId: holdThreadId,
                })
              : null;
        if (snapshotFrame) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(snapshotFrame)}\n\n`),
          );
        }
        const gen = subscribeToAgUiEventsWithId(decodedRunId, {
          signal: abortController.signal,
          fromId,
        });
        for await (const { id, event } of gen) {
          if (closed) break;
          if (!(await forwardHoldFrame(event))) continue;
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
