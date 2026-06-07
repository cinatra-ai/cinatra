// @cinatra-ai/objects:object generic type registration
//
// Requirement: The objectTypeRegistry must contain a registration for
// "@cinatra-ai/objects:object" whose identityKey function:
//   - returns the cinatraAgentRunId string when present (non-empty)
//   - returns null when cinatraAgentRunId is absent (preserving random-UUID behavior)
//   - returns null when cinatraAgentRunId is an empty string

import { describe, it, expect, vi, beforeAll } from "vitest";

// Mock server-only (node test runner cannot resolve Next.js server-only)
vi.mock("server-only", () => ({}));

// CRM account/contact registration was removed from register-types.ts in the
// Twenty migration (the crm-connector extension owns it now), so no entity-
// package mocks are needed here.
// Blog object types are registered by the host. This module does not pull in
// `registerBlogObjectTypes`, so no blog registrar mock is needed.
// generic-renderers uses React (JSX) which vitest can handle, but mock anyway
// to keep the test pure TS.
vi.mock("./generic-renderers", () => ({
  GenericObjectListRow: vi.fn(),
  GenericObjectCard: vi.fn(),
  GenericObjectDetail: vi.fn(),
}));

// The registry itself is not mocked — we want to inspect its real state.
import { objectTypeRegistry } from "../registry";
import { registerAllObjectTypes } from "../integration/register-types";

describe("@cinatra-ai/objects:object generic type registration", () => {
  beforeAll(() => {
    // Register all types (idempotent — safe to call multiple times)
    registerAllObjectTypes();
  });

  it("@cinatra-ai/objects:object is present in the registry after registerAllObjectTypes", () => {
    const resolved = objectTypeRegistry.resolve("@cinatra-ai/objects:object");
    expect(resolved).not.toBeNull();
    expect(resolved).toBeDefined();
  });

  it("identityKey returns cinatraAgentRunId string when field is present", () => {
    const resolved = objectTypeRegistry.resolve("@cinatra-ai/objects:object");
    expect(resolved).toBeDefined();
    const identityKey = resolved!.identityKey;
    expect(typeof identityKey).toBe("function");

    const result = identityKey!({ cinatraAgentRunId: "run-abc123" });
    expect(result).toBe("run-abc123");
  });

  it("identityKey returns null when cinatraAgentRunId is absent (no over-dedup)", () => {
    const resolved = objectTypeRegistry.resolve("@cinatra-ai/objects:object");
    const identityKey = resolved!.identityKey!;

    expect(identityKey({})).toBeNull();
    expect(identityKey({ name: "some object" })).toBeNull();
  });

  it("identityKey returns null when cinatraAgentRunId is an empty string", () => {
    const resolved = objectTypeRegistry.resolve("@cinatra-ai/objects:object");
    const identityKey = resolved!.identityKey!;

    expect(identityKey({ cinatraAgentRunId: "" })).toBeNull();
  });

  it("identityKey returns null when cinatraAgentRunId is not a string", () => {
    const resolved = objectTypeRegistry.resolve("@cinatra-ai/objects:object");
    const identityKey = resolved!.identityKey!;

    expect(identityKey({ cinatraAgentRunId: 42 })).toBeNull();
    expect(identityKey({ cinatraAgentRunId: null })).toBeNull();
  });
});
