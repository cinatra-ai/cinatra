/**
 * url-import helper unit tests.
 *
 *   npx vitest run src/lib/artifacts/__tests__/url-import.test.ts
 */
import { describe, expect, it } from "vitest";
import {
  classifyPrivateIp,
  fetchUrlAsMarkdown,
  URL_IMPORT_MAX_RAW_BYTES,
  validateAndResolveUrl,
  __test,
} from "../url-import";

function makeJsonResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

const PUBLIC_IP_DNS = async (_host: string) => ({
  address: "93.184.216.34" as const, // example.com — public IPv4
  family: 4 as const,
});

const PRIVATE_IP_DNS = async (_host: string) => ({
  address: "192.168.1.50" as const,
  family: 4 as const,
});

const LOOPBACK_IP_DNS = async (_host: string) => ({
  address: "127.0.0.1" as const,
  family: 4 as const,
});

const REAL_PAGE_HTML = `
<html>
<head><title>ACME Corp — About</title></head>
<body>
<main>
  <h1>About ACME</h1>
  <p>ACME Corp is the leading vendor of mid-market enterprise gizmos for the financial services sector.</p>
  <h2>Our Mission</h2>
  <p>To deliver world-class gizmos at scale to enterprise customers who demand reliability above all else.</p>
  <ul>
    <li>Founded 2018</li>
    <li>Series B funded</li>
    <li>250 employees globally</li>
  </ul>
  <h2>Buyer Personas</h2>
  <p>Our typical buyer is a VP of Engineering at a 500-2000 person fintech or insurance company. They care about uptime, compliance, and quarterly KPIs.</p>
</main>
<script>console.log('should be stripped');</script>
<style>.x { color: red; }</style>
</body>
</html>
`;

const SPA_SHELL_HTML = `
<html>
<head><title>App Shell</title></head>
<body>
<div id="root"></div>
<script src="/app.js"></script>
</body>
</html>
`;

describe("classifyPrivateIp (thin wrapper over shared validateAddress)", () => {
  // The granular reason enum was removed; the contract is now
  // "blocked" | null. The full CIDR coverage is owned + tested by
  // `_url-validation.ts`; here we assert the wrapper delegates.
  it("blocks IPv4 loopback", () => {
    expect(classifyPrivateIp("127.0.0.1")).toBe("blocked");
    expect(classifyPrivateIp("127.255.255.255")).toBe("blocked");
  });

  it("blocks IPv4 RFC1918 private ranges", () => {
    expect(classifyPrivateIp("10.0.0.1")).toBe("blocked");
    expect(classifyPrivateIp("172.16.0.1")).toBe("blocked");
    expect(classifyPrivateIp("172.31.255.254")).toBe("blocked");
    expect(classifyPrivateIp("192.168.1.50")).toBe("blocked");
  });

  it("blocks link-local + CGNAT + benchmark + TEST-NET (broadened ranges)", () => {
    expect(classifyPrivateIp("169.254.169.254")).toBe("blocked"); // AWS metadata
    expect(classifyPrivateIp("100.64.0.1")).toBe("blocked"); // CGNAT / Tailscale
    expect(classifyPrivateIp("198.18.0.1")).toBe("blocked"); // benchmark
    expect(classifyPrivateIp("192.0.2.1")).toBe("blocked"); // TEST-NET-1
    expect(classifyPrivateIp("203.0.113.5")).toBe("blocked"); // TEST-NET-3
  });

  it("blocks IPv6 loopback + unspecified + link-local (full /10) + ULA + NAT64", () => {
    expect(classifyPrivateIp("::1")).toBe("blocked");
    expect(classifyPrivateIp("::")).toBe("blocked");
    expect(classifyPrivateIp("fe80::1")).toBe("blocked");
    expect(classifyPrivateIp("febf::1")).toBe("blocked"); // upper end of fe80::/10
    expect(classifyPrivateIp("fc00::1")).toBe("blocked");
    expect(classifyPrivateIp("fd00::1")).toBe("blocked");
    expect(classifyPrivateIp("64:ff9b::7f00:1")).toBe("blocked"); // NAT64 → 127.0.0.1
  });

  it("blocks IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    expect(classifyPrivateIp("::ffff:127.0.0.1")).toBe("blocked");
  });

  it("returns null for publicly routable IPv4", () => {
    expect(classifyPrivateIp("93.184.216.34")).toBeNull(); // example.com
    expect(classifyPrivateIp("8.8.8.8")).toBeNull();
  });

  it("returns null for a non-IP string (caller must DNS-resolve first)", () => {
    expect(classifyPrivateIp("example.com")).toBeNull();
  });

  it("returns null for 172.32.0.1 (boundary — RFC1918 ends at 172.31.x.x)", () => {
    expect(classifyPrivateIp("172.32.0.1")).toBeNull();
  });
});

