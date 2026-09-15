// THE EXTENSION HOST'S EGRESS SEAM — a ui-action handler that follows a
// redirect chain itself and releases each unread hop body.
//
// WHY THIS TEST EXISTS (measured, not supposed). A connector's "add" action
// hung forever inside the app runtime on an awaited booking-page fetch, while
// the identical hop chain in a plain Node process on the same host finished in
// well under a second and the app process carried no proxy overrides. The
// layer that wedges is the app runtime's own server fetch:
//
//   * Next.js replaces `globalThis.fetch` on the server with
//     `createDedupeFetch(fetch)` (next/dist/server/lib/dedupe-fetch), which
//     hands every dedupable GET response through `cloneResponse`
//     (next/dist/server/lib/clone-response). That calls `original.body.tee()`
//     and returns ONE branch to the caller while RETAINING the sibling branch
//     in its cache entry.
//   * Per the stream tee algorithm, cancelling one branch settles only once
//     BOTH branches are cancelled. The retained sibling is never cancelled, so
//     an AWAITED `response.body.cancel()` never returns — only a garbage
//     collection of the retained sibling can ever release it.
//   * Releasing an unread body is exactly what a hop-following fetch loop does
//     on every redirect, so the FIRST hop of a genuine short link wedges the
//     whole action. Nothing is logged and nothing is stored: the await simply
//     never returns.
//
// The seam is reproduced here with the runtime's OWN code (Next.js's real
// dedupe-fetch over a local 302 chain), never with a real upstream, and the
// action is driven through the real host dispatch.
//
// RED before the fix: the dispatch awaited the handler with no bound, so the
// completing spec below hangs until vitest's own test timeout kills it.
// GREEN after the fix: the host's extension-egress scope gives an unbounded
// extension fetch a bound, which is also the runtime's documented opt-out from
// the response-cloning dedupe path, so the release settles and the hops finish;
// and the dispatch's own bound guarantees a visible answer even when a handler
// wedges for some other reason.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDedupeFetch } from "next/dist/server/lib/dedupe-fetch";
import {
  dispatchExtensionUiAction,
  type DispatchExtensionUiActionDeps,
} from "@/lib/extension-action-dispatch";
import type { ExtensionUiAction } from "@/lib/extension-ui-registry";

const PAGE_HTML =
  "<!doctype html><html><head><title>Booking page</title></head><body>ok</body></html>";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/short") {
      res.writeHead(302, { location: "/mid" });
      res.end("redirecting");
      return;
    }
    if (req.url === "/mid") {
      res.writeHead(302, { location: "/page" });
      res.end("redirecting");
      return;
    }
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE_HTML);
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Put the app runtime's OWN server fetch in place: Next.js's real
 * `createDedupeFetch`, which tees every dedupable GET response and retains the
 * sibling branch. This is the exact wrapper the server installs over
 * `globalThis.fetch` for every route handler and server component.
 */
function installRuntimeServerFetch() {
  vi.stubGlobal("fetch", createDedupeFetch(globalThis.fetch) as unknown as typeof fetch);
}

/**
 * The shape a hop-following connector uses: vet-then-request each hop with
 * redirects unfollowed, and release each redirect's unread body before moving
 * on. The release is AWAITED, which is what a body release looks like in a
 * connector written against the fetch standard.
 */
async function followHopsReleasingBodies(startUrl: string): Promise<string> {
  let current = startUrl;
  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await fetch(current, {
      headers: { "User-Agent": "Cinatra/1.0" },
      cache: "no-store",
      redirect: "manual",
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Unable to load the page (${response.status}).`);
      if (response.body && !response.bodyUsed) await response.body.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      if (response.body && !response.bodyUsed) await response.body.cancel();
      throw new Error(`Unable to load the page (${response.status}).`);
    }
    return await response.text();
  }
  throw new Error("too many redirects");
}

/**
 * The same hop-following shape, but built as `fetch(new Request(url, init))` —
 * what an HTTP client library does. The runtime's dedupe opt-out reads
 * `options.signal` ONLY, so a Request-input GET is still deduped and teed: this
 * is the same wedge reached by a different door.
 */
async function followHopsWithRequestObjects(startUrl: string): Promise<string> {
  let current = startUrl;
  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await fetch(
      new Request(current, {
        headers: { "User-Agent": "Cinatra/1.0" },
        cache: "no-store",
        redirect: "manual",
      }),
    );
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Unable to load the page (${response.status}).`);
      if (response.body && !response.bodyUsed) await response.body.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    if (!response.ok) {
      if (response.body && !response.bodyUsed) await response.body.cancel();
      throw new Error(`Unable to load the page (${response.status}).`);
    }
    return await response.text();
  }
  throw new Error("too many redirects");
}

const ACTOR = { principalId: "u-1" };
const LIVE = { packageName: "@cinatra-ai/demo", status: "active" };

