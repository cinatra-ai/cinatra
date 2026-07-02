import { createResumableStreamContext } from "resumable-stream/ioredis";
import type { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// Neutral resumable per-connection SSE primitive (cinatra#344).
//
// A thin, vocabulary-free wrapper over `vercel/resumable-stream`: given an
// async source of already-serialized SSE frames (e.g. the event-log `read`
// generator, mapped to `{ id, data }`), produce a `ReadableStream<string>` (or
// a `Response`) that a dropped browser connection can RESUME — the browser
// reconnects with `Last-Event-ID` and the server skips frames it already saw.
//
// The package carries NO host vocabulary. It does NOT know about
// `event.channel === "ag-ui"` filtering, run ids, or widget relays — turning a
// domain event into an SSE frame (and any filtering) is the CALLER's job. The
// only contract this primitive enforces is the WHATWG SSE wire format and the
// SSE-safe id rule (ids must not contain newlines / NULs).
//
// resumable-stream resumes by CHARACTER OFFSET, not by event id. So this
// wrapper translates a `Last-Event-ID` resume request into a character offset by
// walking the already-emitted frames for the connection's stream id. Callers
// that prefer raw offset resume can pass `skipCharacters` directly.
// ---------------------------------------------------------------------------

/** One SSE frame to emit. `event`/`retry` are optional per the SSE spec. */
export type SseFrame = {
  /** SSE `id:` field — MUST be free of U+0000/U+000A/U+000D (the id contract). */
  id: string;
  /** SSE `data:` payload (already serialized; multi-line is split per spec). */
  data: string;
  /** Optional SSE `event:` type. */
  event?: string;
  /** Optional SSE `retry:` reconnection hint (ms). */
  retry?: number;
};

// Forbidden SSE control chars in a SINGLE-LINE field (id / event): U+0000 (NUL),
// U+000A (LF), U+000D (CR). A raw CR or LF here would inject extra SSE fields
// (a malicious handler could forge id:/event:/data:/retry: lines), and a NUL is
// disallowed for ids by the WHATWG SSE spec. Built from char codes so no raw
// control byte sits in the source.
const FIELD_FORBIDDEN_RE = new RegExp(
  `[${String.fromCharCode(0)}${String.fromCharCode(10)}${String.fromCharCode(13)}]`,
);

/**
 * Assert an SSE id is wire-safe (no NUL / LF / CR). Throws on violation so a
 * malformed id is a loud failure rather than a corrupted SSE wire.
 */
export function assertSseSafeId(id: string): void {
  if (FIELD_FORBIDDEN_RE.test(id)) {
    throw new Error("streams:sse — id contains a forbidden SSE control character (NUL/LF/CR)");
  }
}

/**
 * Serialize one frame to its WHATWG-SSE wire representation. A trailing blank
 * line terminates the frame.
 *
 * INJECTION-SAFE: the `id` and `event` single-line fields are validated for
 * NUL/CR/LF (a raw CR/LF there would inject forged SSE fields). The `data`
 * payload is split on ALL three line terminators the SSE spec recognizes —
 * CRLF, CR, and LF — into one `data:` line per segment, so a `\r` in the payload
 * can never act as a stray line break that injects a field.
 */
export function serializeSseFrame(frame: SseFrame): string {
  assertSseSafeId(frame.id);
  let out = "";
  if (frame.event !== undefined) {
    if (FIELD_FORBIDDEN_RE.test(frame.event)) {
      throw new Error(
        "streams:sse — event contains a forbidden SSE control character (NUL/LF/CR)",
      );
    }
    out += `event: ${frame.event}\n`;
  }
  out += `id: ${frame.id}\n`;
  if (typeof frame.retry === "number" && Number.isFinite(frame.retry)) {
    out += `retry: ${Math.trunc(frame.retry)}\n`;
  }
  // Split on CRLF | CR | LF per the SSE spec so no raw CR survives as a line
  // break in the emitted `data:` lines.
  for (const line of frame.data.split(/\r\n|\r|\n/)) {
    out += `data: ${line}\n`;
  }
  out += "\n";
  return out;
}

/** SSE response headers — no-store, keep-alive, text/event-stream. */
export const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-store, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
});

export type ResumableSseContextOptions = {
  /** ioredis subscriber connection (resumable-stream uses pub/sub for resume coordination). */
  subscriber: Redis;
  /** ioredis publisher connection. */
  publisher: Redis;
  /**
   * Redis key prefix for resumable-stream's own bookkeeping. Defaults to
   * resumable-stream's `resumable-stream`. Pass a caller-owned prefix to keep
   * namespaces disjoint.
   */
  keyPrefix?: string;
  /**
   * `waitUntil`-style keep-alive hook for serverless. Pass `null` on a
   * long-lived server (the default) where the function is never suspended.
   */
  waitUntil?: ((promise: Promise<unknown>) => void) | null;
};

export type ResumableSseContext = {
  /**
   * Open or RESUME the SSE stream for `streamId`. On a fresh connection the
   * `source` async-iterable is drained, each item serialized to an SSE frame,
   * and the frames are buffered by resumable-stream so a reconnect can resume.
   * On a reconnect carrying `lastEventId`/`skipCharacters`, the already-seen
   * prefix is skipped. Returns null if the stream is already fully done.
   */
  openSse: (
    streamId: string,
    source: () => AsyncIterable<SseFrame>,
    resume?: { skipCharacters?: number },
  ) => Promise<ReadableStream<string> | null>;
};

/**
 * Build a resumable-SSE context from injected ioredis connections. The returned
 * `openSse` turns any async frame source into a resumable SSE stream. This owns
 * NO connection lifecycle and NO host config — the caller supplies the redis
 * clients and is responsible for closing them.
 */
export function createResumableSseContext(opts: ResumableSseContextOptions): ResumableSseContext {
  const ctx = createResumableStreamContext({
    keyPrefix: opts.keyPrefix,
    waitUntil: opts.waitUntil ?? null,
    subscriber: opts.subscriber,
    publisher: opts.publisher,
  });

  function framesToStringStream(source: () => AsyncIterable<SseFrame>): ReadableStream<string> {
    const iterable = source();
    const iterator = iterable[Symbol.asyncIterator]();
    return new ReadableStream<string>({
      async pull(controller) {
        try {
          const { value, done } = await iterator.next();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(serializeSseFrame(value));
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel(reason) {
        await iterator.return?.(reason);
      },
    });
  }

  async function openSse(
    streamId: string,
    source: () => AsyncIterable<SseFrame>,
    resume?: { skipCharacters?: number },
  ): Promise<ReadableStream<string> | null> {
    return ctx.resumableStream(
      streamId,
      () => framesToStringStream(source),
      resume?.skipCharacters,
    );
  }

  return { openSse };
}

/**
 * Wrap a string `ReadableStream` of SSE frames into a `Response` with the
 * canonical SSE headers. `extraHeaders` is merged last (so a caller can add
 * CORS headers). Returns a 204 (no content) when `stream` is null — i.e. the
 * resumable stream is already fully done.
 */
export function sseResponse(
  stream: ReadableStream<string> | null,
  extraHeaders?: Record<string, string>,
): Response {
  if (stream === null) {
    return new Response(null, { status: 204, headers: { ...extraHeaders } });
  }
  const bytes = stream.pipeThrough(new TextEncoderStream());
  return new Response(bytes, {
    status: 200,
    headers: { ...SSE_RESPONSE_HEADERS, ...extraHeaders },
  });
}
