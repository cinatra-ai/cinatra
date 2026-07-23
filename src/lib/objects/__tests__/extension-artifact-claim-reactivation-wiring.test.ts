import { beforeEach, describe, expect, it, vi } from "vitest";

// Host wiring of the FAIL-CLOSED artifact claim-REACTIVATION hook (cinatra#1837
// R3). Proves the restore composition driven through the SAME wired hook the
// dispatcher fires: register the restored type surface (bridge-semantic, so the
// activation gate can resolve a validator on the still-archived row) → read the
// current manifest claims → reactivate through the install-anchor activation →
// on failure, a FRESH-op compensation + conditional de-register + THROW so the
// restore aborts (no active-row-with-dead-claims). The heavy deps are mocked;
// `@cinatra-ai/extensions` is a light stub that CAPTURES the hook the wiring
// installs.

vi.mock("@/lib/objects/artifact-claim-lifecycle", () => ({
  retireArtifactExtensionClaims: vi.fn(() => ({
    operationId: "comp-op",
    archivedAssertions: 0,
    processedArtifacts: 0,
    retiredClaims: [],
    resumedOperationIds: [],
  })),
  // Imported statically by the consolidated wiring module (for the all-scopes
  // hook); unused by these reactivation tests.
  retireArtifactExtensionClaimsAllScopes: vi.fn(() => ({
    retiredScopes: [],
    deferredScopes: [],
    totalRetiredClaims: 0,
    totalArchivedAssertions: 0,
    perScope: [],
  })),
}));
vi.mock("@/lib/objects/artifact-claim-install-anchor", () => ({
  runInstallAnchorClaimActivation: vi.fn(() => ({
    outcome: "activated",
    activatedClaims: 1,
    replayedOperationIds: [],
  })),
  readInstallAnchorManifestClaims: vi.fn(async () => [{ type: "@v/pkg:one", claim: "dedicated" }]),
  resolveRegisteredTypeValidator: vi.fn(() => () => true),
}));
vi.mock("@/lib/extension-artifact-bridge-rescan", () => ({
  rescanArtifactBridgeFromStore: vi.fn(async () => ({
    registered: ["@v/pkg-artifact"],
    registeredRecords: [{ packageName: "@v/pkg-artifact", storeDir: "/store/@v/pkg-artifact/deadbeef" }],
    skippedNotActive: [],
  })),
}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  // Default: no live sibling (the archived row being restored is the only row).
  readInstalledExtensionsByPackageName: vi.fn(async () => [
    { packageName: "@v/pkg-artifact", organizationId: "org-9", status: "archived" },
  ]),
}));
vi.mock("@cinatra-ai/objects", () => ({
  objectTypeRegistry: { removeByPackage: vi.fn() },
  // cinatra#1891 A3: the restore-abort compensation reaps the matcher-manifest
  // channel entry at parity with the object types (deregisterIfOwned).
  matcherManifestRegistry: { removeByPackage: vi.fn() },
}));

type ReactivationHook = (input: {
  packageName: string;
  organizationId: string | null | undefined;
  extensionVersion: string;
  installId?: string | null;
  actorPrincipalId?: string;
}) => unknown | Promise<unknown>;
const holder = vi.hoisted(() => ({ hook: null as ReactivationHook | null }));
vi.mock("@cinatra-ai/extensions", () => ({
  setExtensionArtifactClaimReactivationHook: (hook: ReactivationHook | null) => {
    holder.hook = hook;
  },
  // The consolidated wiring module also installs the archival + all-scopes hooks;
  // capture them into no-op setters (these tests only exercise reactivation).
  setExtensionArtifactClaimArchivalHook: () => {},
  setExtensionArtifactClaimArchivalAllScopesHook: () => {},
  // The consolidated wiring module also installs the best-effort org-name
  // resolver (OWNER RULING 2026-07-22); capture into a no-op setter.
  setExtensionArchiveOrgNameResolver: () => {},
}));

// The reactivation hook is installed by the CONSOLIDATED archival wiring module
// (cinatra#1837 — co-located so it adds no module to the route graph).
import "@/lib/objects/extension-artifact-claim-archival-wiring";

import { retireArtifactExtensionClaims } from "@/lib/objects/artifact-claim-lifecycle";
import {
  readInstallAnchorManifestClaims,
  runInstallAnchorClaimActivation,
} from "@/lib/objects/artifact-claim-install-anchor";
import { rescanArtifactBridgeFromStore } from "@/lib/extension-artifact-bridge-rescan";
import { objectTypeRegistry } from "@cinatra-ai/objects";
import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runInstallAnchorClaimActivation).mockReturnValue({
    outcome: "activated",
    activatedClaims: 1,
    replayedOperationIds: [],
  } as never);
  vi.mocked(readInstallAnchorManifestClaims).mockResolvedValue([
    { type: "@v/pkg:one", claim: "dedicated" },
  ]);
  vi.mocked(rescanArtifactBridgeFromStore).mockResolvedValue({
    registered: ["@v/pkg-artifact"],
    registeredRecords: [{ packageName: "@v/pkg-artifact", storeDir: "/store/@v/pkg-artifact/deadbeef" }],
    skippedNotActive: [],
  } as never);
  vi.mocked(readInstalledExtensionsByPackageName).mockResolvedValue([
    { packageName: "@v/pkg-artifact", organizationId: "org-9", status: "archived" },
  ] as never);
});

