// Hermetic vitest for the pure URL-shape helper.
//
// This file is intentionally TypeScript (not .mts) so it matches the existing
// vitest include pattern; it imports the .mjs source under test directly.
// No mocks, no env, no network, no DB.

import { describe, expect, it } from "vitest";

import {
  MCP_PUBLIC_BASE_URL_METADATA_KEY,
  buildMcpPublicBaseUrlRow,
  normaliseMcpPublicBaseUrl,
} from "../mcp-public-base-url-shape.mjs";

describe("normaliseMcpPublicBaseUrl", () => {
  it("returns null + unknown for null", () => {
    expect(normaliseMcpPublicBaseUrl(null)).toEqual({ url: null, source: "unknown" });
  });

  it("returns null + unknown for undefined", () => {
    expect(normaliseMcpPublicBaseUrl(undefined)).toEqual({ url: null, source: "unknown" });
  });

  it("returns null + unknown for empty string", () => {
    expect(normaliseMcpPublicBaseUrl("")).toEqual({ url: null, source: "unknown" });
  });

  it("returns null + unknown for whitespace", () => {
    expect(normaliseMcpPublicBaseUrl("   ")).toEqual({ url: null, source: "unknown" });
  });

  it("returns null + unknown for non-string inputs", () => {
    // @ts-expect-error — exercising the runtime guard
    expect(normaliseMcpPublicBaseUrl(42)).toEqual({ url: null, source: "unknown" });
    // @ts-expect-error — exercising the runtime guard
    expect(normaliseMcpPublicBaseUrl({})).toEqual({ url: null, source: "unknown" });
  });

  it("strips trailing slashes", () => {
    expect(normaliseMcpPublicBaseUrl("https://example.ts.net/")).toEqual({
      url: "https://example.ts.net",
      source: "manual",
    });
    expect(normaliseMcpPublicBaseUrl("https://example.ts.net///")).toEqual({
      url: "https://example.ts.net",
      source: "manual",
    });
  });

  it("returns origin-only normalised form for valid http", () => {
    expect(normaliseMcpPublicBaseUrl("http://localhost:3000")).toEqual({
      url: "http://localhost:3000",
      source: "manual",
    });
  });

  it("returns origin-only normalised form for valid https", () => {
    expect(normaliseMcpPublicBaseUrl("https://h.example.ts.net")).toEqual({
      url: "https://h.example.ts.net",
      source: "manual",
    });
  });

  it("rejects unparseable URLs", () => {
    expect(() => normaliseMcpPublicBaseUrl("not a url")).toThrow(/valid http\(s\)/);
  });

  it("rejects non-http schemes", () => {
    expect(() => normaliseMcpPublicBaseUrl("ftp://example.com")).toThrow(/http\(s\) scheme/);
    expect(() => normaliseMcpPublicBaseUrl("file:///etc/passwd")).toThrow(/http\(s\) scheme/);
  });

  it("rejects URLs with paths", () => {
    expect(() => normaliseMcpPublicBaseUrl("https://h/api/mcp")).toThrow(/origin without a path/);
  });

  it("rejects URLs with query strings", () => {
    expect(() => normaliseMcpPublicBaseUrl("https://h?token=x")).toThrow(/query string or fragment/);
  });

  it("rejects URLs with fragments", () => {
    expect(() => normaliseMcpPublicBaseUrl("https://h#section")).toThrow(/query string or fragment/);
  });

  it("trims leading + trailing whitespace before validating", () => {
    expect(normaliseMcpPublicBaseUrl("  https://h.example.ts.net  ")).toEqual({
      url: "https://h.example.ts.net",
      source: "manual",
    });
  });
});

