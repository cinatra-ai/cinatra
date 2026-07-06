// Behavior lock for the neutral URL reachability policy extracted from
// @/lib/wordpress-mcp-connection (cinatra#975). Guards the private-range
// classification and the malformed-URL fallback so the extraction preserves
// the exact semantics the external-MCP registry + the wordpress/drupal MCP
// helpers relied on.
import { describe, expect, it } from "vitest";

import { isPrivateUrl } from "@/lib/url-policy";

describe("isPrivateUrl", () => {
  it("classifies loopback/localhost hosts as private", () => {
    expect(isPrivateUrl("http://localhost")).toBe(true);
    expect(isPrivateUrl("http://localhost:8080/wp-json")).toBe(true);
    expect(isPrivateUrl("https://127.0.0.1")).toBe(true);
  });

  it("classifies RFC-1918 private ranges as private", () => {
    expect(isPrivateUrl("http://10.0.0.5")).toBe(true);
    expect(isPrivateUrl("http://192.168.1.20/wp-json")).toBe(true);
    expect(isPrivateUrl("http://172.16.0.1")).toBe(true);
    expect(isPrivateUrl("http://172.31.255.255")).toBe(true);
  });

  it("treats public hosts and near-range hosts as reachable", () => {
    expect(isPrivateUrl("https://mcp.example.com")).toBe(false);
    expect(isPrivateUrl("https://blog.cinatra.ai/wp-json")).toBe(false);
    // 172.15 and 172.32 sit just OUTSIDE the 172.16–172.31 private block.
    expect(isPrivateUrl("http://172.15.0.1")).toBe(false);
    expect(isPrivateUrl("http://172.32.0.1")).toBe(false);
  });

  it("returns false (fail-open to reachable) for a malformed URL", () => {
    expect(isPrivateUrl("not a url")).toBe(false);
    expect(isPrivateUrl("")).toBe(false);
  });
});
