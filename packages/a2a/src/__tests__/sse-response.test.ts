/**
 * toSseResponse tests.
 *
 * Verifies the AsyncGenerator<JSONRPCResponse> → Response SSE adapter:
 *   - emits `data: <json>\n\n` frames in order
 *   - sets text/event-stream + no-cache + keep-alive + X-Accel-Buffering headers
 *   - terminates the generator on abortSignal
 *   - emits `: keepalive\n\n` comments on idle
 *   - emits an error envelope frame if the generator throws
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import type { JSONRPCResponse } from "@a2a-js/sdk";

import { toSseResponse } from "../sse-response";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Build an async generator that yields the given chunks, awaiting an
 * optional per-chunk delay (in ms) before each yield. Honors caller
 * `return()` promptly — no chunks emitted after return.
 */
function makeGen(
  chunks: JSONRPCResponse[],
  opts: { delayMs?: number } = {},
): AsyncGenerator<JSONRPCResponse> {
  async function* gen(): AsyncGenerator<JSONRPCResponse> {
    for (const chunk of chunks) {
      if (opts.delayMs) {
        await new Promise((r) => setTimeout(r, opts.delayMs));
      }
      yield chunk;
    }
  }
  return gen();
}

function makeResponse(id: number | string): JSONRPCResponse {
  // Minimal JSONRPCResponse shape — `result` can be anything per the spec;
  // the adapter stringifies the whole envelope.
  return {
    jsonrpc: "2.0",
    id,
    result: { kind: "status-update", taskId: "t1", status: { state: "working" } },
  } as unknown as JSONRPCResponse;
}

async function readAll(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("toSseResponse", () => {
  it("emits one SSE data frame per yielded chunk, in order", async () => {
    const chunks = [makeResponse(1), makeResponse(2), makeResponse(3)];
    const response = toSseResponse(makeGen(chunks));
    const body = await readAll(response.body!.getReader());

    // Three frames, each ending with a blank line.
    const frames = body.split("\n\n").filter((f) => f.trim().length > 0);
    expect(frames).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(frames[i]).toBe(`data: ${JSON.stringify(chunks[i])}`);
    }
  });

  it("sets SSE + proxy-safe headers", () => {
    const response = toSseResponse(makeGen([]));
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("Connection")).toBe("keep-alive");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
  });

  it("terminates early when abortSignal fires mid-stream", async () => {
    const ac = new AbortController();
    let yielded = 0;

    async function* slowGen(): AsyncGenerator<JSONRPCResponse> {
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 10));
        yielded += 1;
        yield makeResponse(i);
      }
    }

    const response = toSseResponse(slowGen(), ac.signal);
    const reader = response.body!.getReader();

    // Read one frame then abort.
    const first = await reader.read();
    expect(first.done).toBe(false);

    ac.abort();

    // Drain remaining (should close quickly).
    await readAll(reader);

    // We should have yielded strictly fewer than 5 chunks.
    expect(yielded).toBeLessThan(5);
  });

  it("emits a keepalive comment on idle streams", async () => {
    vi.useFakeTimers();

    let resolveYield: ((v: JSONRPCResponse | null) => void) | null = null;
    async function* idleGen(): AsyncGenerator<JSONRPCResponse> {
      const p = new Promise<JSONRPCResponse | null>((resolve) => {
        resolveYield = resolve;
      });
      const chunk = await p;
      if (chunk) yield chunk;
    }

    const response = toSseResponse(idleGen());
    const reader = response.body!.getReader();

    // Advance fake timers past the keepalive interval (15s).
    await vi.advanceTimersByTimeAsync(15_000);

    // Read one chunk — must be the keepalive comment.
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const text = new TextDecoder().decode(value);
    expect(text).toBe(": keepalive\n\n");

    // Cleanup: resolve the generator and drain.
    (resolveYield as ((v: JSONRPCResponse | null) => void) | null)?.(null);
    vi.useRealTimers();
    await readAll(reader);
  });

  it("emits a JSON-RPC error envelope frame when the generator throws", async () => {
    async function* throwGen(): AsyncGenerator<JSONRPCResponse> {
      yield makeResponse(1);
      throw new Error("boom");
    }

    const response = toSseResponse(throwGen());
    const body = await readAll(response.body!.getReader());

    const frames = body.split("\n\n").filter((f) => f.trim().length > 0);
    // First frame is the real response; second frame is the error envelope.
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBe(`data: ${JSON.stringify(makeResponse(1))}`);
    expect(frames[1].startsWith("data: ")).toBe(true);

    const envelopeJson = frames[1].slice("data: ".length);
    const envelope = JSON.parse(envelopeJson);
    expect(envelope.jsonrpc).toBe("2.0");
    expect(envelope.error.code).toBe(-32603);
    expect(envelope.error.message).toBe("boom");
    expect(envelope.id).toBeNull();
  });

  it("emits a generic error envelope for non-Error thrown values", async () => {
    async function* throwGen(): AsyncGenerator<JSONRPCResponse> {
      throw "string failure";
    }

    const response = toSseResponse(throwGen());
    const body = await readAll(response.body!.getReader());

    const frames = body.split("\n\n").filter((f) => f.trim().length > 0);
    expect(frames).toHaveLength(1);
    const envelope = JSON.parse(frames[0].slice("data: ".length));
    expect(envelope.error.message).toBe("Internal error");
  });
});

