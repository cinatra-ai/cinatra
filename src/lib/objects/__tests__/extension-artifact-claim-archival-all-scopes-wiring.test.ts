import { beforeEach, describe, expect, it, vi } from "vitest";

// Host wiring of the FAIL-CLOSED ALL-SCOPES artifact claim-archival hook
// (cinatra#1837 R2). Proves the wiring reads the package's canonical-row scopes
// and hands them to the all-scopes primitive (which unions them with the store
// legs), and propagates a failure fail-closed. The primitive is mocked;
// `@cinatra-ai/extensions` is a light stub that CAPTURES the installed hook.

vi.mock("@/lib/objects/artifact-claim-lifecycle", () => ({
  retireArtifactExtensionClaimsAllScopes: vi.fn(() => ({
    retiredScopes: ["org:o1", "org:o2"],
    deferredScopes: ["platform"],
    totalRetiredClaims: 3,
    totalArchivedAssertions: 5,
    perScope: [],
  })),
  // Imported statically by the consolidated wiring module (for the archival
  // hook); unused by these all-scopes tests.
  retireArtifactExtensionClaims: vi.fn(() => ({
    operationId: null,
    archivedAssertions: 0,
    processedArtifacts: 0,
    retiredClaims: [],
    resumedOperationIds: [],
  })),
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(async () => [
    { packageName: "@v/pkg-artifact", organizationId: "o1" },
    { packageName: "@v/pkg-artifact", organizationId: "o2" },
    { packageName: "@v/pkg-artifact", organizationId: null }, // platform
  ]),
}));

type AllScopesHook = (input: {
  packageName: string;
  extensionVersion: string;
  actorPrincipalId?: string;
}) => unknown | Promise<unknown>;
const holder = vi.hoisted(() => ({ hook: null as AllScopesHook | null }));
vi.mock("@cinatra-ai/extensions", () => ({
  setExtensionArtifactClaimArchivalAllScopesHook: (hook: AllScopesHook | null) => {
    holder.hook = hook;
  },
  // The consolidated wiring module also installs the archival + reactivation
  // hooks; capture them into no-op setters (these tests only exercise all-scopes).
  setExtensionArtifactClaimArchivalHook: () => {},
  setExtensionArtifactClaimReactivationHook: () => {},
}));

// The all-scopes hook is installed by the CONSOLIDATED archival wiring module
// (cinatra#1837 — co-located so it adds no module to the route graph).
import "@/lib/objects/extension-artifact-claim-archival-wiring";

import { retireArtifactExtensionClaimsAllScopes } from "@/lib/objects/artifact-claim-lifecycle";
import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(retireArtifactExtensionClaimsAllScopes).mockReturnValue({
    retiredScopes: ["org:o1", "org:o2"],
    deferredScopes: ["platform"],
    totalRetiredClaims: 3,
    totalArchivedAssertions: 5,
    perScope: [],
  });
  vi.mocked(readInstalledExtensionsByPackageName).mockResolvedValue([
    { packageName: "@v/pkg-artifact", organizationId: "o1" },
    { packageName: "@v/pkg-artifact", organizationId: "o2" },
    { packageName: "@v/pkg-artifact", organizationId: null },
  ] as never);
});

describe("extension-artifact-claim-archival-all-scopes-wiring", () => {
  it("installs a hook (side-effect import)", () => {
    expect(typeof holder.hook).toBe("function");
  });

  it("passes the canonical-row scopes ('platform' | 'org:<id>') to the primitive", async () => {
    await holder.hook!({
      packageName: "@v/pkg-artifact",
      extensionVersion: "3.0.0",
      actorPrincipalId: "admin-1",
    });
    expect(retireArtifactExtensionClaimsAllScopes).toHaveBeenCalledWith({
      extensionPackage: "@v/pkg-artifact",
      extensionVersion: "3.0.0",
      actor: "admin-1",
      canonicalScopes: ["org:o1", "org:o2", "platform"],
    });
  });

  it("PROPAGATES a primitive failure (fail-closed — the destroy aborts)", async () => {
    vi.mocked(retireArtifactExtensionClaimsAllScopes).mockImplementation(() => {
      throw new Error("all-scopes leg failed");
    });
    await expect(
      (async () => holder.hook!({ packageName: "@v/pkg-artifact", extensionVersion: "3.0.0" }))(),
    ).rejects.toThrow("all-scopes leg failed");
  });

  it("degrades to the store legs (no throw) when the canonical-row read fails", async () => {
    vi.mocked(readInstalledExtensionsByPackageName).mockRejectedValue(new Error("db down"));
    await holder.hook!({ packageName: "@v/pkg-artifact", extensionVersion: "3.0.0" });
    // Still calls the primitive, with empty canonicalScopes (store legs cover it).
    expect(retireArtifactExtensionClaimsAllScopes).toHaveBeenCalledWith(
      expect.objectContaining({ canonicalScopes: [] }),
    );
  });
});