describe("buildMcpPublicBaseUrlRow", () => {
  it("preserves sibling fields and writes publicBaseUrl + source + updatedAt", () => {
    const current = { someOtherSetting: "x", publicBaseUrl: null, publicBaseUrlSource: "unknown" };
    const next = buildMcpPublicBaseUrlRow(current, "https://h.ts.net");
    expect(next.someOtherSetting).toBe("x");
    expect(next.publicBaseUrl).toBe("https://h.ts.net");
    expect(next.publicBaseUrlSource).toBe("manual");
    expect(typeof next.updatedAt).toBe("string");
    // ISO 8601 sniff
    expect(next.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("clears the row when input is null", () => {
    const current = { publicBaseUrl: "https://old.ts.net", publicBaseUrlSource: "manual" };
    const next = buildMcpPublicBaseUrlRow(current, null);
    expect(next.publicBaseUrl).toBeNull();
    expect(next.publicBaseUrlSource).toBe("unknown");
  });

  it("drops retired fields tunnelMode/externalUrl/cloudflaredMissing", () => {
    const current = {
      tunnelMode: "cli",
      externalUrl: "https://retired.example",
      cloudflaredMissing: true,
      publicBaseUrl: null,
    };
    const next = buildMcpPublicBaseUrlRow(current, "https://h.ts.net");
    expect("tunnelMode" in next).toBe(false);
    expect("externalUrl" in next).toBe(false);
    expect("cloudflaredMissing" in next).toBe(false);
    expect(next.publicBaseUrl).toBe("https://h.ts.net");
  });

  it("propagates validation errors from normaliseMcpPublicBaseUrl", () => {
    expect(() => buildMcpPublicBaseUrlRow({}, "https://h/api/mcp")).toThrow(/origin without a path/);
  });
});

describe("MCP_PUBLIC_BASE_URL_METADATA_KEY", () => {
  it("matches the canonical mcp_server settings key", () => {
    expect(MCP_PUBLIC_BASE_URL_METADATA_KEY).toBe("connector_config:mcp_server");
  });
});

describe("source-aware write", () => {
  it("normaliseMcpPublicBaseUrl honors options.source for valid URLs", () => {
    expect(
      normaliseMcpPublicBaseUrl("https://x.ts.net", { source: "tailscale-auto" }),
    ).toEqual({ url: "https://x.ts.net", source: "tailscale-auto" });
    expect(
      normaliseMcpPublicBaseUrl("https://x.ts.net", { source: "tailscale-funnel" }),
    ).toEqual({ url: "https://x.ts.net", source: "tailscale-funnel" });
    expect(
      normaliseMcpPublicBaseUrl("https://x.ts.net", { source: "manual" }),
    ).toEqual({ url: "https://x.ts.net", source: "manual" });
  });

  it("normaliseMcpPublicBaseUrl defaults to manual when no options provided (backward compat)", () => {
    expect(normaliseMcpPublicBaseUrl("https://x.ts.net")).toEqual({
      url: "https://x.ts.net",
      source: "manual",
    });
  });

  it("normaliseMcpPublicBaseUrl ignores invalid source values (defensive)", () => {
    // @ts-expect-error — exercising the runtime guard
    expect(normaliseMcpPublicBaseUrl("https://x.ts.net", { source: "bogus" })).toEqual({
      url: "https://x.ts.net",
      source: "manual",
    });
  });

  it("normaliseMcpPublicBaseUrl null-URL always returns unknown source regardless of options", () => {
    expect(normaliseMcpPublicBaseUrl(null, { source: "tailscale-auto" })).toEqual({
      url: null,
      source: "unknown",
    });
  });

  it("buildMcpPublicBaseUrlRow stamps the requested source on the row", () => {
    const next = buildMcpPublicBaseUrlRow({}, "https://x.ts.net", {
      source: "tailscale-auto",
    });
    expect(next.publicBaseUrl).toBe("https://x.ts.net");
    expect(next.publicBaseUrlSource).toBe("tailscale-auto");
  });

  it("buildMcpPublicBaseUrlRow without options keeps manual stamp (existing CLI/UI callers unchanged)", () => {
    const next = buildMcpPublicBaseUrlRow({}, "https://x.ts.net");
    expect(next.publicBaseUrlSource).toBe("manual");
  });
});
