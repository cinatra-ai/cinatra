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
import { classifyArtifactTypeOwnership } from "../../namespace";

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

// ---------------------------------------------------------------------------
// cinatra#2960 — the blog pipeline's selected-idea type.
//
// ACCEPTANCE ITEM 2, VERBATIM: "A test pins the resolution rule for
// `@dynamic/types:*` on the passthrough save path so the refusal class cannot
// silently return."
//
// The passthrough's selected-idea save used to name
// `@dynamic/types:blog-pipeline-selected-idea`, a PERMANENTLY tombstoned id that
// classifies `owned:false` / `dynamic-namespace` before the registry is ever
// consulted. The fix is a host-owned STATIC run-scoped type — the same shape as
// the campaign bundles promoted off `@cinatra-ai/dynamic:*` — so the save names
// a type the registry actually owns. This pins the owned half of the rule.
// ---------------------------------------------------------------------------
describe("register-types — @cinatra-ai/blog-pipeline:selected-idea (cinatra#2960)", () => {
  const TYPE = "@cinatra-ai/blog-pipeline:selected-idea";

  beforeEach(() => {
    objectTypeRegistry._clearForTests();
    registerAllObjectTypes();
  });

  it("registers the selected-idea type through the registrar aggregate", () => {
    const entry = objectTypeRegistry.resolve(TYPE);
    expect(entry).toBeDefined();
    expect(entry).not.toBeNull();
  });

  it("classifies owned:true at the save boundary's own ownership rule", () => {
    // The `objects_save` boundary's ports, verbatim
    // (packages/objects/src/mcp/handlers.ts): a registered type resolves, an
    // unregistered one answers `null`.
    const own = classifyArtifactTypeOwnership(TYPE, {
      isArtifactWritable: (typeId) => (objectTypeRegistry.resolve(typeId) ? true : null),
      packageHasRegisteredTypes: (pkg) => objectTypeRegistry.getTypesForPackage(pkg).length > 0,
    });
    expect(own).toEqual({ owned: true, definer: "@cinatra-ai/blog-pipeline" });
  });

  it("is run-scoped: identityKey is the agent run id, absent it is null", () => {
    const entry = objectTypeRegistry.resolve(TYPE);
    expect(entry?.identityKey?.({ cinatra_agent_run_id: "run-2960" })).toBe("run-2960");
    expect(entry?.identityKey?.({})).toBeNull();
    expect(entry?.identityKey?.({ cinatra_agent_run_id: "" })).toBeNull();
  });

  it("is agent-written and agent-mutable, so a retried save updates in place", () => {
    const entry = objectTypeRegistry.resolve(TYPE);
    expect(entry?.lifecycle.sources).toContain("agent");
    expect(entry?.lifecycle.mutableBy).toContain("agent");
    expect(entry?.crudPolicy?.onMatch).toBe("update");
    expect(entry?.crudPolicy?.onNoMatch).toBe("create");
  });

  it("is NOT registered under a tombstoned dynamic namespace", () => {
    expect(TYPE.startsWith("@dynamic/types:")).toBe(false);
    expect(TYPE.startsWith("@cinatra-ai/dynamic:")).toBe(false);
    const tombstoned = classifyArtifactTypeOwnership(
      "@dynamic/types:blog-pipeline-selected-idea",
      {
        isArtifactWritable: (typeId) => (objectTypeRegistry.resolve(typeId) ? true : null),
        packageHasRegisteredTypes: () => true,
      },
    );
    expect(tombstoned.owned).toBe(false);
    expect(tombstoned.owned === false && tombstoned.reason).toBe("dynamic-namespace");
  });
});
