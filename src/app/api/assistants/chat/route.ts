import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAuthSession, requireActorContext, isPlatformAdmin } from "@/lib/auth-session";
import { hasConfiguredLlmRuntime, runChatTurn, type ChatRequestMessage } from "@/app/api/chat/runner";
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

// ---------------------------------------------------------------------------
// POST /api/assistants/chat — the Cinatra assistant AG-UI endpoint
// (cinatra#1218, epic #1216 S2; realizes #1037 P3's wire half).
//
// One /chat turn on the ONE wire: the caller's messages drive the assistant
// runtime (`runChatTurn` — the #1037 P2 producer) through the bespoke-sink →
// AG-UI adapter; every AG-UI event is durably appended to the unified
// Redis-Streams log (`cinatra:a2a:events:{runId}`, the S1 substrate) and the
// response streams THE LOG back as SSE — each frame carries the Redis entry id
// as its SSE `id:` (the S1 resume cursor), byte-shaped like the proven
// run-stream route (GET /api/agents/runs/[runId]/stream). A dropped consumer
// resumes via GET /api/assistants/runs/[runId]/stream with `Last-Event-ID`.
//
// AUTH + THREAD BINDING. Cookie session (same posture as POST /api/chat), and
// the caller-supplied threadId is authorized against the PERSISTED ownership
// axes — never against request-body claims (the exact POST /api/chat/save
// matrix): personal → owner-or-admin; team → member-of-owning-org-or-admin;
// legacy unowned → allowed; absent → claimed for the caller (a /chat-initiated
// personal thread; the structured row is created here so the run-stream
// authorization never depends on the client's unawaited legacy save racing
// this request). Team threads keep a NULL org anchor (the P2b mirror policy —
// the team→org anchoring decision is flagged on #1218, set-once so it stays
// repairable).
//
// TURN LINKAGE. One `assistant_turns` row (bare-UUID id — the reserved
// `legacy:` mirror namespace is never entered from the runtime side) binds
// run_id → thread with status running → completed | error. While the legacy
// wire's client-side thread save still exists behind the cutover flag, the
// P2b mirror will ALSO write a metadata row for the same assistant message —
// a known, documented transitional double representation that the S2 delete
// stage collapses (no structured READER consumes turns yet; the mirror row
// carries no run_id and cannot be confused with the runtime row).
//
// LIFECYCLE PARITY (#503): client disconnect aborts the in-flight run exactly
// like the legacy POST /api/chat — the durable log makes the transport
// contract-shaped, but the cutover deliberately does NOT change the product
// behavior that an abandoned turn stops consuming LLM/MCP work. Terminal
// frames are exactly-once: the adapter dedupes, and ensureTerminal() covers
// every runtime path that returns without `done` (explicit-dispatch
// short-circuits, pre-stream error returns) or throws.
// ---------------------------------------------------------------------------

const attachmentRefSchema = z
  .object({
    artifactId: z.string().min(1),
    representationRevisionId: z.string().min(1),
    digest: z.string().min(1),
    mime: z.string().min(1),
    originKind: z.enum([
      "upload",
      "email_attachment",
      "agent_generated",
      "external_link",
      "live_generator",
    ]),
    title: z.string().optional(),
    filename: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .strict();

const chatMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    attachments: z.array(attachmentRefSchema).max(20).optional(),
  })
  .strict();

const assistantChatBodySchema = z.object({
  threadId: z.string().min(1).max(200),
  messages: z.array(chatMessageSchema),
});

const KEEPALIVE_MS = 15_000;

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

type ThreadAuthorization =
  | { ok: true; mirrorOrgId: string | null; needsStructuredRow: boolean }
  | { ok: false; status: number; error: string };

/** Authorize the caller against the thread's PERSISTED ownership axes (the
 *  POST /api/chat/save matrix), never against request-body claims. */
