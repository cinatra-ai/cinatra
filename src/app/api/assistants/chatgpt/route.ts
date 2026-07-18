import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getAuthSession, getActorContext, isPlatformAdmin } from "@/lib/auth-session";
import { callCodexCliAssistant } from "@/lib/codex-bridge";
import { rejectCrossOrigin } from "@/lib/admin-origin-guard";
import {
  authorizeCodexBridgeRequest,
  MAX_CHAT_BODY_BYTES,
} from "@/app/api/chat/chatgpt/gate";
import {
  authorizeThreadForTurn,
  streamAgUiChatTurn,
} from "@/lib/assistant-runtime/ag-ui-stream-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/assistants/chatgpt — the @chatgpt bridge on the unified AG-UI wire
// (cinatra#1218, epic #1216 S2 — predecessor 3 of the delete stage).
//
// The @chatgpt built-in used to ride the bespoke `/api/chat/chatgpt` SSE
// (`event: text` / `event: done`). This route migrates it onto the ONE wire:
// same Codex CLI bridge (`callCodexCliAssistant`, one read-only exec per turn),
// but its single atomic reply is emitted through the SAME durable-log AG-UI
// harness the Cinatra endpoint uses (`streamAgUiChatTurn`). The bespoke sink's
// `text` → `done` sequence maps to `TEXT_MESSAGE_START/CONTENT/END` →
// `RUN_FINISHED` via `createAgUiSinkAdapter`, so `/chat` renders the Codex reply
// on the unified wire with zero client-side special-casing.
//
// SECURITY PARITY with the legacy bespoke route — the ordering is preserved
// exactly: (1) same-origin enforcement (CSRF defense-in-depth for this
// cookie-backed route that spawns a server-side process); (2) authenticate +
// authorize the platform OPERATOR power + strict pre-spawn audit — nothing is
// parsed into a prompt or spawned until this passes; (3) bounded body read (the
// same UTF-8 byte cap) and parse. Only THEN is the thread authorized and the
// turn bound. A non-operator caller is denied 403 BEFORE any stream opens —
// byte-parity with the legacy route (the client surfaces the failed request as
// an error bubble either way).
//
// The bespoke `/api/chat/chatgpt` route was deleted by the #1218 mechanical
// delete stage: this endpoint is the only @chatgpt producer, and a failed
// AG-UI handshake surfaces a fail-closed turn error (no fallback wire — see
// chat-page.tsx streamResponse).
// ---------------------------------------------------------------------------

const chatMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    // Attachments are accepted for shape-parity with the Cinatra endpoint but
    // the Codex bridge only consumes role/content.
    attachments: z.array(z.unknown()).max(20).optional(),
  })
  .strict();

const assistantChatgptBodySchema = z.object({
  threadId: z.string().min(1).max(200),
  messages: z.array(chatMessageSchema),
});

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Read the request body with a HARD byte cap enforced WHILE streaming: the read
 * aborts (cancelling the stream) the moment the accumulated UTF-8 byte count
 * exceeds `maxBytes`, so an authorized caller can never force the server to
 * buffer an unbounded prompt before the cap is checked. Returns the decoded
 * text, or `null` when the cap is exceeded.
 */
async function readBodyBounded(request: Request, maxBytes: number): Promise<string | null> {
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export async function POST(request: Request) {
  // 1. Same-origin enforcement (CSRF defense-in-depth — this cookie-backed
  //    route spawns a server-side Codex process).
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  // 2. Authenticate + authorize (platform operator power) + strict pre-spawn
  //    audit. Nothing is parsed into a prompt or spawned until this passes.
  const session = await getAuthSession();
  const actor = await getActorContext();
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const decision = await authorizeCodexBridgeRequest({ actor, requestId });
  if (decision.kind === "deny") {
    return jsonError(decision.status, decision.reason);
  }

  // 3. Bounded body read (UTF-8 byte cap enforced WHILE streaming) BEFORE parse,
  //    so an unbounded prompt can never be buffered — let alone handed to the
  //    spawned child.
  const rawText = await readBodyBounded(request, MAX_CHAT_BODY_BYTES);
  if (rawText === null) {
    return jsonError(413, "Request body too large.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  const parsed = assistantChatgptBodySchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, "Invalid assistant chat request shape.");
  }
  const { threadId, messages } = parsed.data;

  // The operator gate above already required an authenticated actor; the
  // session's user id anchors the thread ownership axes.
  const userId = session?.user?.id;
  if (!userId) {
    return jsonError(401, "Authentication required.");
  }
  const isAdmin = isPlatformAdmin(session);
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
    return jsonError(authz.status, authz.error);
  }

  const thread = { messages };
  const userMessage = messages.filter((m) => m.role === "user").pop()?.content ?? "";

  return streamAgUiChatTurn({
    request,
    threadId,
    mirrorOrgId: authz.mirrorOrgId,
    needsStructuredRow: authz.needsStructuredRow,
    userId,
    isAdmin,
    // The @chatgpt producer: one Codex CLI exec, one atomic reply. Mirrors the
    // legacy bespoke route's `send("text", reply)` → `send("done")` sequence
    // (which the AG-UI adapter maps onto TEXT_MESSAGE_* → RUN_FINISHED). A
    // spawn/read failure surfaces as an `error` sink event → terminal RUN_ERROR;
    // `callCodexCliAssistant` itself never throws (it resolves an "@chatgpt
    // failed…" string), so the try/catch is belt-and-suspenders parity.
    runProducer: async (send) => {
      try {
        const reply = await callCodexCliAssistant(thread, userMessage);
        send("text", { content: reply });
        send("done", {});
      } catch (err) {
        const message = err instanceof Error ? err.message : "Codex request failed.";
        send("error", { message });
      }
    },
  });
}
