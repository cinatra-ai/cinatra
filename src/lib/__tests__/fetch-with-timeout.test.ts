import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_FETCH_TIMEOUT_MS,
  FetchTimeoutError,
  fetchWithTimeout,
} from "../fetch-with-timeout";

// Exercise the helper against a REAL loopback server so the timeout / abort
// behavior reflects the runtime's actual fetch (undici) semantics rather than a
// mock's approximation of them.
let server: http.Server;
let baseUrl: string;
const openSockets = new Set<Socket>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case "/ok":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      case "/slow-body":
        // Headers + a partial chunk arrive immediately, then the body never
        // completes — the classic slow-trickle upstream.
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"partial":');
        return;
      case "/hang":
      default:
        // Accept the connection but never respond.
        return;
    }
  });
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  // Hung requests keep server-side sockets open; destroy them so close() settles.
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function capture(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected the promise to reject, but it resolved");
  } catch (err) {
    return err;
  }
}

describe("fetchWithTimeout", () => {
  it("returns the response unchanged for a fast request", async () => {
    const response = await fetchWithTimeout(`${baseUrl}/ok`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("exposes a generous but bounded default timeout", () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  it("rejects with FetchTimeoutError when the remote hangs past the timeout", async () => {
    const started = Date.now();
    const err = await capture(
      fetchWithTimeout(`${baseUrl}/hang`, {}, { timeoutMs: 100 }),
    );
    expect(err).toBeInstanceOf(FetchTimeoutError);
    expect(err).toBeInstanceOf(Error);
    expect((err as FetchTimeoutError).timeoutMs).toBe(100);
    expect((err as FetchTimeoutError).url).toContain("/hang");
    // Bounded — nowhere near indefinite.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("still enforces the timeout when a caller signal is supplied but never aborts", async () => {
    const controller = new AbortController(); // never aborted
    const err = await capture(
      fetchWithTimeout(
        `${baseUrl}/hang`,
        { signal: controller.signal },
        { timeoutMs: 100 },
      ),
    );
    // The composite (caller ∨ timeout) must not swallow the timeout.
    expect(err).toBeInstanceOf(FetchTimeoutError);
  });

  it("propagates a caller abort unchanged (never re-mapped to a timeout)", async () => {
    const controller = new AbortController();
    // Large timeout so the CALLER abort is unambiguously the cause.
    const promise = fetchWithTimeout(
      `${baseUrl}/hang`,
      { signal: controller.signal },
      { timeoutMs: 5_000 },
    );
    setTimeout(() => controller.abort(), 30);
    const err = await capture(promise);
    expect(err).not.toBeInstanceOf(FetchTimeoutError);
    expect((err as { name?: string }).name).toBe("AbortError");
  });

  it("rejects with the caller abort when the signal is already aborted", async () => {
    const err = await capture(
      fetchWithTimeout(
        `${baseUrl}/hang`,
        { signal: AbortSignal.abort() },
        { timeoutMs: 5_000 },
      ),
    );
    expect(err).not.toBeInstanceOf(FetchTimeoutError);
    expect((err as { name?: string }).name).toBe("AbortError");
  });

  it("bounds a slow-trickle body read, not just the connect/headers phase", async () => {
    // Headers resolve quickly; the body never completes. Because the timeout
    // signal stays attached to the response, the body read must also be bounded
    // so `.text()` cannot hang forever (the external-mcp proxy vector).
    const response = await fetchWithTimeout(
      `${baseUrl}/slow-body`,
      {},
      { timeoutMs: 200 },
    );
    expect(response.status).toBe(200);
    const started = Date.now();
    const err = await capture(response.text());
    expect((err as { name?: string }).name).toMatch(/AbortError|TimeoutError/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
