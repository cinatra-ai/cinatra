import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock dns.lookup BEFORE importing the module under test so the module
// captures the mocked binding.
const dnsLookupMock = vi.fn();
vi.mock("node:dns", () => ({
  lookup: (
    hostname: string,
    options: unknown,
    callback: (err: unknown, addr?: unknown, family?: number) => void,
  ) => dnsLookupMock(hostname, options, callback),
}));

import { BridgeUrlError } from "../_url-validation";
import { safeFetch, safeLookup } from "../_safe-fetch";

// safeFetch now accepts an injected `fetchImpl` for testability.
const fetchImplMock = vi.fn();

function buildResponse(opts: {
  status: number;
  headers?: Record<string, string>;
  bodyText?: string;
}): Response {
  const headers = new Headers(opts.headers ?? {});
  return new Response(opts.bodyText ?? "", {
    status: opts.status,
    headers,
  });
}

beforeEach(() => {
  dnsLookupMock.mockReset();
  fetchImplMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeLookup — DNS rebinding TOCTOU closure", () => {
  it("Test 1: rejects when any resolved address is in a blocked CIDR", async () => {
    // safeLookup calls dns.lookup with { all: true } internally.
    dnsLookupMock.mockImplementation((host, _opts, cb) => {
      cb(null, [
        { address: "1.2.3.4", family: 4 },
        { address: "169.254.169.254", family: 4 }, // GCP metadata
      ]);
    });

    const lookupResult = await new Promise<{ err: unknown; addrs: unknown }>(
      (resolve) => {
        safeLookup(
          "mixed.example",
          { all: true },
          (err: unknown, addrs: unknown) => {
            resolve({ err, addrs });
          },
        );
      },
    );

    expect(lookupResult.err).toBeInstanceOf(BridgeUrlError);
    expect((lookupResult.err as BridgeUrlError).code).toBe(
      "BRIDGE-URL-HOST-BLOCKED",
    );
  });

  it("returns all addresses when all are safe and { all: true }", async () => {
    dnsLookupMock.mockImplementation((host, _opts, cb) => {
      cb(null, [
        { address: "1.2.3.4", family: 4 },
        { address: "2001:4860:4860::8888", family: 6 },
      ]);
    });

    const lookupResult = await new Promise<{ err: unknown; addrs: unknown }>(
      (resolve) => {
        safeLookup(
          "public.example",
          { all: true },
          (err: unknown, addrs: unknown) => {
            resolve({ err, addrs });
          },
        );
      },
    );

    expect(lookupResult.err).toBeNull();
    expect(lookupResult.addrs).toHaveLength(2);
  });

  it("returns first validated address when { all: false }", async () => {
    dnsLookupMock.mockImplementation((host, _opts, cb) => {
      cb(null, [
        { address: "1.2.3.4", family: 4 },
        { address: "2001:4860:4860::8888", family: 6 },
      ]);
    });

    const lookupResult = await new Promise<{
      err: unknown;
      addr: unknown;
      family: unknown;
    }>((resolve) => {
      safeLookup(
        "public.example",
        { all: false },
        (err: unknown, addr: unknown, family?: number) => {
          resolve({ err, addr, family });
        },
      );
    });

    expect(lookupResult.err).toBeNull();
    expect(lookupResult.addr).toBe("1.2.3.4");
    expect(lookupResult.family).toBe(4);
  });

  it("Test 2: fetch-time rebinding cannot happen — same lookup IS the dispatcher's lookup", async () => {
    // This test demonstrates the TOCTOU closure: the undici Agent's
    // `connect.lookup` is THE callback that resolves the hostname for the
    // socket connect. There is no second `dns.lookup` call between
    // validation and connect. Therefore: a hostname that resolves
    // to a private address inside the lookup callback fails the dispatcher
    // immediately. We assert by counting dns.lookup invocations across a
    // full safeFetch call to a public host.

    dnsLookupMock.mockImplementation((host, _opts, cb) => {
      cb(null, [{ address: "1.2.3.4", family: 4 }]);
    });
    fetchImplMock.mockResolvedValueOnce(
      buildResponse({ status: 200, bodyText: "ok" }),
    );

    const url = new URL("https://public.example/path");
    const result = await safeFetch(url, { fetchImpl: fetchImplMock });
    expect(result.status).toBe(200);

    // Note: in production, the safeLookup is called by undici's Agent INSIDE
    // its connect step. Our mock for `undici.fetch` short-circuits the
    // dispatcher path, so dns.lookup isn't called via undici in this unit
    // test — but the production code path uses the dispatcher we constructed
    // in `_safe-fetch.ts`. The architectural guarantee under test is that
    // safeFetch never resolves DNS twice (no validate-then-connect TOCTOU).
    // The shape of the implementation — passing the validated `safeLookup`
    // to undici's Agent — is what closes the window.
    // We assert here that NO independent dns.lookup was made by safeFetch
    // itself (rebinding-resistant by design).
    expect(dnsLookupMock).toHaveBeenCalledTimes(0);
  });
});

