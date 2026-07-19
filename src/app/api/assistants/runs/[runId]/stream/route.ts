import "server-only";

import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { findAssistantTurnByRunId, getAssistantThread } from "@/lib/assistant-thread-store";
import { loadChatThreadForActorAccess } from "@/lib/chat-thread-store";
import { evaluateChatThreadAccess } from "@/lib/chat-thread-access";
import { subscribeToAgUiEventsWithId } from "@cinatra-ai/agent-ui-protocol/server";
import { verifyWidgetChatResumeToken } from "@/lib/widget-chat-resume-token";

// ---------------------------------------------------------------------------
// GET /api/assistants/runs/[runId]/stream — AG-UI resume/tail for an
// ASSISTANT turn (cinatra#1218, epic #1216 S2).
//
// The assistant-endpoint sibling of the proven agent run-stream route
// (GET /api/agents/runs/[runId]/stream): same durable Redis-Streams log, same
// SSE `id:` frames, same `Last-Event-ID` resume, same
// transport-errors-are-not-run-errors contract. It differs ONLY in
// authorization — assistant turns are not `agent_runs` rows; the run is
// resolved run_id → assistant_turns → thread and access is decided by ONE of
// TWO modes:
//
//   1. SESSION (in-app chat) — the legacy chat_threads row (when it exists)
//      through evaluateChatThreadAccess (owner / team / admin; legacy unowned
//      rows are public — HTTP-route parity), else the structured
//      assistant_threads row (the POST endpoint creates it BEFORE the run
//      starts, so a reconnect can never race the client's unawaited legacy
//      save): owner-or-admin. Denials return 404 (existence not disclosed).
//
//   2. BROKER RESUME TOKEN (S5 public-site widget, cinatra#1221; OWNER RULING
//      2026-07-19 — OPTION A). A cross-origin widget has no Cinatra cookie, so
//      when there is NO session it may present a DISTINCT, short-lived,
//      RUN-BOUND resume token (`cinatra.widget.chat-resume`) on `Authorization:
//      Bearer`. The resume endpoint keeps its OWN audience — the chat-audience
//      broker (cit_/cwu_) token is NEVER accepted here (option B, audience-
//      widening, was rejected). The token is minted server-side ONLY after the
//      broker-auth turn fully authorized THIS run for THIS user and is bound to
//      this EXACT runId, so a valid token IS the authorization. Any
//      missing/invalid/expired/cross-run/cross-type token is an EXPLICIT refusal
//      (401) — NEVER a silent fresh mount; the client falls back to a fresh
//      mount on the refusal (the shipped degrade).
//
// NOTE (scope): the cross-origin CORS reflection (preflight + Access-Control-*)
// for the widget's resume GET rides the Lane B embed build wave alongside the
// client that issues that request (mirroring how the turn POST's CORS shipped
// with its consumer in #1848). This slice lands the AUTHORIZATION acceptance —
// the §9.3(A) invariant the ruling decided — plus its token; the embed core is
// otherwise inert. The session mode is byte-unchanged.
// ---------------------------------------------------------------------------

type RouteContext = { params: Promise<{ runId: string }> };

const KEEPALIVE_MS = 15_000;

export async function GET(request: Request, context: RouteContext) {
  const { runId } = await context.params;
  const decodedRunId = decodeURIComponent(runId);

  const session = await getAuthSession();
  const actorUserId = session?.user?.id ?? null;

  if (actorUserId) {
    // ----- MODE 1: SESSION (byte-identical to before S5) -----
    const isAdmin = isPlatformAdmin(session);

    const turn = findAssistantTurnByRunId(decodedRunId);
    if (!turn) {
      return new Response("Not Found", { status: 404 });
    }

    // Thread access policy — legacy row first (the richer axes), structured
    // row as the pre-save fallback.
    let allowed = false;
    const legacyAccess = loadChatThreadForActorAccess({
      threadId: turn.threadId,
      actorUserId,
      isPlatformAdmin: isAdmin,
    });
    if (legacyAccess) {
      allowed = evaluateChatThreadAccess({
        ownerUserId: legacyAccess.ownerUserId,
        teamId: legacyAccess.teamId,
        actorUserId,
        isPlatformAdmin: isAdmin,
        isActorTeamMember: legacyAccess.isActorTeamMember,
      });
    } else {
      const structured = getAssistantThread(turn.threadId);
      allowed =
        structured !== null &&
        (isAdmin || (structured.ownerUserId !== null && structured.ownerUserId === actorUserId));
    }
    if (!allowed) {
      return new Response("Not Found", { status: 404 });
    }
  } else {
    // ----- MODE 2: BROKER RESUME TOKEN (S5, cinatra#1221 — option A) -----
    // Verify a DISTINCT run-bound resume token, BOUND to this exact runId. A
    // chat-audience broker token, an mcp-obo token, an expired/stretched token,
    // or a token minted for a DIFFERENT run all fail the verifier (wrong type /
    // aud / run-binding) → null. Fail closed with an EXPLICIT 401 — never fall
    // through to a fresh mount silently (the client degrades to fresh mount).
    const resumeActor = verifyWidgetChatResumeToken({
      authHeader: request.headers.get("authorization"),
      expectedRunId: decodedRunId,
    });
    if (!resumeActor) {
      return new Response("Unauthorized", { status: 401 });
    }
    // The run-bound token IS the authorization (minted only after the broker-auth
    // turn fully authorized THIS run for THIS user). Still confirm the run's turn
    // row exists — a token for a run with no turn can tail nothing → 404
    // (existence not disclosed, matching the session path).
    const turn = findAssistantTurnByRunId(decodedRunId);
    if (!turn) {
      return new Response("Not Found", { status: 404 });
    }
  }

  // Last-Event-ID resume cursor; malformed values are treated as absent
  // (defense-in-depth — the cursor goes verbatim to XRANGE).
  const rawLastEventId = request.headers.get("last-event-id");
  const fromId =
    rawLastEventId && /^\d+-\d+$/.test(rawLastEventId) ? rawLastEventId : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          /* torn down */
        }
      }, KEEPALIVE_MS);

      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const onAbort = (): void => finish();
      request.signal.addEventListener("abort", onAbort, { once: true });

      try {
        for await (const { id, event } of subscribeToAgUiEventsWithId(decodedRunId, {
          signal: request.signal,
          fromId,
        })) {
          if (closed) break;
          const frame = id
            ? `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`
            : `data: ${JSON.stringify(event)}\n\n`;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            break;
          }
        }
      } catch (err) {
        // Transport failure — log server-side, no synthetic RUN_ERROR
        // (RUN_ERROR means the RUN failed; the browser reconnects with its
        // cached Last-Event-ID).
        console.error(
          `[assistants/runs/stream] SSE transport error for run ${decodedRunId}:`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        finish();
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
