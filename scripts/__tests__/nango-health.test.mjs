// Unit coverage for the shared Nango health-probe helper
// (scripts/lib/nango-health.mjs) used by the `pnpm dev` preflight
// (scripts/dev-server.mjs) and the `pnpm check:services` reporter
// (scripts/check-services.mjs). Pure-logic assertions plus a throwaway loopback
// HTTP server — no Docker, no Nango, no network egress. Auto-discovered by the
// root vitest suite via the `scripts/__tests__/**` include glob.

import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import {
  DEFAULT_NANGO_URL,
  resolveNangoBaseUrl,
  nangoHealthUrl,
  isLocalNangoUrl,
  probeHttpHealth,
} from "../lib/nango-health.mjs";

describe("resolveNangoBaseUrl", () => {
  it("trims a set value and falls back to the local default", () => {
    expect(resolveNangoBaseUrl("  http://localhost:3003  ")).toBe(
      "http://localhost:3003",
    );
    expect(resolveNangoBaseUrl(undefined)).toBe(DEFAULT_NANGO_URL);
    expect(resolveNangoBaseUrl("")).toBe(DEFAULT_NANGO_URL);
    expect(resolveNangoBaseUrl("   ")).toBe(DEFAULT_NANGO_URL);
  });
});

describe("nangoHealthUrl", () => {
  it("defaults to the local server /health when no URL is set", () => {
    expect(nangoHealthUrl(undefined)).toBe(`${DEFAULT_NANGO_URL}/health`);
    expect(nangoHealthUrl("")).toBe(`${DEFAULT_NANGO_URL}/health`);
  });
  it("appends /health and collapses any trailing slash", () => {
    expect(nangoHealthUrl("http://localhost:3003")).toBe(
      "http://localhost:3003/health",
    );
    expect(nangoHealthUrl("http://localhost:3003/")).toBe(
      "http://localhost:3003/health",
    );
    expect(nangoHealthUrl("https://nango.example.com//")).toBe(
      "https://nango.example.com/health",
    );
  });
});

describe("isLocalNangoUrl", () => {
  it("treats loopback hosts (and the default) as local → heal-eligible", () => {
    expect(isLocalNangoUrl(undefined)).toBe(true); // default is 127.0.0.1
    expect(isLocalNangoUrl("http://127.0.0.1:3003")).toBe(true);
    expect(isLocalNangoUrl("http://localhost:3003")).toBe(true);
  });
  it("treats a remote/hosted Nango as NOT local → never auto-healed", () => {
    expect(isLocalNangoUrl("https://nango.example.com")).toBe(false);
    expect(isLocalNangoUrl("http://10.0.0.5:3003")).toBe(false);
  });
  it("is false for an unparseable URL", () => {
    expect(isLocalNangoUrl("not a url")).toBe(false);
  });
});

describe("probeHttpHealth", () => {
  /** @type {import("node:http").Server | undefined} */
  let server;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = undefined;
  });

  /** Start a loopback server with `handler`; resolve its ephemeral port. */
  function listen(handler) {
    return new Promise((resolve) => {
      server = http.createServer(handler);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
  }

  it("returns ok for a 2xx /health", async () => {
    const port = await listen((_req, res) => {
      res.statusCode = 200;
      res.end("OK");
    });
    expect(await probeHttpHealth(`http://127.0.0.1:${port}/health`)).toEqual({
      ok: true,
      status: 200,
    });
  });

  it("returns not-ok (with status) for a 5xx", async () => {
    const port = await listen((_req, res) => {
      res.statusCode = 503;
      res.end("nope");
    });
    const r = await probeHttpHealth(`http://127.0.0.1:${port}/health`);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(503);
  });

  it("returns not-ok when nothing is listening (connection refused)", async () => {
    // Bind to grab a port, then close it so the address is free, then probe.
    const port = await listen((_req, res) => res.end());
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
    expect((await probeHttpHealth(`http://127.0.0.1:${port}/health`, 1000)).ok).toBe(
      false,
    );
  });

  it("returns not-ok on timeout (server never responds)", async () => {
    const port = await listen(() => {
      /* hang — never write a response */
    });
    expect(
      (await probeHttpHealth(`http://127.0.0.1:${port}/health`, 200)).ok,
    ).toBe(false);
  });
});
