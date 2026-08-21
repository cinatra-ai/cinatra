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
  saveChatThreadInOrder,
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

  it("saveChatThreadViaFetch REJECTS on a non-OK response", async () => {
    // cinatra#2823 S9j round 5. It used to resolve on any response at all, so
    // "the save landed" and "the server rejected it" were the same value. The
    // truncation intent is the one save whose success the edit path has to be
    // able to wait on, and it cannot wait on a promise that always resolves.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(saveChatThreadViaFetch({ id: "t1", title: "T" })).rejects.toThrow(/500/);
  });
});

/**
 * cinatra#2823 S9j — the per-thread SAVE CHAIN.
 *
 * Every /chat save posts the WHOLE transcript and the server reconciles it by
 * DELETING the mirror rows the payload no longer carries. Exactly one save also
 * carries an explicit truncation intent (`removedMessageIds`), and the server
 * reads the removed turns' identity out of the very rows that DELETE removes.
 * Two concurrent `fetch`es have no order, so "issued first" did not mean
 * "committed first" and the silent save could destroy the evidence the intent
 * needs. These arms drive the ordering for real — the fetch is held open by hand,
 * so there is no sleep and no scheduling luck in any of them.
 */
describe("saveChatThreadInOrder", () => {
  /** A fetch stub whose responses are released by hand, in the order asked for. */
  function heldFetch() {
    const issued: string[] = [];
    const release: Array<(res: Response) => void> = [];
    const fetchStub = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: string; title?: string };
      issued.push(`${body.id}:${body.title ?? ""}`);
      return new Promise<Response>((resolve) => release.push(resolve));
    });
    vi.stubGlobal("fetch", fetchStub);
    return {
      issued,
      /** Settle the Nth issued request; `ok: false` makes it a server rejection. */
      settle(index: number, ok = true) {
        release[index](ok ? new Response("{}") : new Response("no", { status: 503 }));
      },
      /** Let every pending microtask run, so anything unblocked is issued. */
      async drain() {
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      },
    };
  }

  it("does not POST a thread's next save until the previous one has settled", async () => {
    const net = heldFetch();
    const first = saveChatThreadInOrder({ id: "t1", title: "intent" });
    const second = saveChatThreadInOrder({ id: "t1", title: "ordinary" });
    await net.drain();
    // THE POINT: the second save exists, and it is not on the wire. Without the
    // chain both fetches are in flight here and the server decides the order.
    expect(net.issued).toEqual(["t1:intent"]);

    net.settle(0);
    await first;
    await net.drain();
    expect(net.issued).toEqual(["t1:intent", "t1:ordinary"]);
    net.settle(1);
    await second;
  });

  it("retries INSIDE its slot — a save issued later cannot land between the attempts", async () => {
    // A re-enqueued retry would go behind the save that was issued after it,
    // which for the truncation intent is the losing position all over again.
    const net = heldFetch();
    const intent = saveChatThreadInOrder({ id: "t1", title: "intent" }, { attempts: 2 });
    const ordinary = saveChatThreadInOrder({ id: "t1", title: "ordinary" });
    await net.drain();
    expect(net.issued).toEqual(["t1:intent"]);

    net.settle(0, false); // the first attempt is rejected by the server
    await net.drain();
    expect(net.issued).toEqual(["t1:intent", "t1:intent"]);

    net.settle(1);
    await intent;
    await net.drain();
    expect(net.issued).toEqual(["t1:intent", "t1:intent", "t1:ordinary"]);
    net.settle(2);
    await ordinary;
  });

  it("rejects when every attempt fails, and does not poison the thread's later saves", async () => {
    const net = heldFetch();
    const intent = saveChatThreadInOrder({ id: "t1", title: "intent" }, { attempts: 2 });
    const ordinary = saveChatThreadInOrder({ id: "t1", title: "ordinary" });
    await net.drain();
    net.settle(0, false);
    await net.drain();
    net.settle(1, false);
    await expect(intent).rejects.toThrow(/503/);
    await net.drain();
    // The chain carried on: one failed save is not a dead thread.
    expect(net.issued).toEqual(["t1:intent", "t1:intent", "t1:ordinary"]);
    net.settle(2);
    await ordinary;
  });

  it("chains PER THREAD — two threads share no reconcile and are not serialised", async () => {
    const net = heldFetch();
    const a = saveChatThreadInOrder({ id: "t1", title: "a" });
    const b = saveChatThreadInOrder({ id: "t2", title: "b" });
    await net.drain();
    expect(net.issued).toEqual(["t1:a", "t2:b"]);
    net.settle(0);
    net.settle(1);
    await Promise.all([a, b]);
  });
});
