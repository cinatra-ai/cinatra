// cinatra#2018 S3 PR-B — per-server endpoint derivation, probe keying/eviction,
// and the dedicated-server probe. The default-route paths are asserted
// behavior-identical (additive `restPath` param defaults to
// WP_MCP_ADAPTER_ROUTE); the per-server paths key the probe cache by the
// resolved per-server URL so a dedicated server's health is independent of the
// default's, and credential-rotate invalidation evicts every per-server entry
// for a site by prefix (§7).

import { Buffer } from "node:buffer";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  invalidateWordPressMcpProbeCache,
  probeWordPressInstanceMcpAdapter,
  probeWordPressInstanceMcpServer,
  resolveWordPressMcpEndpoint,
  resolveWordPressMcpFallbackEndpoint,
  type WordPressMcpProbeTarget,
} from "@/lib/wordpress-mcp-connection";

const DEFAULT_ROUTE = "/mcp/mcp-adapter-default-server";
const DEDICATED_ROUTE = "/mcp/fixture-vendor-server";

function target(siteUrl: string): WordPressMcpProbeTarget {
  return { siteUrl, username: "wp_user", applicationPassword: "app secret 123" };
}
const expectedAuth = `Basic ${Buffer.from("wp_user:app secret 123", "utf8").toString("base64")}`;

/** A fetch stub returning a fixed status for every HEAD, recording called URLs. */
function stubFetchStatus(status: number) {
  const fn = vi.fn(async () => ({ status }) as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.clearAllMocks();
  stubFetchStatus(200);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Endpoint-form derivation (pure) — default (behavior-preserving) + dedicated.
// ---------------------------------------------------------------------------
describe("resolveWordPressMcp{Endpoint,FallbackEndpoint} — endpoint derivation", () => {
  it("default (no restPath) is behavior-identical to the grandfathered default server", () => {
    const site = "https://example.test";
    expect(resolveWordPressMcpEndpoint(site)).toBe(`${site}/wp-json${DEFAULT_ROUTE}`);
    expect(resolveWordPressMcpFallbackEndpoint(site)).toBe(`${site}/index.php?rest_route=${DEFAULT_ROUTE}`);
  });

  it("derives dedicated-server pretty + query-string forms from an enrolled restPath", () => {
    const site = "https://example.test";
    expect(resolveWordPressMcpEndpoint(site, DEDICATED_ROUTE)).toBe(`${site}/wp-json${DEDICATED_ROUTE}`);
    expect(resolveWordPressMcpFallbackEndpoint(site, DEDICATED_ROUTE)).toBe(
      `${site}/index.php?rest_route=${DEDICATED_ROUTE}`,
    );
  });

  it("trims trailing slashes on the site URL for both forms", () => {
    expect(resolveWordPressMcpEndpoint("https://example.test///", DEDICATED_ROUTE)).toBe(
      `https://example.test/wp-json${DEDICATED_ROUTE}`,
    );
    expect(resolveWordPressMcpFallbackEndpoint("https://example.test///", DEDICATED_ROUTE)).toBe(
      `https://example.test/index.php?rest_route=${DEDICATED_ROUTE}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Probe classification — same four verdicts, now route-aware.
// ---------------------------------------------------------------------------
describe("probeWordPressInstanceMcpServer — classification", () => {
  it("200 → registered, HEAD issued to the dedicated pretty URL with Basic auth", async () => {
    const fetchMock = stubFetchStatus(200);
    const status = await probeWordPressInstanceMcpServer(target("https://p200.test"), DEDICATED_ROUTE);
    expect(status).toBe("registered");
    expect(fetchMock).toHaveBeenCalledWith(
      `https://p200.test/wp-json${DEDICATED_ROUTE}`,
      expect.objectContaining({ method: "HEAD", headers: { Authorization: expectedAuth } }),
    );
  });

  it("405 → registered (endpoint exists, HEAD unsupported)", async () => {
    stubFetchStatus(405);
    expect(await probeWordPressInstanceMcpServer(target("https://p405.test"), DEDICATED_ROUTE)).toBe("registered");
  });

  it("401 → auth_error", async () => {
    stubFetchStatus(401);
    expect(await probeWordPressInstanceMcpServer(target("https://p401.test"), DEDICATED_ROUTE)).toBe("auth_error");
  });

  it("404 on both pretty and fallback → not_installed (fallback attempted)", async () => {
    const fetchMock = stubFetchStatus(404);
    const status = await probeWordPressInstanceMcpServer(target("https://p404.test"), DEDICATED_ROUTE);
    expect(status).toBe("not_installed");
    // pretty first, then the index.php?rest_route= fallback because pretty 404'd.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, `https://p404.test/wp-json${DEDICATED_ROUTE}`, expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://p404.test/index.php?rest_route=${DEDICATED_ROUTE}`,
      expect.anything(),
    );
  });

  it("pretty 404 then fallback 200 → registered", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      (url.includes("/wp-json") ? { status: 404 } : { status: 200 }) as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeWordPressInstanceMcpServer(target("https://pf.test"), DEDICATED_ROUTE)).toBe("registered");
  });

  it("network error → unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    expect(await probeWordPressInstanceMcpServer(target("https://pnet.test"), DEDICATED_ROUTE)).toBe("unreachable");
  });
});

