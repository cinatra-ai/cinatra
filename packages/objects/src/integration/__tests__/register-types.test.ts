import { describe, it, expect, beforeEach, vi } from "vitest";

// `register-types.ts` (and the registry module graph it pulls in) imports
// `server-only`, which throws when loaded outside an RSC. Mock it to a no-op
// so vitest collection succeeds — matches the pattern used in
// `__tests__/graphiti-client.test.ts` and `__tests__/mcp-primitives.test.ts`.
vi.mock("server-only", () => ({}));

// `register-types.ts` also imports the per-package `register*ObjectTypes()`
// functions from sibling workspace packages, which pull React renderer modules
// transitively. Vitest can't resolve those package sub-paths without explicit
// aliases, and this test file's subject is only the `:context` registration —
// the sibling packages' side effects are out of scope. Mock them to no-ops so
// vitest collection succeeds.
// CRM account/contact registration was removed from register-types.ts in the
// Twenty migration (the crm-connector extension owns it now); blog object-types
// are registered host-side. So this test mocks neither.

import { objectTypeRegistry } from "../../registry";
import { registerAllObjectTypes } from "../register-types";

describe("register-types — @cinatra-ai/campaigns:context", () => {
  beforeEach(() => {
    // Reset registry between tests so registerAllObjectTypes is idempotent for the assertions below.
    // Use the documented test hook from registry.ts:53
    objectTypeRegistry._clearForTests();
    registerAllObjectTypes();
  });

  it("registers a type entry for @cinatra-ai/campaigns:context", () => {
    const entry = objectTypeRegistry.resolve("@cinatra-ai/campaigns:context");
    expect(entry).toBeDefined();
    expect(entry).not.toBeNull();
  });

  it("places @cinatra-ai/campaigns:context in the project category", () => {
    const entry = objectTypeRegistry.resolve("@cinatra-ai/campaigns:context");
    expect(entry?.category).toBe("project");
  });

  it("identityKey returns cinatra_agent_run_id when present", () => {
    const entry = objectTypeRegistry.resolve("@cinatra-ai/campaigns:context");
    expect(entry?.identityKey?.({ cinatra_agent_run_id: "run-abc" })).toBe("run-abc");
  });

  it("identityKey returns null when cinatra_agent_run_id is missing or empty", () => {
    const entry = objectTypeRegistry.resolve("@cinatra-ai/campaigns:context");
    expect(entry?.identityKey?.({})).toBeNull();
    expect(entry?.identityKey?.({ cinatra_agent_run_id: "" })).toBeNull();
  });

  it("lifecycle declares agent as a source and agent+user as mutators", () => {
    const entry = objectTypeRegistry.resolve("@cinatra-ai/campaigns:context");
    expect(entry?.lifecycle.sources).toContain("agent");
    expect(entry?.lifecycle.mutableBy).toContain("agent");
    expect(entry?.lifecycle.mutableBy).toContain("user");
  });
});