function makeDeps(
  handler: (input: unknown) => Promise<unknown>,
  over: Partial<DispatchExtensionUiActionDeps> = {},
): DispatchExtensionUiActionDeps {
  const action: ExtensionUiAction = {
    packageName: "@cinatra-ai/demo",
    id: "addSchedule",
    handler,
  };
  return {
    resolveInstall: vi.fn().mockResolvedValue(LIVE),
    authorize: vi.fn().mockResolvedValue(true),
    resolveAction: vi.fn().mockReturnValue(action),
    ...over,
  };
}

describe("extension ui-action egress over a redirecting upstream", () => {
  it("the runtime's server fetch is what wedges an awaited body release (the measured mechanism)", async () => {
    installRuntimeServerFetch();
    const response = await fetch(`${base}/short`, { redirect: "manual" });
    expect(response.status).toBe(302);
    const settled = await Promise.race([
      response.body!.cancel().then(() => "released"),
      new Promise((resolve) => setTimeout(() => resolve("never-settles"), 1000)),
    ]);
    expect(settled).toBe("never-settles");
  });

  it("a ui-action that follows hops and releases each body COMPLETES through the host dispatch", async () => {
    installRuntimeServerFetch();
    const result = await dispatchExtensionUiAction(
      { installId: "i", actionId: "addSchedule", input: {}, actor: ACTOR },
      makeDeps(async () => ({ html: await followHopsReleasingBodies(`${base}/short`) })),
    );
    expect(result.status).toBe(200);
    expect((result.result as { html: string }).html).toContain("Booking page");
  }, 15_000);

  it("a handler that never settles is given up on with a person-readable answer, not an endless await", async () => {
    const result = await dispatchExtensionUiAction(
      { installId: "i", actionId: "addSchedule", input: {}, actor: ACTOR },
      makeDeps(() => new Promise(() => {}), { timeoutMs: 60 }),
    );
    expect(result.status).toBe(504);
    expect(result.error).toContain("addSchedule");
    expect(result.error).toContain("did not respond");
  });

  it("a bound the extension sets itself is left alone (the egress scope never overrides it)", async () => {
    installRuntimeServerFetch();
    const controller = new AbortController();
    const result = await dispatchExtensionUiAction(
      { installId: "i", actionId: "addSchedule", input: {}, actor: ACTOR },
      makeDeps(async () => {
        controller.abort();
        try {
          await fetch(`${base}/page`, { signal: controller.signal });
          return { aborted: false };
        } catch {
          return { aborted: true };
        }
      }),
    );
    expect(result).toEqual({ status: 200, result: { aborted: true } });
  });
  it("a handler that fetches with a Request OBJECT completes too (the same wedge, a different door)", async () => {
    installRuntimeServerFetch();
    const result = await dispatchExtensionUiAction(
      { installId: "i", actionId: "addSchedule", input: {}, actor: ACTOR },
      makeDeps(async () => ({ html: await followHopsWithRequestObjects(`${base}/short`) })),
    );
    expect(result.status).toBe(200);
    expect((result.result as { html: string }).html).toContain("Booking page");
  }, 15_000);

  it("a Request the caller already wired an abort to keeps aborting (the bound is composed, not substituted)", async () => {
    installRuntimeServerFetch();
    const controller = new AbortController();
    const result = await dispatchExtensionUiAction(
      { installId: "i", actionId: "addSchedule", input: {}, actor: ACTOR },
      makeDeps(async () => {
        controller.abort();
        try {
          await fetch(new Request(`${base}/page`, { signal: controller.signal }));
          return { aborted: false };
        } catch {
          return { aborted: true };
        }
      }),
    );
    expect(result).toEqual({ status: 200, result: { aborted: true } });
  });

  it("re-installs OUTERMOST when the runtime patches over the wrapper again", async () => {
    // First action installs the wrapper over the runtime's fetch.
    installRuntimeServerFetch();
    const first = await dispatchExtensionUiAction(
      { installId: "i", actionId: "addSchedule", input: {}, actor: ACTOR },
      makeDeps(async () => ({ html: await followHopsReleasingBodies(`${base}/short`) })),
    );
    expect(first.status).toBe(200);
    // Now the runtime patches its dedupe wrapper OVER ours, exactly as a fresh
    // serve would: our wrapper is buried inside, where an injected bound no
    // longer reaches the dedupe path. The next scope must notice (the symbol is
    // no longer on the current global) and wrap the new outermost fetch.
    globalThis.fetch = createDedupeFetch(globalThis.fetch) as unknown as typeof fetch;
    const second = await dispatchExtensionUiAction(
      { installId: "i", actionId: "addSchedule", input: {}, actor: ACTOR },
      makeDeps(async () => ({ html: await followHopsReleasingBodies(`${base}/short`) })),
    );
    expect(second.status).toBe(200);
    expect((second.result as { html: string }).html).toContain("Booking page");
  }, 15_000);
});
