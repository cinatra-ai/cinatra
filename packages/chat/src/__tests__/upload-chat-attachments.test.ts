import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadChatAttachments } from "../ag-ui-chat-client";

// cinatra#1890 — the chat upload client: sends the chat-thread header so the
// server captures conversation context into classifier signals, and SURFACES
// refusals (previously swallowed silently) with recourse.

const realFetch = globalThis.fetch;

function okRef(mime = "text/plain") {
  return {
    ok: true,
    ref: {
      artifactId: "a1",
      representationRevisionId: "v1",
      digest: "sha",
      mime,
      originKind: "upload",
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function file(name: string, type: string): File {
  return new File(["bytes"], name, { type });
}

describe("uploadChatAttachments — thread header", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function sentHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    return (init?.headers ?? {}) as Record<string, string>;
  }

  it("sends X-Artifact-Chat-Thread-Id when a threadId is supplied", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => jsonResponse(okRef(), 201),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { refs, refusals } = await uploadChatAttachments(
      [file("a.txt", "text/plain")],
      { threadId: "thread-xyz" },
    );
    expect(refusals).toHaveLength(0);
    expect(refs).toHaveLength(1);
    expect(sentHeaders(fetchMock)["X-Artifact-Chat-Thread-Id"]).toBe("thread-xyz");
    // The uploaded ref is enriched with the original File metadata.
    expect(refs[0].filename).toBe("a.txt");
  });

  it("omits the header when no threadId (back-compat invariant)", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => jsonResponse(okRef(), 201),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await uploadChatAttachments([file("a.txt", "text/plain")]);
    expect(sentHeaders(fetchMock)["X-Artifact-Chat-Thread-Id"]).toBeUndefined();
  });

  it("omits the header for an empty-string threadId", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => jsonResponse(okRef(), 201),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await uploadChatAttachments([file("a.txt", "text/plain")], { threadId: "" });
    expect(sentHeaders(fetchMock)["X-Artifact-Chat-Thread-Id"]).toBeUndefined();
  });
});

describe("uploadChatAttachments — refusal surfacing (no silent drop)", () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("surfaces a 415 refusal with the mime + marketplace deep link from the server", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(
        {
          ok: false,
          error: "no installed type accepts application/zip",
          mime: "application/zip",
          marketplaceHref: "/configuration/marketplace?accepts=application%2Fzip",
        },
        415,
      ),
    ) as unknown as typeof fetch;
    const { refs, refusals } = await uploadChatAttachments([
      file("bundle.zip", "application/zip"),
    ]);
    expect(refs).toHaveLength(0);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      filename: "bundle.zip",
      status: 415,
      mime: "application/zip",
      marketplaceHref: "/configuration/marketplace?accepts=application%2Fzip",
    });
    expect(refusals[0].message).toContain("bundle.zip");
  });

  it("surfaces a 415 WITHOUT a link when the server offers none (ambiguous refusal)", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ ok: false, error: "ambiguous", mime: "image/png" }, 415),
    ) as unknown as typeof fetch;
    const { refusals } = await uploadChatAttachments([file("x.png", "image/png")]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].marketplaceHref).toBeUndefined();
    expect(refusals[0].status).toBe(415);
  });

  it("surfaces a network error as a refusal (status 0) instead of dropping it", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { refs, refusals } = await uploadChatAttachments([
      file("a.txt", "text/plain"),
    ]);
    expect(refs).toHaveLength(0);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].status).toBe(0);
    expect(refusals[0].marketplaceHref).toBeUndefined();
  });

  it("mixes success + refusal across a multi-file selection", async () => {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      return n === 1
        ? jsonResponse(okRef(), 201)
        : jsonResponse(
            { ok: false, mime: "application/zip", marketplaceHref: "/configuration/marketplace?accepts=application%2Fzip" },
            415,
          );
    }) as unknown as typeof fetch;
    const { refs, refusals } = await uploadChatAttachments([
      file("ok.txt", "text/plain"),
      file("bad.zip", "application/zip"),
    ]);
    expect(refs).toHaveLength(1);
    expect(refusals).toHaveLength(1);
    expect(refusals[0].filename).toBe("bad.zip");
  });
});