// ---------------------------------------------------------------------------
// Per-server cache keying + prefix eviction (§7).
// ---------------------------------------------------------------------------
describe("probe cache — per-server keying", () => {
  it("caches by the per-server URL: a repeat probe is served from cache (no second fetch)", async () => {
    const fetchMock = stubFetchStatus(200);
    const site = "https://keying-repeat.test";
    await probeWordPressInstanceMcpServer(target(site), DEDICATED_ROUTE);
    await probeWordPressInstanceMcpServer(target(site), DEDICATED_ROUTE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a cached DEFAULT-route verdict does NOT serve a DEDICATED-route probe on the same site", async () => {
    const site = "https://keying-split.test";
    // 1) Default route → registered, now cached under the default key.
    const okFetch = stubFetchStatus(200);
    expect(await probeWordPressInstanceMcpAdapter(target(site))).toBe("registered");
    expect(okFetch).toHaveBeenCalledTimes(1);
    // 2) Dedicated route on the SAME site → different key → fresh fetch (401).
    const authErrFetch = stubFetchStatus(401);
    expect(await probeWordPressInstanceMcpServer(target(site), DEDICATED_ROUTE)).toBe("auth_error");
    expect(authErrFetch).toHaveBeenCalledTimes(1);
    // 3) Default route re-probe → still served from its own cache (no new fetch).
    const unusedFetch = stubFetchStatus(500);
    expect(await probeWordPressInstanceMcpAdapter(target(site))).toBe("registered");
    expect(unusedFetch).not.toHaveBeenCalled();
  });
});

describe("invalidateWordPressMcpProbeCache — prefix eviction", () => {
  it("evicts EVERY per-server entry for a site (default + dedicated) in one call", async () => {
    const site = "https://evict.test";
    // Populate both the default and a dedicated entry (both registered).
    const seedFetch = stubFetchStatus(200);
    await probeWordPressInstanceMcpAdapter(target(site));
    await probeWordPressInstanceMcpServer(target(site), DEDICATED_ROUTE);
    expect(seedFetch).toHaveBeenCalledTimes(2);

    invalidateWordPressMcpProbeCache(site);

    // Both re-probe against the fresh status (cache cleared for both routes).
    const afterFetch = stubFetchStatus(401);
    expect(await probeWordPressInstanceMcpAdapter(target(site))).toBe("auth_error");
    expect(await probeWordPressInstanceMcpServer(target(site), DEDICATED_ROUTE)).toBe("auth_error");
    expect(afterFetch).toHaveBeenCalledTimes(2);
  });

  it("does not evict a DIFFERENT site whose URL shares a prefix segment", async () => {
    const seedFetch = stubFetchStatus(200);
    await probeWordPressInstanceMcpAdapter(target("https://site.test"));
    await probeWordPressInstanceMcpAdapter(target("https://site.test2"));
    expect(seedFetch).toHaveBeenCalledTimes(2);

    // Evicting "https://site.test" must NOT touch "https://site.test2"
    // (the eviction prefix is anchored at the canonical key shape).
    invalidateWordPressMcpProbeCache("https://site.test");

    const afterFetch = stubFetchStatus(401);
    expect(await probeWordPressInstanceMcpAdapter(target("https://site.test"))).toBe("auth_error"); // re-probed
    expect(await probeWordPressInstanceMcpAdapter(target("https://site.test2"))).toBe("registered"); // still cached
    expect(afterFetch).toHaveBeenCalledTimes(1);
  });

  it("does not evict a SUBDIRECTORY install on the same origin (codex round-0 High)", async () => {
    // Two DISTINCT WP instances: a root install and a subdirectory install.
    const root = "https://sub.test";
    const subdir = "https://sub.test/blog";
    const seedFetch = stubFetchStatus(200);
    await probeWordPressInstanceMcpAdapter(target(root));
    await probeWordPressInstanceMcpAdapter(target(subdir));
    expect(seedFetch).toHaveBeenCalledTimes(2);

    // Evicting the ROOT site must not clear the subdirectory site's verdict:
    // the prefix is "https://sub.test/index.php?rest_route=", which does not
    // match "https://sub.test/blog/index.php?rest_route=…".
    invalidateWordPressMcpProbeCache(root);
    const afterRootEvict = stubFetchStatus(401);
    expect(await probeWordPressInstanceMcpAdapter(target(subdir))).toBe("registered"); // still cached
    expect(await probeWordPressInstanceMcpAdapter(target(root))).toBe("auth_error"); // re-probed
    expect(afterRootEvict).toHaveBeenCalledTimes(1);

    // And the reverse: evicting the SUBDIRECTORY site leaves the root alone.
    invalidateWordPressMcpProbeCache(subdir);
    const afterSubdirEvict = stubFetchStatus(200);
    expect(await probeWordPressInstanceMcpAdapter(target(root))).toBe("auth_error"); // still cached
    expect(await probeWordPressInstanceMcpAdapter(target(subdir))).toBe("registered"); // re-probed
    expect(afterSubdirEvict).toHaveBeenCalledTimes(1);
  });
});
