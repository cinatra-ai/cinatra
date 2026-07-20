import "server-only";

import { randomUUID } from "node:crypto";
import { createAgUiSinkAdapter } from "@/lib/assistant-runtime/ag-ui-sink-adapter";
import {
  appendAssistantTurn,
  createAssistantThread,
  getAssistantThread,
  touchAssistantThread,
  updateAssistantTurn,
} from "@/lib/assistant-thread-store";
import {
  isActorTeamMemberForChat,
  readChatThreadOwnershipById,
} from "@/lib/chat-thread-store";
import { xaddRunEvent, expireRunStream } from "@cinatra-ai/a2a";
import { subscribeToAgUiEventsWithId } from "@cinatra-ai/agent-ui-protocol/server";
import type { AgUiEvent } from "@cinatra-ai/agent-ui-protocol";
import { WIDGET_CHAT_RESUME_TOKEN_HEADER } from "@/lib/widget-chat-resume-token";

// ---------------------------------------------------------------------------
// Shared AG-UI chat-turn streaming harness (cinatra#1218, epic #1216 S2 —
// predecessor 3 of the delete stage).
//
// Extracted VERBATIM from POST /api/assistants/chat so a second AG-UI
// consumer (the @chatgpt Codex bridge, POST /api/assistants/chatgpt) reuses
// the exact durable-log substrate, turn linkage, TOCTOU-safe thread binding,
// abort lifecycle, terminal-exactly-once guarantee, and resume window — rather
// than duplicating that security-critical machinery. The ONLY per-producer
// difference is the `runProducer` callback: the Cinatra endpoint drives
// `runChatTurn`; the @chatgpt endpoint drives the Codex bridge. Both emit the
// bespoke sink vocabulary that `createAgUiSinkAdapter` maps onto AG-UI events.
//
// The existing `/api/assistants/chat` route tests are the extraction-parity
// gate: the default endpoint's behavior is byte-identical because it now calls
// this harness with `runProducer = runChatTurn`.
//
// The caller owns validation + authentication + authorization BEFORE invoking
// this harness (parse the request once; this harness uses `request` only for
// cancellation/lifecycle). The `@chatgpt` caller additionally enforces the
// same-origin + operator-authorization + strict-audit ordering the legacy
// bespoke route did, all before the body is even read.
// ---------------------------------------------------------------------------

const KEEPALIVE_MS = 15_000;

/** ChatStreamSink-shaped producer: drives the assistant turn, emitting bespoke
 *  sink events (`text` / `thinking_*` / `tool_*` / `citations` / `error` /
 *  `done`) that the AG-UI adapter translates. Resolves when the turn is done;
 *  the harness calls `ensureTerminal()` for producers that return without a
 *  `done` event, and surfaces a throw as a terminal RUN_ERROR. */
export type AgUiChatRunProducer = (
  send: (event: string, data: unknown) => void,
  signal: AbortSignal,
) => Promise<void>;

export type ThreadAuthorization =
  | { ok: true; mirrorOrgId: string | null; needsStructuredRow: boolean }
  | { ok: false; status: number; error: string };

/** Authorize the caller against the thread's PERSISTED ownership axes (the
 *  POST /api/chat/save matrix), never against request-body claims. Shared by
 *  every AG-UI chat producer so the authorization posture cannot drift between
 *  the Cinatra and @chatgpt endpoints. */
export function authorizeThreadForTurn(params: {
  threadId: string;
  callerId: string;
  isAdmin: boolean;
  sessionOrgId: string | null;
}): ThreadAuthorization {
  const { threadId, callerId, isAdmin, sessionOrgId } = params;

  const legacy = readChatThreadOwnershipById(threadId);
  if (legacy) {
    if (legacy.ownerUserId) {
      if (legacy.ownerUserId !== callerId && !isAdmin) {
        return { ok: false, status: 403, error: "Forbidden" };
      }
      return {
        ok: true,
        mirrorOrgId: sessionOrgId,
        needsStructuredRow: getAssistantThread(threadId) === null,
      };
    }
    if (legacy.teamId) {
      if (!isAdmin && !isActorTeamMemberForChat(legacy.teamId, callerId)) {
        return { ok: false, status: 403, error: "Forbidden" };
      }
      // Team threads keep the NULL org anchor (P2b mirror policy; the
      // team→org anchoring decision is flagged on #1218 — set-once keeps it
      // repairable).
      return {
        ok: true,
        mirrorOrgId: null,
        needsStructuredRow: getAssistantThread(threadId) === null,
      };
    }
    // Legacy unowned thread — grandfathered writable (save-route parity).
    return {
      ok: true,
      mirrorOrgId: null,
      needsStructuredRow: getAssistantThread(threadId) === null,
    };
  }

  // No legacy row. A structured row may exist (created by a previous turn on
  // this wire before the client's unawaited legacy save landed, or a
  // post-cutover thread): authorize against ITS owner axis. FAIL-CLOSED for
  // an ownerless structured row (owner-or-admin only) — this route always
  // claims new rows with an owner, and the resume route denies ownerless
  // structured rows to non-admins too (POST/GET policy symmetry).
  const structured = getAssistantThread(threadId);
  if (structured) {
    if (!isAdmin && structured.ownerUserId !== callerId) {
      return { ok: false, status: 403, error: "Forbidden" };
    }
    return { ok: true, mirrorOrgId: sessionOrgId, needsStructuredRow: false };
  }

  // Absent everywhere — a brand-new /chat-initiated personal thread; the
  // caller claims it.
  return { ok: true, mirrorOrgId: sessionOrgId, needsStructuredRow: true };
}

