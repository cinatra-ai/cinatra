import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAuthSessionMock = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSessionMock(),
}));

// service.ts and realtime.ts share the ONE @cinatra-ai/notifications/server
// barrel. Tests that mock both underlying module paths with separate vi.mock calls
// would clobber each other. This test uses EXACTLY ONE
// `vi.mock("@cinatra-ai/notifications/server", ...)` using importOriginal()
// so the real in-process EventEmitter realtime behavior (subscribe /
// __emitForTest / __disposeForTest) is preserved while only
// `listNotificationsForUser` is overridden.
const listForUserMock = vi.fn();
vi.mock("@cinatra-ai/notifications/server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@cinatra-ai/notifications/server")>();
  return {
    ...actual,
    listNotificationsForUser: (userId: string) => listForUserMock(userId),
  };
});

import { GET } from "../stream/route";
import {
  __disposeForTest,
  __emitForTest,
  setNotificationsHostAdapters,
} from "@cinatra-ai/notifications/server";

beforeEach(async () => {
  getAuthSessionMock.mockReset();
  listForUserMock.mockReset();
  // The real realtime impl is in play (importOriginal). Register a host
  // adapter so connectListener()'s `getNotificationsHostAdapters()` resolves
  // (the test never actually opens pg — it drives __emitForTest directly;
  // connectListener is fire-and-forget and its failure is caught).
  setNotificationsHostAdapters({
    getPostgresConnectionString: () => "postgres://stub",
    ensurePostgresSchema: vi.fn(),
    postgresSchema: "cinatra",
    runPostgresQueriesSync: () => [{ rows: [] }],
    getAuthSession: async () => null,
    buildActorContext: async () => {
      throw new Error("not used in stream.test.ts");
    },
  });
  await __disposeForTest();
});

afterEach(async () => {
  vi.resetAllMocks();
  await __disposeForTest();
});

function makeRequest(): { request: Request; abort: () => void } {
  const controller = new AbortController();
  const request = new Request("http://test/api/notifications/stream", {
    method: "GET",
    signal: controller.signal,
  });
  return { request, abort: () => controller.abort() };
}

async function readChunks(
  body: ReadableStream<Uint8Array>,
  maxMs = 200,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const tick = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 25),
      ),
    ]);
    if (tick.done) break;
    if (tick.value) out += decoder.decode(tick.value);
  }
  try {
    reader.releaseLock();
  } catch {
    // already released
  }
  return out;
}

describe("GET /api/notifications/stream", () => {
  it("returns 401 without a session", async () => {
    getAuthSessionMock.mockResolvedValue(null);
    const { request } = makeRequest();
    const res = await GET(request);
    expect(res.status).toBe(401);
  });

  it("returns a text/event-stream with the ready event when authenticated", async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: "u-1" } });
    const { request, abort } = makeRequest();
    const res = await GET(request);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const body = res.body!;
    const out = await readChunks(body, 100);
    expect(out).toContain("event: ready");
    abort();
  });

  it("pushes notification events scoped to the session's userId only", async () => {
    getAuthSessionMock.mockResolvedValue({ user: { id: "u-1" } });
    listForUserMock.mockReturnValue([
      {
        id: "n-1",
        userId: "u-1",
        kind: "success",
        title: "Hello",
        body: "world",
        createdAt: "2026-01-01T00:00:00Z",
        topic: "user:u-1",
        recipientKind: "user",
      },
    ]);
    const { request, abort } = makeRequest();
    const res = await GET(request);
    const body = res.body!;
    const reader = body.getReader();
    const decoder = new TextDecoder();

    // Drive the in-process emitter directly — no Postgres involved.
    __emitForTest("u-1", { id: "n-1" });
    // Also drive a foreign-user event that must NOT be pushed to this stream.
    __emitForTest("u-9999", { id: "n-foreign" });

    let collected = "";
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      const tick = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 25),
        ),
      ]);
      if (tick.done) break;
      if (tick.value) collected += decoder.decode(tick.value);
      if (collected.includes('"id":"n-1"')) break;
    }
    expect(collected).toContain("event: notification");
    expect(collected).toContain('"id":"n-1"');
    expect(collected).not.toContain("n-foreign");
    expect(listForUserMock).toHaveBeenCalledWith("u-1");
    abort();
  });
});
