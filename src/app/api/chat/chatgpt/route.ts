import { randomUUID } from "node:crypto";
import { callCodexCliAssistant } from "@/lib/codex-bridge";
import { getActorContext } from "@/lib/auth-session";
import { rejectCrossOrigin } from "@/lib/admin-origin-guard";
import { authorizeCodexBridgeRequest, MAX_CHAT_BODY_BYTES } from "./gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChatRequestBody = {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
};

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(request: Request) {
  // 1. Same-origin enforcement (CSRF defense-in-depth for this cookie-backed
  //    route that spawns a server-side process).
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  // 2. Authenticate + authorize (platform operator power) + strict pre-spawn
  //    audit. Nothing is parsed into a prompt or spawned until this passes.
  const actor = await getActorContext();
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const decision = await authorizeCodexBridgeRequest({ actor, requestId });
  if (decision.kind === "deny") {
    return jsonError(decision.status, decision.reason);
  }

  // 3. Read the body with a hard size cap (measured in UTF-8 bytes) so an
  //    unbounded prompt can never be handed to the spawned child.
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_CHAT_BODY_BYTES) {
    return jsonError(413, "Request body too large.");
  }

  let body: ChatRequestBody;
  try {
    body = JSON.parse(raw) as ChatRequestBody;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  const messages = Array.isArray(body?.messages) ? body.messages : [];

  // Pass messages directly — callCodexCliAssistant accepts { messages?: Array<{role, content}> }.
  const thread = { messages };
  const userMessage = messages.filter((m) => m.role === "user").pop()?.content ?? "";

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const reply = await callCodexCliAssistant(thread, userMessage);
        send("text", { content: reply });
        send("done", {});
      } catch (err) {
        const message = err instanceof Error ? err.message : "Codex request failed.";
        send("error", { message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