describe("validateAndResolveUrl — SSRF gate", () => {
  it("rejects malformed URLs", async () => {
    const r = await validateAndResolveUrl("not-a-url");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("invalid-url");
  });

  it("rejects non-http(s) protocols", async () => {
    const r = await validateAndResolveUrl("file:///etc/passwd");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("invalid-url");
  });

  it("rejects URLs with userinfo (user:pass@host)", async () => {
    const r = await validateAndResolveUrl("https://user:pass@example.com/", {
      dnsLookup: PUBLIC_IP_DNS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("userinfo-not-allowed");
  });

  it("rejects literal-IP loopback URLs without DNS", async () => {
    const r = await validateAndResolveUrl("http://127.0.0.1:8080/admin");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("private-ip-blocked");
  });

  it("rejects literal-IP private RFC1918 URLs", async () => {
    const r = await validateAndResolveUrl("http://192.168.1.1/");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("private-ip-blocked");
  });

  it("rejects literal IPv6 loopback ::1", async () => {
    const r = await validateAndResolveUrl("http://[::1]:3000/");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("private-ip-blocked");
  });

  it("rejects 169.254.169.254 (AWS metadata)", async () => {
    const r = await validateAndResolveUrl("http://169.254.169.254/latest/meta-data/");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("private-ip-blocked");
  });

  it("rejects when DNS resolves to a private address (DNS rebinding guard)", async () => {
    const r = await validateAndResolveUrl("https://attacker-domain.test/", {
      dnsLookup: PRIVATE_IP_DNS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("private-ip-blocked");
  });

  it("rejects when DNS resolves to loopback", async () => {
    const r = await validateAndResolveUrl("https://attacker-domain.test/", {
      dnsLookup: LOOPBACK_IP_DNS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("private-ip-blocked");
  });

  it("rejects when DNS lookup fails", async () => {
    const r = await validateAndResolveUrl("https://example.com/", {
      dnsLookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("dns-failed");
  });

  it("accepts publicly-routable URLs", async () => {
    const r = await validateAndResolveUrl("https://example.com/path", {
      dnsLookup: PUBLIC_IP_DNS,
    });
    expect(r.ok).toBe(true);
  });
});

describe("normalizeHtmlToMarkdown", () => {
  it("extracts title from <title> tag", () => {
    const r = __test.normalizeHtmlToMarkdown(REAL_PAGE_HTML);
    expect(r.title).toBe("ACME Corp — About");
  });

  it("falls back to first <h1> when <title> is missing", () => {
    const r = __test.normalizeHtmlToMarkdown(
      "<html><body><h1>Headline</h1><p>Body content goes here to clear the SPA-shell length check.</p></body></html>",
    );
    expect(r.title).toBe("Headline");
  });

  it("emits headings + paragraphs as markdown (source heading levels preserved)", () => {
    const r = __test.normalizeHtmlToMarkdown(REAL_PAGE_HTML);
    // The synthesized doc-title heading (always `#`).
    expect(r.markdown).toContain("# ACME Corp — About");
    // Body h2 → `##`. The body h1 is at the top of <main> and stays `#`.
    expect(r.markdown).toContain("## Our Mission");
    expect(r.markdown).toContain("Series B funded");
  });

  it("strips <script> + <style> content", () => {
    const r = __test.normalizeHtmlToMarkdown(REAL_PAGE_HTML);
    expect(r.markdown).not.toContain("console.log");
    expect(r.markdown).not.toContain("color: red");
  });

  it("emits <ul> as markdown list", () => {
    const r = __test.normalizeHtmlToMarkdown(REAL_PAGE_HTML);
    expect(r.markdown).toMatch(/- Founded 2018/);
    expect(r.markdown).toMatch(/- Series B funded/);
  });

  it("reports cleanedTextChars > MIN for a real page", () => {
    const r = __test.normalizeHtmlToMarkdown(REAL_PAGE_HTML);
    expect(r.cleanedTextChars).toBeGreaterThan(200);
  });

  it("reports cleanedTextChars < MIN for a SPA shell", () => {
    const r = __test.normalizeHtmlToMarkdown(SPA_SHELL_HTML);
    expect(r.cleanedTextChars).toBeLessThan(200);
  });
});

describe("fetchUrlAsMarkdown — happy path", () => {
  it("fetches + normalizes + returns markdown for a real page", async () => {
    const fetchMock: typeof globalThis.fetch = async () =>
      makeJsonResponse(REAL_PAGE_HTML);
    const r = await fetchUrlAsMarkdown("https://example.com/about", {
      fetch: fetchMock,
      dnsLookup: PUBLIC_IP_DNS,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.title).toBe("ACME Corp — About");
    expect(r.markdown).toContain("ACME Corp is the leading vendor");
    expect(r.finalUrl).toBe("https://example.com/about");
    expect(r.rawBytes).toBeGreaterThan(0);
  });
});

describe("fetchUrlAsMarkdown — manual redirect handling", () => {
  it("follows a single 301 redirect and re-validates the target", async () => {
    let callCount = 0;
    const fetchMock: typeof globalThis.fetch = async (input) => {
      callCount++;
      const url = String(input);
      if (url === "https://example.com/old") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://example.com/new" },
        });
      }
      if (url === "https://example.com/new") {
        return makeJsonResponse(REAL_PAGE_HTML);
      }
      throw new Error(`unexpected fetch URL: ${url}`);
    };
    const r = await fetchUrlAsMarkdown("https://example.com/old", {
      fetch: fetchMock,
      dnsLookup: PUBLIC_IP_DNS,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.finalUrl).toBe("https://example.com/new");
    expect(callCount).toBe(2);
  });

  it("detects a redirect loop (same URL twice)", async () => {
    const fetchMock: typeof globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/loop" },
      });
    const r = await fetchUrlAsMarkdown("https://example.com/loop", {
      fetch: fetchMock,
      dnsLookup: PUBLIC_IP_DNS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("redirect-loop");
  });

  it("caps at maxRedirects (5 hops by default)", async () => {
    let hop = 0;
    const fetchMock: typeof globalThis.fetch = async () => {
      hop++;
      return new Response(null, {
        status: 302,
        headers: { location: `https://example.com/hop-${hop}` },
      });
    };
    const r = await fetchUrlAsMarkdown("https://example.com/start", {
      fetch: fetchMock,
      dnsLookup: PUBLIC_IP_DNS,
      maxRedirects: 3,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too-many-redirects");
  });

  it("rejects redirect to a private-IP host (DNS rebinding via redirect)", async () => {
    const fetchMock: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "https://public-domain.test/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://internal.test/" },
        });
      }
      throw new Error(`unexpected fetch URL: ${url}`);
    };
    const dnsMock = async (host: string) => {
      if (host === "public-domain.test")
        return { address: "93.184.216.34", family: 4 as const };
      if (host === "internal.test")
        return { address: "10.0.0.1", family: 4 as const };
      throw new Error(`unexpected host: ${host}`);
    };
    const r = await fetchUrlAsMarkdown("https://public-domain.test/", {
      fetch: fetchMock,
      dnsLookup: dnsMock,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("private-ip-blocked");
  });

  it("returns bad-status when redirect lacks Location header", async () => {
    const fetchMock: typeof globalThis.fetch = async () =>
      new Response(null, { status: 301 });
    const r = await fetchUrlAsMarkdown("https://example.com/", {
      fetch: fetchMock,
      dnsLookup: PUBLIC_IP_DNS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("bad-status");
  });
});

describe("fetchUrlAsMarkdown — error responses", () => {
  it("returns bad-status for HTTP 404", async () => {
    const fetchMock: typeof globalThis.fetch = async () =>
      new Response("not found", { status: 404 });
    const r = await fetchUrlAsMarkdown("https://example.com/missing", {
      fetch: fetchMock,
      dnsLookup: PUBLIC_IP_DNS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("bad-status");
    expect(r.message).toMatch(/404/);
  });

  it("returns fetch-failed when fetch throws", async () => {
    const fetchMock: typeof globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await fetchUrlAsMarkdown("https://example.com/", {
      fetch: fetchMock,
      dnsLookup: PUBLIC_IP_DNS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("fetch-failed");
  });

  it("returns unsupported-content-type for application/octet-stream", async () => {
    const fetchMock: typeof globalThis.fetch = async () =>
      new Response("\x00\x01\x02", {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    const r = await fetchUrlAsMarkdown("https://example.com/binary", {
      fetch: fetchMock,
      dnsLookup: PUBLIC_IP_DNS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unsupported-content-type");
  });

  it("returns content-too-large when Content-Length exceeds cap", async () => {
    const fetchMock: typeof globalThis.fetch = async () =>
      new Response("x", {
        status: 200,
        headers: {
          "content-type": "text/html",
          "content-length": String(URL_IMPORT_MAX_RAW_BYTES + 1),
        },
      });
    const r = await fetchUrlAsMarkdown("https://example.com/big", {
      fetch: fetchMock,
      dnsLookup: PUBLIC_IP_DNS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("content-too-large");
  });

  it("returns content-too-large when streamed body exceeds cap (no Content-Length)", async () => {
    const oversize = "x".repeat(2 * 1024); // 2KB
    const fetchMock: typeof globalThis.fetch = async () =>
      new Response(oversize, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const r = await fetchUrlAsMarkdown("https://example.com/medium", {
      fetch: fetchMock,
      dnsLookup: PUBLIC_IP_DNS,
      maxRawBytes: 1024, // 1KB cap forces the runtime check
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("content-too-large");
  });

  it("returns no-readable-content for a SPA shell with no text", async () => {
    const fetchMock: typeof globalThis.fetch = async () =>
      makeJsonResponse(SPA_SHELL_HTML);
    const r = await fetchUrlAsMarkdown("https://spa.example.com/", {
      fetch: fetchMock,
      dnsLookup: PUBLIC_IP_DNS,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no-readable-content");
  });
});
