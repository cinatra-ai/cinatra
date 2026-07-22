// S5 (cinatra#1221) Lane B §9.1 — the ADDITIVE embed seams on streamAssistantTurn.
// Proves: default path is byte-unchanged (credentials:"include", no assistant in
// body, no broker headers); the token-broker path applies the broker headers +
// assistant to the turn POST and uses credentials:"omit" (§B11 — no ambient
// cookie fallback) on BOTH the turn and the resume GET.
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAssistantTurn } from "../ag-ui-chat-client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** An empty, immediately-closing SSE body: streamAssistantTurn folds nothing,
 *  finds no runId, and resolves — enough to capture the request init. */
function emptyOkResponse(): Response {
  return new Response("", { status: 200 });
}

async function drive(opts: Partial<Parameters<typeof streamAssistantTurn>[0]> = {}) {
  const fetchMock = vi.fn(async () => emptyOkResponse());
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  await streamAssistantTurn({
    threadId: "th1",
    messages: [{ role: "user", content: "hi" }],
    signal: new AbortController().signal,
    onState: () => {},
    ...opts,
  });
  return fetchMock;
}

describe("streamAssistantTurn — §9.1 default path is byte-unchanged", () => {
  it("uses credentials:'include', sends no assistant and no broker headers", async () => {
    const fetchMock = await drive();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe("include");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["X-Cinatra-Widget-User-Token"]).toBeUndefined();
    expect(JSON.parse(init.body as string)).not.toHaveProperty("assistant");
  });
});

describe("streamAssistantTurn — §9.1 token-broker embed seams", () => {
  it("applies the broker headers + assistant + credentials:'omit' to the turn POST", async () => {
    const fetchMock = await drive({
      assistant: "wordpress",
      authHeaders: () => ({
        Authorization: "Bearer cit_x",
        "X-Cinatra-Widget-User-Token": "cwu_y",
      }),
      credentialsMode: "omit",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe("omit");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cit_x");
    expect(headers["X-Cinatra-Widget-User-Token"]).toBe("cwu_y");
    expect(JSON.parse(init.body as string).assistant).toBe("wordpress");
  });

  it("§9.3(A): the resume GET carries ONLY the DISTINCT run-bound token — NEVER the turn cit_/cwu_ pair", async () => {
    // POST returns RUN_STARTED then closes clean (no terminal) → one resume GET.
    const started = { type: "RUN_STARTED", threadId: "th1", runId: "r1" };
    const postBody = `id: 1-0\ndata: ${JSON.stringify(started)}\n\n`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(postBody, { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await streamAssistantTurn({
      threadId: "th1",
      messages: [],
      signal: new AbortController().signal,
      onState: () => {},
      authHeaders: () => ({ Authorization: "Bearer cit_x", "X-Cinatra-Widget-User-Token": "cwu_y" }),
      resumeAuthHeaders: () => ({ Authorization: "Bearer rt_run_bound" }),
      credentialsMode: "omit",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, resumeInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(resumeInit.credentials).toBe("omit"); // §B11 — no ambient-cookie fallback
    const rh = resumeInit.headers as Record<string, string>;
    expect(rh.Authorization).toBe("Bearer rt_run_bound"); // the run-bound audience
    expect(rh["X-Cinatra-Widget-User-Token"]).toBeUndefined(); // NEVER the cwu_ pair
  });

  it("§9.3(A): with NO resumeAuthHeaders the resume GET carries no broker auth (degrade-to-fresh-mount)", async () => {
    const started = { type: "RUN_STARTED", threadId: "th1", runId: "r1" };
    const postBody = `id: 1-0\ndata: ${JSON.stringify(started)}\n\n`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(postBody, { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await streamAssistantTurn({
      threadId: "th1",
      messages: [],
      signal: new AbortController().signal,
      onState: () => {},
      authHeaders: () => ({ Authorization: "Bearer cit_x", "X-Cinatra-Widget-User-Token": "cwu_y" }),
      credentialsMode: "omit",
    });
    const [, resumeInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    // The turn's cit_/cwu_ pair must NOT leak onto the resume audience.
    expect((resumeInit.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((resumeInit.headers as Record<string, string>)["X-Cinatra-Widget-User-Token"]).toBeUndefined();
  });
});