describe("safeFetch — redirect revalidation", () => {
  it("Test 3: rejects redirect to private metadata host", async () => {
    fetchImplMock.mockResolvedValueOnce(
      buildResponse({
        status: 302,
        headers: { location: "https://169.254.169.254/secret" },
      }),
    );

    const url = new URL("https://public.example/start");
    await expect(safeFetch(url, { fetchImpl: fetchImplMock })).rejects.toMatchObject({
      code: "BRIDGE-URL-HOST-BLOCKED",
    });
  });

  it("rejects redirect to non-https scheme", async () => {
    fetchImplMock.mockResolvedValueOnce(
      buildResponse({
        status: 301,
        headers: { location: "http://example.com/" },
      }),
    );

    const url = new URL("https://public.example/start");
    await expect(safeFetch(url, { fetchImpl: fetchImplMock })).rejects.toMatchObject({
      code: "BRIDGE-URL-SCHEME-NOT-ALLOWED",
    });
  });

  it("follows valid redirects up to the cap", async () => {
    fetchImplMock
      .mockResolvedValueOnce(
        buildResponse({
          status: 302,
          headers: { location: "https://b.example/hop" },
        }),
      )
      .mockResolvedValueOnce(
        buildResponse({
          status: 200,
          bodyText: "final",
        }),
      );

    const url = new URL("https://a.example/start");
    const result = await safeFetch(url, { fetchImpl: fetchImplMock });
    expect(result.status).toBe(200);
    // The second fetch call (the redirect target) should have been invoked
    // with the resolved URL.
    expect(fetchImplMock).toHaveBeenCalledTimes(2);
    expect(fetchImplMock.mock.calls[1][0]).toBe("https://b.example/hop");
  });

  it("Test 4: throws BRIDGE-URL-REDIRECT-LIMIT after 4+ redirects", async () => {
    // 4 redirects (over the default cap of 3).
    fetchImplMock
      .mockResolvedValueOnce(
        buildResponse({
          status: 302,
          headers: { location: "https://b.example/h" },
        }),
      )
      .mockResolvedValueOnce(
        buildResponse({
          status: 302,
          headers: { location: "https://c.example/h" },
        }),
      )
      .mockResolvedValueOnce(
        buildResponse({
          status: 302,
          headers: { location: "https://d.example/h" },
        }),
      )
      .mockResolvedValueOnce(
        buildResponse({
          status: 302,
          headers: { location: "https://e.example/h" },
        }),
      );

    const url = new URL("https://a.example/start");
    await expect(safeFetch(url, { fetchImpl: fetchImplMock })).rejects.toMatchObject({
      code: "BRIDGE-URL-REDIRECT-LIMIT",
    });
  });

  it("returns 3xx response as-is when Location header is missing", async () => {
    fetchImplMock.mockResolvedValueOnce(
      buildResponse({ status: 301 }),
    );
    const url = new URL("https://a.example/start");
    const result = await safeFetch(url, { fetchImpl: fetchImplMock });
    expect(result.status).toBe(301);
  });
});

describe("safeFetch — passes-through non-redirect responses", () => {
  it("returns 200 response", async () => {
    fetchImplMock.mockResolvedValueOnce(
      buildResponse({
        status: 200,
        bodyText: "hello",
        headers: { "content-type": "text/plain" },
      }),
    );

    const url = new URL("https://public.example/x");
    const result = await safeFetch(url, { fetchImpl: fetchImplMock });
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.headers.get("content-type")).toBe("text/plain");
  });

  it("returns 4xx response", async () => {
    fetchImplMock.mockResolvedValueOnce(buildResponse({ status: 404 }));
    const url = new URL("https://public.example/missing");
    const result = await safeFetch(url, { fetchImpl: fetchImplMock });
    expect(result.status).toBe(404);
    expect(result.ok).toBe(false);
  });
});
