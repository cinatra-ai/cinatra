import { describe, it, expect, vi, beforeEach } from "vitest";

import type { SseFrame } from "@cinatra-ai/streams";

// The route delegates to the host stream registry; we mock it so the test
// exercises the route's resolve → build → SSE-serialize logic without a real
// connector or live Redis. This is the host wiring test (cinatra#344 Task 15):
// proves the generic /api/streams/<slug> route 404s an undeclared slug (the
// INERT day-one verdict) and serializes a declared handler's frames onto the
// SSE wire.

const resolveStream = vi.fn();
const buildStreamHandler = vi.fn();
// The absent-error class must exist at vi.mock hoist time, so create it via
// vi.hoisted and read the same reference back below.
const { FakeAbsentError } = vi.hoisted(() => ({
  FakeAbsentError: class FakeAbsentError extends Error {},
}));
vi.mock("@/lib/stream-registry.server", () => ({
  resolveStream: (...a: unknown[]) => resolveStream(...a),
  buildStreamHandler: (...a: unknown[]) => buildStreamHandler(...a),
}));
vi.mock("@/lib/extension-load-guard", () => ({
  ExtensionModuleAbsentError: FakeAbsentError,
}));

import { GET } from "../route";

const params = (slug: string) => ({ params: Promise.resolve({ streamSlug: slug }) });

function req(slug: string): Request {
  return new Request(`http://localhost/api/streams/${slug}`);
}

const ENTRY = {
  resolution: "required" as const,
  load: async () => ({}),
  packageName: "@x/p",
  factory: "createStream",
  streamSlug: "x-stream",
  label: "X Stream",
};

async function readSse(res: Response): Promise<string> {
  return res.text();
}

beforeEach(() => {
  resolveStream.mockReset();
  buildStreamHandler.mockReset();
});

describe("generic stream route GET /api/streams/<slug>", () => {
  it("404s an undeclared slug (the INERT day-one verdict — empty registry)", async () => {
    resolveStream.mockReturnValue(null);
    const res = await GET(req("nope"), params("nope"));
    expect(res.status).toBe(404);
    expect(resolveStream).toHaveBeenCalledWith("nope");
    expect(buildStreamHandler).not.toHaveBeenCalled();
  });

  it("serializes a declared handler's frames onto the SSE wire", async () => {
    resolveStream.mockReturnValue(ENTRY);
    const frames: SseFrame[] = [
      { id: "1-0", data: "hello" },
      { id: "2-0", data: "world", event: "delta" },
    ];
    buildStreamHandler.mockResolvedValue(async () => {
      return (async function* () {
        for (const f of frames) yield f;
      })();
    });

    const res = await GET(req("x-stream"), params("x-stream"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await readSse(res);
    expect(body).toBe("id: 1-0\ndata: hello\n\nevent: delta\nid: 2-0\ndata: world\n\n");
  });

  it("passes a unique streamId (slug-prefixed) to the handler", async () => {
    resolveStream.mockReturnValue(ENTRY);
    let seenStreamId = "";
    buildStreamHandler.mockResolvedValue(async (ctx: { streamId: string }) => {
      seenStreamId = ctx.streamId;
      return (async function* () {
        /* no frames */
      })();
    });
    const res = await GET(req("x-stream"), params("x-stream"));
    expect(res.status).toBe(200);
    await res.text();
    expect(seenStreamId.startsWith("x-stream:")).toBe(true);
  });

  it("returns 503 when the stream module is absent post-build", async () => {
    resolveStream.mockReturnValue(ENTRY);
    buildStreamHandler.mockRejectedValue(new FakeAbsentError("absent"));
    const res = await GET(req("x-stream"), params("x-stream"));
    expect(res.status).toBe(503);
  });
});