describe("extension-artifact-claim-reactivation-wiring", () => {
  it("installs a hook (the wiring's side-effect import wires the slot)", () => {
    expect(typeof holder.hook).toBe("function");
  });

  it("SYNCHRONOUS reactivation: registers the type surface, then activates the current claims (no boot cycle)", async () => {
    await holder.hook!({
      packageName: "@v/pkg-artifact",
      organizationId: "org-9",
      extensionVersion: "2.0.0",
      installId: "iext_9",
      actorPrincipalId: "user-3",
    });
    // Type surface registered FIRST via the restore exception (so the activation
    // gate resolves the validator on the still-archived row) — scoped to this pkg.
    expect(rescanArtifactBridgeFromStore).toHaveBeenCalledWith({
      onlyPackage: "@v/pkg-artifact",
      restorePackage: "@v/pkg-artifact",
    });
    // Claims read from the SAME registered store dir, then reactivated.
    expect(readInstallAnchorManifestClaims).toHaveBeenCalledWith("/store/@v/pkg-artifact/deadbeef");
    expect(runInstallAnchorClaimActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "org:org-9",
        extensionPackage: "@v/pkg-artifact",
        extensionVersion: "2.0.0",
        installId: "iext_9",
        claims: [{ type: "@v/pkg:one", claim: "dedicated" }],
      }),
    );
    // Success ⇒ NO compensation, NO de-register.
    expect(retireArtifactExtensionClaims).not.toHaveBeenCalled();
    expect(objectTypeRegistry.removeByPackage).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED: a failed reactivation runs a FRESH-op compensation + de-registers (no live sibling) + THROWS", async () => {
    vi.mocked(runInstallAnchorClaimActivation).mockReturnValue({
      outcome: "failed",
      conflict: false,
      reason: "gate blocked",
    } as never);
    await expect(
      (async () =>
        holder.hook!({
          packageName: "@v/pkg-artifact",
          organizationId: "org-9",
          extensionVersion: "2.0.0",
        }))(),
    ).rejects.toThrow(/reactivation failed/i);
    // Fresh-op compensation re-archives any partial replay + re-retires the claims.
    expect(retireArtifactExtensionClaims).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "org:org-9", extensionPackage: "@v/pkg-artifact" }),
    );
    // No live sibling (the only row is the archived one) ⇒ de-register the surface.
    expect(objectTypeRegistry.removeByPackage).toHaveBeenCalledWith("@v/pkg-artifact");
  });

  it("does NOT de-register on abort when a LIVE SIBLING relies on the surface (R2-4)", async () => {
    vi.mocked(readInstalledExtensionsByPackageName).mockResolvedValue([
      { packageName: "@v/pkg-artifact", organizationId: "org-9", status: "archived" },
      { packageName: "@v/pkg-artifact", organizationId: "org-2", status: "active" }, // live sibling
    ] as never);
    vi.mocked(runInstallAnchorClaimActivation).mockReturnValue({
      outcome: "failed",
      conflict: false,
      reason: "gate blocked",
    } as never);
    await expect(
      (async () =>
        holder.hook!({ packageName: "@v/pkg-artifact", organizationId: "org-9", extensionVersion: "2.0.0" }))(),
    ).rejects.toThrow(/reactivation failed/i);
    expect(retireArtifactExtensionClaims).toHaveBeenCalled();
    expect(objectTypeRegistry.removeByPackage).not.toHaveBeenCalled();
  });

  it("FAIL-CLOSED on an EMPTY-STRING organizationId (malformed; nothing registered)", async () => {
    await expect(
      (async () => holder.hook!({ packageName: "@v/pkg-artifact", organizationId: "", extensionVersion: "2.0.0" }))(),
    ).rejects.toThrow(/empty organizationId/i);
    expect(rescanArtifactBridgeFromStore).not.toHaveBeenCalled();
    expect(runInstallAnchorClaimActivation).not.toHaveBeenCalled();
  });

  it("OWNER RULING: a NULL-org restore reactivates at the PLATFORM claim scope (symmetric with the ruled platform archive)", async () => {
    // The dispatcher's org-install refusal has already gated this (a platform
    // restore reaches the wiring only once no org still has the extension
    // installed), so the platform reactivation runs.
    await holder.hook!({
      packageName: "@v/pkg-artifact",
      organizationId: null,
      extensionVersion: "2.0.0",
      installId: "iext_plat",
      actorPrincipalId: "user-3",
    });
    expect(rescanArtifactBridgeFromStore).toHaveBeenCalledWith({
      onlyPackage: "@v/pkg-artifact",
      restorePackage: "@v/pkg-artifact",
    });
    expect(runInstallAnchorClaimActivation).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "platform", extensionPackage: "@v/pkg-artifact" }),
    );
  });

  it("FAIL-CLOSED when no store record can be registered (missing/unresolved schema)", async () => {
    vi.mocked(rescanArtifactBridgeFromStore).mockResolvedValue({
      registered: [],
      registeredRecords: [],
      skippedNotActive: [],
    } as never);
    await expect(
      (async () => holder.hook!({ packageName: "@v/pkg-artifact", organizationId: "org-9", extensionVersion: "2.0.0" }))(),
    ).rejects.toThrow(/could not register the restored type surface/i);
    expect(runInstallAnchorClaimActivation).not.toHaveBeenCalled();
  });
});
