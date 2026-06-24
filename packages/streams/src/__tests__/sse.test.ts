import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock resumable-stream/ioredis with a faithful-enough fake: per-streamId the
// fake buffers the full serialized output, and a resume (skipCharacters > 0)
// returns a stream starting AFTER the already-seen prefix — the
// resumable-by-character-offset contract this wrapper relies on. No live Redis.
// ---------------------------------------------------------------------------

const buffers = new Map<string, string>();

async function drainToString(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += value;
  }
  return out;
}

function stringStreamFrom(text: string): ReadableStream<string> {
  let sent = false;
  return new ReadableStream<string>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(text);
    },
  });
}

vi.mock("resumable-stream/ioredis", () => ({
  createResumableStreamContext: () => ({
    async resumableStream(
      streamId: string,
      makeStream: () => ReadableStream<string>,
      skipCharacters?: number,
    ): Promise<ReadableStream<string> | null> {
      let full = buffers.get(streamId);
      if (full === undefined) {
        full = await drainToString(makeStream());
        buffers.set(streamId, full);
      }
      const skip = skipCharacters ?? 0;
      return stringStreamFrom(full.slice(skip));
    },
  }),
}));

import {
  createResumableSseContext,
  serializeSseFrame,
  assertSseSafeId,
  sseResponse,
  SSE_RESPONSE_HEADERS,
  type SseFrame,
} from "../sse";

const fakeRedis = {} as never;

function makeCtx() {
  return createResumableSseContext({ subscriber: fakeRedis, publisher: fakeRedis });
}

async function* frames(items: SseFrame[]): AsyncIterable<SseFrame> {
  for (const f of items) yield f;
}

describe("sse frame serialization", () => {
  it("serializes id + data with a terminating blank line", () => {
    expect(serializeSseFrame({ id: "1-0", data: "hello" })).toBe("id: 1-0\ndata: hello\n\n");
  });
  it("includes event and retry when present, and splits multi-line data", () => {
    expect(serializeSseFrame({ id: "2-0", data: "a\nb", event: "delta", retry: 1500 })).toBe(
      "event: delta\nid: 2-0\nretry: 1500\ndata: a\ndata: b\n\n",
    );
  });
  it("assertSseSafeId throws on NUL / LF / CR", () => {
    expect(() => assertSseSafeId("ok-1")).not.toThrow();
    expect(() => assertSseSafeId(`bad${String.fromCharCode(10)}id`)).toThrow();
    expect(() => assertSseSafeId(`bad${String.fromCharCode(0)}id`)).toThrow();
    expect(() => assertSseSafeId(`bad${String.fromCharCode(13)}id`)).toThrow();
  });

  it("INJECTION-SAFE: rejects a CR/LF/NUL in the event field (no forged fields)", () => {
    const lf = String.fromCharCode(10);
    const cr = String.fromCharCode(13);
    expect(() => serializeSseFrame({ id: "1-0", data: "x", event: `delta${lf}id: forged` })).toThrow();
    expect(() => serializeSseFrame({ id: "1-0", data: "x", event: `delta${cr}data: forged` })).toThrow();
    expect(() => serializeSseFrame({ id: "1-0", data: "x", event: `delta${String.fromCharCode(0)}` })).toThrow();
  });

  it("INJECTION-SAFE: a bare CR in data is a data-line split, not a forged field", () => {
    const cr = String.fromCharCode(13);
    // A handler that puts `\rid: forged` in data must NOT inject an `id:` field —
    // the CR is normalized to a data-line boundary.
    const out = serializeSseFrame({ id: "1-0", data: `a${cr}id: forged` });
    expect(out).toBe("id: 1-0\ndata: a\ndata: id: forged\n\n");
    // CRLF collapses to a single split (no empty data line from the LF).
    const crlf = serializeSseFrame({ id: "2-0", data: `a${cr}${String.fromCharCode(10)}b` });
    expect(crlf).toBe("id: 2-0\ndata: a\ndata: b\n\n");
  });
});

describe("resumable sse context", () => {
  it("openSse drains the frame source into a serialized SSE stream", async () => {
    buffers.clear();
    const ctx = makeCtx();
    const stream = await ctx.openSse("conn-a", () =>
      frames([
        { id: "1-0", data: "one" },
        { id: "2-0", data: "two" },
      ]),
    );
    expect(stream).not.toBeNull();
    const text = await drainToString(stream!);
    expect(text).toBe("id: 1-0\ndata: one\n\nid: 2-0\ndata: two\n\n");
  });

  it("resumes from a character offset (skipCharacters) — a reconnect skips the seen prefix", async () => {
    buffers.clear();
    const ctx = makeCtx();
    const items: SseFrame[] = [
      { id: "1-0", data: "one" },
      { id: "2-0", data: "two" },
    ];
    // First connection buffers the full output.
    const first = await ctx.openSse("conn-b", () => frames(items));
    const fullText = await drainToString(first!);
    const firstFrameLen = serializeSseFrame(items[0]).length;

    // Reconnect skipping the first frame's characters — only the second frame remains.
    const resumed = await ctx.openSse("conn-b", () => frames(items), {
      skipCharacters: firstFrameLen,
    });
    const resumedText = await drainToString(resumed!);
    expect(resumedText).toBe(fullText.slice(firstFrameLen));
    expect(resumedText).toBe("id: 2-0\ndata: two\n\n");
  });
});

describe("sseResponse", () => {
  it("wraps a stream with SSE headers and 200", async () => {
    const stream = stringStreamFrom("id: 1-0\ndata: hi\n\n");
    const res = sseResponse(stream);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe(SSE_RESPONSE_HEADERS["Content-Type"]);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = await res.text();
    expect(body).toBe("id: 1-0\ndata: hi\n\n");
  });
  it("merges extra headers (e.g. CORS)", () => {
    const res = sseResponse(stringStreamFrom("x"), { "Access-Control-Allow-Origin": "https://a.example" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://a.example");
  });
  it("returns 204 when the resumable stream is already done (null)", () => {
    const res = sseResponse(null);
    expect(res.status).toBe(204);
  });
});
