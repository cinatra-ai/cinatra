// Guarded SSE sink for the chat stream (#503).
//
// `ReadableStreamDefaultController.enqueue` throws `ERR_INVALID_STATE` once the
// stream is torn down (client disconnect / page refresh) or after `close()`.
// Previously `send()` was a raw `enqueue`, so that throw killed the terminal
// `error`/`done` event — leaving the chat UI "thinking forever". This wraps
// enqueue so post-teardown writes are a safe no-op, and exposes `markClosed()`
// for the stream's `finally`/`cancel` paths.

export type SseEnqueueController = {
  enqueue: (chunk: Uint8Array) => void;
  // null once the stream is closed/errored/cancelled.
  readonly desiredSize: number | null;
};

export type Utf8Encoder = { encode: (input: string) => Uint8Array };

export type GuardedSseSink = {
  /** Enqueue an SSE `event:`/`data:` frame, or no-op if the stream is gone. */
  send: (event: string, data: unknown) => void;
  /** Mark the stream closed so further sends no-op (call before `close()`). */
  markClosed: () => void;
  readonly isClosed: boolean;
};

export function createGuardedSseSink(
  controller: SseEnqueueController,
  encoder: Utf8Encoder,
): GuardedSseSink {
  let closed = false;
  return {
    send(event: string, data: unknown): void {
      // desiredSize === null means the stream is no longer writable.
      if (closed || controller.desiredSize === null) return;
      // Build the frame OUTSIDE the try so a serialization/encoding bug surfaces
      // instead of being misread as a closed stream; only guard enqueue itself.
      const frame = encoder.encode(
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      );
      try {
        controller.enqueue(frame);
      } catch {
        // Torn down between the desiredSize check and enqueue — stop writing.
        closed = true;
      }
    },
    markClosed(): void {
      closed = true;
    },
    get isClosed(): boolean {
      return closed;
    },
  };
}
