// cinatra#1381 — the shared MCP tool SCOPE resolver, extracted from
// src/lib/artifacts/mcp.ts so the artifact primitives and
// `memory_promote_request` cannot disagree about whose organization a call runs
// in. Its behaviour is unchanged by the extraction; these are the fail-closed
// properties that must survive it.
import { describe, it, expect, vi, beforeEach } from "vitest";

const getStore = vi.fn();

vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: { getStore: () => getStore() },
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  buildActorContextFromPrimitive: (primitive: unknown, orgId: string, extra: unknown) => ({
    primitive,
    orgId,
    extra,
  }),
}));

import { resolveScope } from "../mcp-tool-scope";

beforeEach(() => {
  getStore.mockReset();
});

describe("fail-closed scoping", () => {
  it("THROWS when there is no active organization — never reads unscoped", () => {
    getStore.mockReturnValue({ userId: "u-1" });
    expect(() => resolveScope()).toThrow(/no active organization/);
    getStore.mockReturnValue(undefined);
    expect(() => resolveScope()).toThrow(/no active organization/);
  });

  it("THROWS rather than lending the transport's org to an A2A identity", () => {
    getStore.mockReturnValue({
      userId: "u-transport",
      orgId: "org-transport",
      a2aActorContext: { userId: "u-a2a" },
    });
    expect(() => resolveScope()).toThrow(/A2A context carries no orgId/);
  });
});

describe("A2A precedence", () => {
  it("an A2A identity and ITS organization win over the transport's", () => {
    getStore.mockReturnValue({
      userId: "u-transport",
      orgId: "org-transport",
      orgRole: "org_admin",
      a2aActorContext: { userId: "u-a2a", orgId: "org-a2a", teamIds: ["team-a2a"] },
    });
    const scope = resolveScope();
    expect(scope.orgId).toBe("org-a2a");
    expect(scope.userId).toBe("u-a2a");
  });

  it("does NOT carry the transport-resolved org role onto an A2A call", () => {
    getStore.mockReturnValue({
      userId: "u-transport",
      orgId: "org-transport",
      orgRole: "org_admin",
      a2aActorContext: { userId: "u-a2a", orgId: "org-a2a" },
    });
    const actor = resolveScope().actor as unknown as { extra: { orgRole?: string } };
    expect(actor.extra.orgRole).toBeUndefined();
  });

  it("a non-A2A call DOES carry the transport-resolved org role", () => {
    getStore.mockReturnValue({ userId: "u-1", orgId: "org-1", orgRole: "org_admin" });
    const actor = resolveScope().actor as unknown as { extra: { orgRole?: string } };
    expect(actor.extra.orgRole).toBe("org_admin");
  });
});

describe("no relaxation exists", () => {
  it("the resolver reads NO environment variable — there is no dev bypass here", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "..", "mcp-tool-scope.ts"), "utf8");
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/A2A_DEV_BYPASS|DEV_BYPASS|isLocalhost/);
  });
});
