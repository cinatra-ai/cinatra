// Thread persistence seam (cinatra#918 — split out of chat-page.tsx).
// Pins the thread-model helpers and the fetch wrappers' fallback behavior.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_STORED_THREADS,
  deriveThreadTitle,
  extractAgentName,
  fetchThreadList,
  fetchThreadById,
  saveChatThreadViaFetch,
} from "../ag-ui-chat-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deriveThreadTitle", () => {
  it("collapses newlines and ellipsizes past 60 chars", () => {
    expect(deriveThreadTitle("hello\nworld")).toBe("hello world");
    const long = "x".repeat(70);
    expect(deriveThreadTitle(long)).toBe(`${"x".repeat(57)}...`);
    expect(deriveThreadTitle(`  ${"y".repeat(60)}  `)).toBe("y".repeat(60));
  });
});

describe("extractAgentName", () => {
  it("extracts the declared agent name", () => {
    expect(extractAgentName("The agent's name is: Prospector")).toBe("Prospector");
    expect(extractAgentName("the agents name is Lead Finder. It does X")).toBe("Lead Finder");
    expect(extractAgentName("no declaration here")).toBeNull();
    expect(extractAgentName("The agent's name is:  ")).toBeNull();
  });
});

describe("fetch wrappers", () => {
  it("fetchThreadList caps at MAX_STORED_THREADS and swallows failures", async () => {
    const many = Array.from({ length: MAX_STORED_THREADS + 5 }, (_, i) => ({
      id: `t${i}`, title: `T${i}`, createdAt: "2026-01-01", updatedAt: "2026-01-02",
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(many))));
    expect((await fetchThreadList())).toHaveLength(MAX_STORED_THREADS);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net down"); }));
    expect(await fetchThreadList()).toEqual([]);

    // Non-OK responses come back as an empty list too.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    expect(await fetchThreadList()).toEqual([]);
  });

  it("fetchThreadById returns null on non-OK and on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    expect(await fetchThreadById("t1")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net down"); }));
    expect(await fetchThreadById("t1")).toBeNull();
  });

  it("saveChatThreadViaFetch POSTs the thread JSON to /api/assistants/threads", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}");
    }));
    await saveChatThreadViaFetch({ id: "t1", title: "T" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/assistants/threads");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ id: "t1", title: "T" });
  });
});