/** Publish one AG-UI event to the durable log. FAIL-LOUD (unlike the
 *  best-effort publishAgUiEvent): the log IS the wire here — a lost append
 *  would strand every subscriber without a terminal frame, so the adapter
 *  surfaces the failure instead of swallowing it. */
async function publishToRunLog(runId: string, event: AgUiEvent): Promise<void> {
  await xaddRunEvent(runId, {
    channel: "ag-ui",
    ...(event as unknown as Record<string, unknown>),
  });
}

/**
 * Stream one assistant turn over the unified AG-UI wire. Binds the thread's
 * structured row (TOCTOU-safe), appends the `assistant_turns` row, drives
 * `runProducer` through the bespoke→AG-UI adapter into the durable Redis-Streams
 * log, and streams THE LOG back as SSE (each frame carrying the Redis entry id
 * as the S1 resume cursor). Returns the streaming Response.
 *
 * Every caller has already validated the body and authorized `threadId`
 * (`authorizeThreadForTurn`) against the persisted ownership axes.
 */
export async function streamAgUiChatTurn(params: {
  request: Request;
  threadId: string;
  /** From the caller's `authorizeThreadForTurn` result. */
  mirrorOrgId: string | null;
  needsStructuredRow: boolean;
  /** Resolved caller identity (owner claim + create-race reauthorization). */
  userId: string;
  isAdmin: boolean;
  runProducer: AgUiChatRunProducer;
  /**
   * OPTIONAL resume-credential mint (S5 broker-auth widget path, cinatra#1221).
   * Given the freshly-minted `runId`, returns a DISTINCT run-bound resume token
   * (`cinatra.widget.chat-resume`) to DELIVER to the cross-origin embed on the
   * turn response so it can resume under broker auth (the resume route is
   * session-only otherwise). ABSENT on the cookie-session path — that path
   * resumes via its ambient session and this response stays byte-identical (no
   * header emitted). The callback owns the mint (it holds the server-verified
   * widget principal); the harness only delivers the returned token as a header.
   */
  mintResumeToken?: (runId: string) => string | null;
}): Promise<Response> {
  const { request, threadId, mirrorOrgId, needsStructuredRow, userId, isAdmin, runProducer } =
    params;

  // Bind the turn BEFORE the run starts so the resume route can authorize a
  // reconnect that races the very first events.
  if (needsStructuredRow) {
    try {
      createAssistantThread({
        id: threadId,
        ownerUserId: userId,
        orgId: mirrorOrgId,
      });
    } catch {
      // Lost a create race (the legacy save's mirror or a concurrent turn).
      // The absence check was TOCTOU — RE-AUTHORIZE against the row that
      // actually won before binding a turn to it (fail-closed: without this,
      // a racing caller could append a turn to a thread another user claimed
      // in the window).
      const winner = getAssistantThread(threadId);
      if (!winner) {
        // Not a lost race — the create itself failed. Fail loud instead of
        // letting appendAssistantTurn hit the FK with no thread row.
        return Response.json({ error: "Could not bind the chat thread." }, { status: 500 });
      }
      if (!isAdmin && winner.ownerUserId !== userId) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
    }
  }
  const runId = randomUUID();
  const turn = appendAssistantTurn({
    threadId,
    runId,
    role: "assistant",
    status: "running",
  });
  touchAssistantThread(threadId);

  // Mint the DISTINCT run-bound resume token NOW (the runId exists) so it rides
  // the turn response header for the cross-origin embed. Only the broker-auth
  // caller supplies the callback; on the cookie-session path it is absent and no
  // header is emitted (byte-identical response). A `null`/throwing mint never
  // fails the turn — resume simply degrades to a fresh mount (the shipped
  // degrade), never a silent auth-widening.
  let resumeToken: string | null = null;
  if (params.mintResumeToken) {
    try {
      resumeToken = params.mintResumeToken(runId);
    } catch {
      resumeToken = null;
    }
  }

  // Aborted when the client disconnects (stream cancel / request abort) so the
  // in-flight run stops consuming work (#503 — legacy-parity lifecycle), and
  // when the durable wire breaks (publish failure).
  const runAbort = new AbortController();
  // Aborts the log-tail subscription when the wire breaks — without this a
  // mid-run publish failure would leave the tail waiting on a terminal frame
  // that can never arrive (until the subscriber's inactivity timeout).
  const tailAbort = new AbortController();
  // An ALREADY-aborted request signal fires no further events — check first.
  if (request.signal.aborted) tailAbort.abort();
  request.signal.addEventListener("abort", () => tailAbort.abort(), { once: true });
  let publishFailure: unknown = null;

  const adapter = createAgUiSinkAdapter({
    runId,
    threadId,
    publish: (event) => publishToRunLog(runId, event),
    onPublishFailure: (err) => {
      // The durable log IS the wire — a lost append strands every subscriber.
      // Stop the runtime (don't burn work onto a dead wire) and release the
      // tail immediately; the finalizer below delivers a synthetic terminal to
      // THIS consumer.
      publishFailure = err;
      runAbort.abort(new Error("assistant chat durable publish failed"));
      tailAbort.abort();
    },
  });

  // Drive the producer concurrently with the log-tail below. The durable log
  // decouples production from delivery; this promise owns the terminal
  // guarantee. NEVER rejects (publish failures land in `publishFailure`).
  const runPromise = (async () => {
    adapter.start();
    try {
      await runProducer(adapter.send, runAbort.signal);
      adapter.ensureTerminal();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Chat request failed.";
      adapter.ensureTerminal(message);
      console.error("[assistants/chat] runProducer threw:", err);
    }
    await adapter.drain().catch((err) => {
      publishFailure = publishFailure ?? err;
    });
  })();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          // Torn down — the next tick is a no-op.
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

      const onAbort = (): void => {
        // The request went away without the stream's cancel() firing — stop
        // the run too (never rely on cancel() alone; #503 parity).
        runAbort.abort(new Error("assistant chat request aborted"));
        finish();
      };
      if (request.signal.aborted) onAbort();
      request.signal.addEventListener("abort", onAbort, { once: true });

      try {
        // Tail the durable log from the start of the stream — production and
        // delivery are decoupled, so a subscriber starting after the first
        // appends still replays the full turn. Frames carry the Redis entry
        // id as SSE `id:` (the S1 resume cursor).
        for await (const { id, event } of subscribeToAgUiEventsWithId(runId, {
          signal: tailAbort.signal,
        })) {
          if (closed) break;
          const frame = id
            ? `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`
            : `data: ${JSON.stringify(event)}\n\n`;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            break; // consumer went away; cancel()/onAbort abort the run
          }
          // subscribeToAgUiEventsWithId returns after a terminal event.
        }
      } catch (err) {
        console.error(
          `[assistants/chat] SSE transport error for run ${runId}:`,
          err instanceof Error ? err.message : err,
        );
      }

      // Finalize: the run promise owns terminal-exactly-once (it never
      // rejects); reflect its outcome on the turn row and TTL the run stream
      // (terminal replay window, per the S1 contract).
      try {
        await runPromise;
        if (publishFailure !== null) {
          // The wire broke — the log may be missing the terminal frame, so
          // deliver one directly to THIS consumer before closing (a resume
          // would see an incomplete log).
          console.error(`[assistants/chat] durable publish failed for run ${runId}:`, publishFailure);
          updateAssistantTurn(turn.id, { status: "error" });
          try {
            const synthetic: AgUiEvent = {
              type: "RUN_ERROR",
              threadId,
              runId,
              message: "The assistant stream failed. Please try again.",
              timestamp: Date.now(),
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(synthetic)}\n\n`));
          } catch {
            /* consumer already gone */
          }
        } else {
          // Persist the durable per-turn content (cinatra#1037 P5.6 drop-history
          // PR1 EXPAND) alongside the terminal status, so a NEW conversation's
          // assistant turn survives in Postgres — not only in the bounded/lossy
          // Redis AG-UI log. `null` (an empty turn) leaves content untouched.
          const durable = adapter.durableContent();
          updateAssistantTurn(turn.id, {
            status: adapter.outcome === "error" ? "error" : "completed",
            ...(durable !== null ? { content: durable } : {}),
          });
        }
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        await expireRunStream(runId).catch(() => {});
        finish();
      }
    },
    cancel(reason) {
      // Client went away (refresh / navigation / stop). Abort the run so it
      // stops promptly instead of burning metered work unheard — byte-parity
      // with the legacy POST /api/chat lifecycle (#503).
      runAbort.abort(reason instanceof Error ? reason : new Error("assistant chat stream cancelled"));
      tailAbort.abort();
    },
  });

  const responseHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
  if (resumeToken) {
    responseHeaders[WIDGET_CHAT_RESUME_TOKEN_HEADER] = resumeToken;
  }
  return new Response(stream, { headers: responseHeaders });
}
