import "server-only";

import type { JSONRPCResponse } from "@a2a-js/sdk";

// ---------------------------------------------------------------------------
// toSseResponse
//
// Bridge between the @a2a-js/sdk streaming return shape (AsyncGenerator of
// JSONRPCResponse) and a spec-compliant Server-Sent Events HTTP Response.
//
// - Each yielded JSONRPCResponse becomes a `data: <json>\n\n` frame.
// - On idle streams, emits `: keepalive\n\n` every 15s so upstream proxies
//   (nginx, cloudflared, CDNs) don't close the connection as inactive.
// - Honors an optional AbortSignal — when aborted, calls `gen.return()` to
//   release any resources held by the generator (Redis subscriptions,
//   BullMQ listeners, etc.) and clears the keepalive interval.
// - If the generator throws, emits a single JSON-RPC error envelope frame
//   (code -32603, message = err.message) before closing, so streaming
//   clients see an explicit failure instead of a silent truncation.
//   Stack traces are never leaked.
// ---------------------------------------------------------------------------

const KEEPALIVE_MS = 15_000;

export type SseResponseOptions = {
  /**
   * Optional extractor: given a chunk, return the SSE `id:` value to emit.
   * When provided and non-empty, the frame becomes:
   *   id: <value>\n
   *   data: <json>\n
   *   \n
   * Used for tasks/resubscribe replay so EventSource clients can send
   * Last-Event-ID on reconnect.
   *
   * Return undefined/null/empty to omit the id: line for that chunk.
   * Values containing U+0000 / U+000A / U+000D are rejected per WHATWG
   * SSE spec and the frame falls back to data-only emission.
   */
  extractId?: (chunk: JSONRPCResponse) => string | undefined;
};

export function toSseResponse(
  gen: AsyncGenerator<JSONRPCResponse>,
  abortSignal?: AbortSignal,
  options?: SseResponseOptions,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      let closed = false;

      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          /* controller already closed */
        }
      }, KEEPALIVE_MS);

      const onAbort = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        try {
          // Best-effort — gen.return() releases resources in the producer.
          void gen.return?.(undefined as never);
        } catch {
          /* ignore */
        }
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          onAbort();
        } else {
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      }

      try {
        for await (const chunk of gen) {
          if (closed || abortSignal?.aborted) break;
          const rawId = options?.extractId
            ? options.extractId(chunk)
            : undefined;
          // WHATWG SSE: the id: field MUST NOT contain U+0000, U+000A,
          // U+000D. Redis Streams native IDs `<digits>-<digits>` are always
          // safe; defensive skip covers future callers that might return
          // arbitrary strings.
          const idIsSafe =
            typeof rawId === "string" &&
            rawId.length > 0 &&
            !/[\u0000\u000A\u000D]/.test(rawId);
          const frame = idIsSafe
            ? `id: ${rawId}\ndata: ${JSON.stringify(chunk)}\n\n`
            : `data: ${JSON.stringify(chunk)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        }
      } catch (err) {
        if (!closed) {
          const envelope = {
            jsonrpc: "2.0" as const,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : "Internal error",
            },
            id: null as null,
          };
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(envelope)}\n\n`),
            );
          } catch {
            /* ignore */
          }
        }
      } finally {
        if (!closed) {
          closed = true;
          clearInterval(keepalive);
          if (abortSignal) {
            abortSignal.removeEventListener("abort", onAbort);
          }
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