// ---------------------------------------------------------------------------
// id-frame emission for Last-Event-ID resubscribe.
// Validates the extended signature `toSseResponse(gen, signal?, options?)`
// where `options.extractId?: (chunk) => string | undefined` controls whether
// each frame gets an SSE `id: <value>\n` prefix in addition to the `data:` line.
// ---------------------------------------------------------------------------
describe("toSseResponse — id: frame emission", () => {
  it("emits \"id: <stream-id>\\ndata: <json>\\n\\n\" when extractId option is provided", async () => {
    const chunks: JSONRPCResponse[] = [
      {
        jsonrpc: "2.0",
        id: 1,
        result: { metadata: { eventId: "1713186234567-0" } },
      } as unknown as JSONRPCResponse,
      {
        jsonrpc: "2.0",
        id: 2,
        result: { metadata: { eventId: "1713186234568-0" } },
      } as unknown as JSONRPCResponse,
    ];
    const response = toSseResponse(makeGen(chunks), undefined, {
      extractId: (c) =>
        (c as { result?: { metadata?: { eventId?: string } } }).result
          ?.metadata?.eventId,
    });
    const body = await readAll(response.body!.getReader());
    const frames = body.split("\n\n").filter((f) => f.trim().length > 0);
    expect(frames[0]).toBe(
      `id: 1713186234567-0\ndata: ${JSON.stringify(chunks[0])}`,
    );
    expect(frames[1]).toBe(
      `id: 1713186234568-0\ndata: ${JSON.stringify(chunks[1])}`,
    );
  });

  it("omits id: prefix when extractId is undefined (backwards compatible)", async () => {
    const chunks = [makeResponse(1)];
    const response = toSseResponse(makeGen(chunks)); // no options
    const body = await readAll(response.body!.getReader());
    expect(body).toContain(`data: ${JSON.stringify(chunks[0])}`);
    expect(body).not.toContain("id: ");
  });

  it("stream-id matches /^\\d+-\\d+$/ — valid SSE id with no forbidden chars", () => {
    const sample = "1713186234567-0";
    expect(sample).toMatch(/^\d+-\d+$/);
    expect(/[\u0000\u000A\u000D]/.test(sample)).toBe(false);
  });

  it("skips id: line when extractId returns a string containing a newline", async () => {
    const chunks = [makeResponse(1)];
    const response = toSseResponse(makeGen(chunks), undefined, {
      extractId: () => "bad\nid",
    });
    const body = await readAll(response.body!.getReader());
    // Forbidden-char guard: id: line MUST NOT be emitted; frame falls back
    // to data-only emission.
    expect(body).not.toContain("id: ");
    expect(body).toContain(`data: ${JSON.stringify(chunks[0])}`);
  });
});
