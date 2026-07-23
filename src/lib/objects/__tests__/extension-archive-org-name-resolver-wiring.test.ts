import { beforeEach, describe, expect, it, vi } from "vitest";

// Host wiring of the BEST-EFFORT org-name resolver (OWNER RULING 2026-07-22,
// groganz). The platform-scope archive/restore refusal names the blocking
// organizations for the administrator's migration list — id always, name where
// resolvable. The resolver reads names from the betterAuth `organization` table.
// This test CAPTURES the resolver the consolidated wiring installs and proves it
// maps org ids → names, with the auth-db handle mocked (no live DB).

// Static import of the wiring module: the claim-lifecycle leaf it pulls in.
vi.mock("@/lib/objects/artifact-claim-lifecycle", () => ({
  retireArtifactExtensionClaims: vi.fn(() => ({})),
  retireArtifactExtensionClaimsAllScopes: vi.fn(() => ({})),
}));

// Capture the resolver the wiring installs (stand in for the extensions barrel).
type OrgNameResolver = (orgIds: string[]) => Map<string, string> | Promise<Map<string, string>>;
const holder = vi.hoisted(() => ({ resolver: null as OrgNameResolver | null }));
vi.mock("@cinatra-ai/extensions", () => ({
  setExtensionArchiveOrgNameResolver: (resolver: OrgNameResolver | null) => {
    holder.resolver = resolver;
  },
  // The other seams the consolidated module installs — no-op capture.
  setExtensionArtifactClaimArchivalHook: () => {},
  setExtensionArtifactClaimReactivationHook: () => {},
  setExtensionArtifactClaimArchivalAllScopesHook: () => {},
}));

// The betterAuth `organization` read the resolver performs — mocked handle.
const whereMock = vi.fn(async () => [
  { id: "org-a", name: "Acme Inc" },
  { id: "org-b", name: "Beta LLC" },
]);
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: { select: () => ({ from: () => ({ where: whereMock }) }) },
  betterAuthOrganizations: { id: { name: "id" }, name: { name: "name" } },
}));
vi.mock("drizzle-orm", () => ({ inArray: (col: unknown, vals: unknown) => ({ col, vals }) }));

import "@/lib/objects/extension-artifact-claim-archival-wiring";

beforeEach(() => {
  vi.clearAllMocks();
  whereMock.mockResolvedValue([
    { id: "org-a", name: "Acme Inc" },
    { id: "org-b", name: "Beta LLC" },
  ]);
});

describe("extension-archive org-name resolver wiring", () => {
  it("installs a resolver (the wiring's side-effect import wires the slot)", () => {
    expect(typeof holder.resolver).toBe("function");
  });

  it("maps org ids → names from the betterAuth organization table", async () => {
    const names = await holder.resolver!(["org-a", "org-b"]);
    expect(names).toEqual(
      new Map([
        ["org-a", "Acme Inc"],
        ["org-b", "Beta LLC"],
      ]),
    );
  });

  it("an empty input short-circuits without touching the store", async () => {
    const names = await holder.resolver!([]);
    expect(names).toEqual(new Map());
    expect(whereMock).not.toHaveBeenCalled();
  });

  it("skips rows with a blank/absent name (id-only fallback for that org)", async () => {
    whereMock.mockResolvedValueOnce([
      { id: "org-a", name: "Acme Inc" },
      { id: "org-b", name: "" },
    ]);
    const names = await holder.resolver!(["org-a", "org-b"]);
    expect(names).toEqual(new Map([["org-a", "Acme Inc"]]));
  });
});
