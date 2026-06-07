import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { isAgentPubliclyDiscoverable } from "../store";

describe("isAgentPubliclyDiscoverable (visibility policy)", () => {
  it("public visibility → discoverable", () => {
    expect(isAgentPubliclyDiscoverable({ origin: { visibility: "public" } })).toBe(true);
  });
  it("null origin → discoverable (grandfather)", () => {
    expect(isAgentPubliclyDiscoverable({ origin: null })).toBe(true);
    expect(isAgentPubliclyDiscoverable({})).toBe(true);
  });
  it("private visibility → NOT discoverable", () => {
    expect(isAgentPubliclyDiscoverable({ origin: { visibility: "private" } })).toBe(false);
  });
  it("any non-public visibility (org/workspace) → NOT discoverable", () => {
    expect(isAgentPubliclyDiscoverable({ origin: { visibility: "organization" } })).toBe(false);
    expect(isAgentPubliclyDiscoverable({ origin: { visibility: "workspace" } })).toBe(false);
  });
});