function authorizeThreadForTurn(params: {
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

export async function POST(request: Request) {
  const raw = (await request.json().catch(() => null)) as unknown;
  const parsed = assistantChatBodySchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid assistant chat request shape", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { threadId } = parsed.data;
  const messages: ChatRequestMessage[] = parsed.data.messages;

  const hasProvider = await hasConfiguredLlmRuntime();
  if (!hasProvider) {
    return Response.json({ error: "No LLM provider configured." }, { status: 400 });
  }

  const session = await getAuthSession();
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const actorContext = await requireActorContext();
  const isAdmin = isPlatformAdmin(session);
  const platformRole: "platform_admin" | "member" = isAdmin ? "platform_admin" : "member";
  const sessionOrgId =
    (session?.session as { activeOrganizationId?: string | null } | undefined)
      ?.activeOrganizationId ?? null;

  const authz = authorizeThreadForTurn({
    threadId,
    callerId: userId,
    isAdmin,
    sessionOrgId,
  });
  if (!authz.ok) {
    return Response.json({ error: authz.error }, { status: authz.status });
  }

  // Bind the turn BEFORE the run starts so the resume route can authorize a
  // reconnect that races the very first events.
  if (authz.needsStructuredRow) {
    try {
      createAssistantThread({
        id: threadId,
        ownerUserId: userId,
        orgId: authz.mirrorOrgId,
      });
    } catch {
      // Lost a create race (the legacy save's mirror or a concurrent turn).
      // The absence check above was TOCTOU — RE-AUTHORIZE against the row
      // that actually won before binding a turn to it (fail-closed: without
      // this, a racing caller could append a turn to a thread another user
      // claimed in the window).
      const winner = getAssistantThread(threadId);
      if (!isAdmin && winner && winner.ownerUserId !== userId) {
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

  // Aborted when the client disconnects (stream cancel / request abort) so
  // the in-flight run stops consuming LLM/MCP work (#503 — legacy-parity
  // lifecycle), and when the durable wire breaks (publish failure).
  const runAbort = new AbortController();
  // Aborts the log-tail subscription when the wire breaks — without this a
  // mid-run publish failure would leave the tail waiting on a terminal frame
  // that can never arrive (until the subscriber's inactivity timeout).
  const tailAbort = new AbortController();
  request.signal.addEventListener("abort", () => tailAbort.abort(), { once: true });
  let publishFailure: unknown = null;

  const adapter = createAgUiSinkAdapter({
    runId,
    threadId,
    publish: (event) => publishToRunLog(runId, event),
    onPublishFailure: (err) => {
      // The durable log IS the wire — a lost append strands every subscriber.
      // Stop the runtime (don't burn LLM/MCP work onto a dead wire) and
      // release the tail immediately; the finalizer below delivers a
      // synthetic terminal to THIS consumer.
      publishFailure = err;
      runAbort.abort(new Error("assistant chat durable publish failed"));
      tailAbort.abort();
    },
  });

  // Drive the runtime concurrently with the log-tail below. The durable log
  // decouples production from delivery; this promise owns the terminal
  // guarantee. NEVER rejects (publish failures land in `publishFailure`).
  const runPromise = (async () => {
    adapter.start();
    try {
      await runChatTurn({
        messages,
        actorContext,
        userId,
        platformRole,
        sessionOrgId,
        send: adapter.send,
        signal: runAbort.signal,
      });
      adapter.ensureTerminal();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Chat request failed.";
      adapter.ensureTerminal(message);
      console.error("[assistants/chat] runChatTurn threw:", err);
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
        // The request went away without the stream's cancel() firing —
        // stop the run too (never rely on cancel() alone; #503 parity).
        runAbort.abort(new Error("assistant chat request aborted"));
        finish();
      };
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
          updateAssistantTurn(turn.id, {
            status: adapter.outcome === "error" ? "error" : "completed",
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
      // stops promptly instead of burning metered LLM/MCP work unheard —
      // byte-parity with the legacy POST /api/chat lifecycle (#503).
      runAbort.abort(reason instanceof Error ? reason : new Error("assistant chat stream cancelled"));
      tailAbort.abort();
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
