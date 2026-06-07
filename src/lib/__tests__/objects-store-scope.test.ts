import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Scope filtering of objects-store reads.
//
// Source-text gates assert on file contents, matching the existing test pattern
// in projects-store.test.ts. This avoids spinning a real Postgres for unit
// coverage of the splice helper; integration coverage lives separately.
// ---------------------------------------------------------------------------

const STORE = readFileSync("src/lib/objects-store.ts", "utf-8");
const HANDLERS = readFileSync("packages/objects/src/mcp/handlers.ts", "utf-8");

describe("objects-store scope filtering", () => {
  it("imports buildOwnershipFilter from derived-store-ownership", () => {
    expect(STORE).toContain('from "@/lib/derived-store-ownership"');
    expect(STORE).toContain("buildOwnershipFilter");
  });

  it("imports the ActorContext type", () => {
    expect(STORE).toMatch(/import\s+type\s+\{\s*ActorContext\s*\}\s+from\s+"@\/lib\/authz\/actor-context"/);
  });

  it("getObjectById accepts an actor parameter", () => {
    expect(STORE).toMatch(/getObjectById\([\s\S]*?actor\?: ActorContext/);
  });

  it("listObjectsByFilter accepts an actor parameter", () => {
    expect(STORE).toMatch(/listObjectsByFilter\([\s\S]*?actor\?: ActorContext/);
  });

  it("splices buildOwnershipFilter into the WHERE clause when actor present", () => {
    // Both functions must call buildOwnershipFilter under an `if (actor)` guard.
    const calls = (STORE.match(/buildOwnershipFilter\(actor\)/g) ?? []).length;
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("objects MCP handlers fail-closed", () => {
  // The handlers resolve org context via `getActorExt(request.actor)` (actor
  // field + AsyncLocalStorage fallback) and gate every CRUD decision through
  // the `enforceResourceAccess` kernel. The fail-closed contract is the
  // per-handler org-context guard plus the kernel gate — not a passthrough of
  // `actor` into the store call shape (the store keeps its own
  // `buildOwnershipFilter` path, asserted above).
  it("each mutating/reading handler has a fail-closed org-context guard", () => {
    const guards = (
      HANDLERS.match(/if \(!orgId && process\.env\.A2A_DEV_BYPASS !== "true"\)/g) ?? []
    ).length;
    // objects_save, objects_list, objects_get, objects_update, objects_delete.
    expect(guards).toBeGreaterThanOrEqual(5);
  });

  it("gates CRUD through the enforceResourceAccess kernel with the request actor", () => {
    expect(HANDLERS).toContain("enforceResourceAccess");
    // read / create / update / delete actions all flow through the kernel.
    for (const action of [
      "object.read",
      "object.create",
      "object.update",
      "object.delete",
    ]) {
      expect(HANDLERS).toContain(`"${action}"`);
    }
    const calls = (HANDLERS.match(/enforceResourceAccess\(/g) ?? []).length;
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it("resolves the org-scoped read via getObjectById({ orgId }) before the kernel gate", () => {
    // Reads are org-scoped at the store and authz-gated by the kernel; the
    // store call carries `{ orgId }`, not a trailing actor argument.
    expect(HANDLERS).toMatch(/getObjectById\([^,]+,\s*\{\s*orgId\s*\}\)/);
  });
});
