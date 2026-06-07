import { describe, it, expect } from "vitest";

import {
  resolveInjectedMcpServerUrl,
  type ExternalMcpServerRecord,
} from "@/lib/external-mcp-registry";

// Pure-unit tests for the Layer B URL-injection decision. The full route
// behavior (real upstream forward + bearer attach) is exercised by the
// proxy route's own e2e test once we have a DB-backed fixture.

function makeRow(
  overrides: Partial<ExternalMcpServerRecord> = {},
): ExternalMcpServerRecord {
  return {
    id: "test-server",
    label: "Test Server",
    serverUrl: "https://upstream.example.com/mcp",
    nangoConnectionId: null,
    scope: "global",
    orgId: null,
    userId: null,
    enabled: true,
    allowedTools: null,
    allowedCatalogTools: null,
    createdAt: "2026-05-25T00:00:00Z",
    updatedAt: "2026-05-25T00:00:00Z",
    ...overrides,
  };
}

describe("resolveInjectedMcpServerUrl", () => {
  it("returns the raw upstream URL when no catalog allowlist is set (Layer A only)", () => {
    const row = makeRow({ allowedCatalogTools: null });
    const url = resolveInjectedMcpServerUrl(row, "https://cinatra.test");
    expect(url).toBe("https://upstream.example.com/mcp");
  });

  it("returns the proxy URL when catalog allowlist is set", () => {
    const row = makeRow({
      id: "twenty-workspace",
      allowedCatalogTools: ["find_companies", "find_people"],
    });
    const url = resolveInjectedMcpServerUrl(row, "https://cinatra.test");
    expect(url).toBe("https://cinatra.test/api/external-mcp/proxy/twenty-workspace");
  });

  it("strips trailing slashes from the public base URL", () => {
    const row = makeRow({ allowedCatalogTools: ["find_companies"] });
    const url = resolveInjectedMcpServerUrl(row, "https://cinatra.test/");
    expect(url).toBe("https://cinatra.test/api/external-mcp/proxy/test-server");
  });

  it("returns null (fail-closed) when catalog allowlist is set but no public base URL is configured", () => {
    const row = makeRow({ allowedCatalogTools: ["find_companies"] });
    const url = resolveInjectedMcpServerUrl(row, null);
    expect(url).toBeNull();
  });

  it("URL-encodes the server id (defends against path-injection via row id)", () => {
    const row = makeRow({
      id: "weird/id with spaces",
      allowedCatalogTools: ["find_companies"],
    });
    const url = resolveInjectedMcpServerUrl(row, "https://cinatra.test");
    expect(url).toBe(
      "https://cinatra.test/api/external-mcp/proxy/weird%2Fid%20with%20spaces",
    );
  });

  it("returns the raw URL for an empty catalog allowlist (=== null check, not length)", () => {
    // null vs [] semantics: null = no Layer B enforcement, [] = deny everything.
    // For an empty array the proxy would still validate (and always reject) —
    // the URL selection logic only checks null-vs-set, so [] routes through
    // proxy. This test pins the boundary.
    const row = makeRow({ allowedCatalogTools: [] });
    const url = resolveInjectedMcpServerUrl(row, "https://cinatra.test");
    expect(url).toBe("https://cinatra.test/api/external-mcp/proxy/test-server");
  });
});
