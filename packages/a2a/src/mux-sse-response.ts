import "server-only";

import type { JSONRPCResponse } from "@a2a-js/sdk";

// ---------------------------------------------------------------------------
// toMuxSseResponse
//
// Multiplexed variant of toSseResponse. Emits:
//   - A2A JSON-RPC frames as default-event `data: <json>\n\n`
//   - AG-UI execution events as `event: ag-ui\ndata: <json>\n\n`
//
// Both generators are pumped CONCURRENTLY via Promise.all. Either generator
// finishing normally does NOT stop the other — the stream closes only when
// BOTH have finished (or on abort). This means AG-UI frames CAN appear after
// the last A2A frame, which is intentional: AG-UI is additive.
//
// Abort cascades to both generators. AG-UI errors are isolated via
// console.warn so the A2A contract is never corrupted by AG-UI issues.
//
// Keepalive + error-envelope semantics match toSseResponse. Strict A2A
// consumers ignore unknown SSE event types per spec (spec-safe).
// ---------------------------------------------------------------------------

const KEEPALIVE_MS = 15_000;

export function toMuxSseResponse(
  a2aGen: AsyncGenerator<JSONRPCResponse>,
  agUiGen: AsyncGenerator<unknown>,
  abortSignal?: AbortSignal,
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

      const closeAll = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        try {
          void a2aGen.return?.(undefined as never);
        } catch {
          /* ignore */
        }
        try {
          void agUiGen.return?.(undefined as never);
        } catch {
          /* ignore */
        }
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      const onAbort = (): void => {
        closeAll();
      };

      if (abortSignal) {
        if (abortSignal.aborted) {
          closeAll();
          return;
        }
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      async function pumpA2A(): Promise<void> {
        try {
          for await (const chunk of a2aGen) {
            if (closed || abortSignal?.aborted) break;
            try {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
              );
            } catch {
              /* controller already closed */
            }
          }
        } catch (err) {
          if (!closed) {
            // Emit a JSON-RPC error envelope — same contract as toSseResponse.
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
        }
      }

      async function pumpAgUi(): Promise<void> {
        try {
          for await (const event of agUiGen) {
            if (closed || abortSignal?.aborted) break;
            try {
              controller.enqueue(
                encoder.encode(
                  `event: ag-ui\ndata: ${JSON.stringify(event)}\n\n`,
                ),
              );
            } catch {
              /* controller already closed */
            }
          }
        } catch (err) {
          // AG-UI errors are additive — log and isolate. Never emit a
          // JSON-RPC error envelope, which belongs to A2A semantics only.
          console.warn(
            "[toMuxSseResponse] AG-UI generator failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      try {
        // Concurrent pump — both generators run independently; the stream
        // closes only when both have finished or abort fires.
        await Promise.all([pumpA2A(), pumpAgUi()]);
      } finally {
        if (abortSignal) {
          abortSignal.removeEventListener("abort", onAbort);
        }
        closeAll();
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
