import { beforeEach, describe, expect, it, vi } from "vitest";

// Host wiring of the FAIL-CLOSED artifact claim-archival lifecycle hook
// (cinatra#1454). Proves the WIRING (scope mapping + retire invocation) and the
// full install → rows → archive-extension → rows archived → reinstall arc the
// ratified "rows governed by extension lifecycle" disposition specifies, driven
// through the SAME wired hook the dispatcher fires. The two claim stores are
// mocked (as in artifact-claim-lifecycle.test.ts); `@cinatra-ai/extensions` is
// mocked to a light stub that CAPTURES the hook the wiring installs, so this test
// exercises the real wiring + real lifecycle composition without pulling the
// heavy extensions barrel.

vi.mock("@/lib/objects/artifact-claim-store", () => {
  class ArtifactClaimConflictError extends Error {
    constructor(
      public readonly scope: string,
      public readonly objectTypeId: string,
    ) {
      super(`conflict ${objectTypeId}@${scope}`);
      this.name = "ArtifactClaimConflictError";
    }
  }
  return {
    ArtifactClaimConflictError,
    reserveArtifactTypeClaim: vi.fn(),
    activateArtifactTypeClaim: vi.fn(() => ({ changed: true })),
    beginArtifactTypeClaimRetirement: vi.fn(() => ({ changed: true })),
    finalizeArtifactTypeClaimRetirement: vi.fn(() => ({ changed: true })),
    readArtifactTypeClaimsForExtension: vi.fn(() => []),
  };
});
vi.mock("@/lib/objects/artifact-uninstall-operations", () => ({
  acquireArtifactRetirementOperation: vi.fn(() => ({ action: "done" })),
  enumerateRetirableScopesFromStores: vi.fn(() => []),
  beginArtifactUninstallOperation: vi.fn(() => "op1"),
  runArtifactUninstallArchival: vi.fn(() => ({ archivedAssertions: 0, processedArtifacts: 0 })),
  findReplayableUninstallOperation: vi.fn(() => null),
  replayArtifactUninstallOperation: vi.fn(() => ({ insertedAssertions: 0, skipped: 0 })),
}));
// The claim-activation gate (cinatra#1429) is a no-op basis here (no resolver
// supplied to the lifecycle ctx below), but the lifecycle module imports it.
vi.mock("@/lib/objects/claim-activation-gate", () => ({
  assertClaimActivatable: vi.fn(),
}));

// Capture the hook the wiring installs — stand in for the extensions barrel.
// `vi.hoisted` so the (hoisted) vi.mock factory may reference the holder.
type ArchivalHook = (input: {
  packageName: string;
  organizationId: string | null | undefined;
  extensionVersion: string;
  installId?: string | null;
  actorPrincipalId?: string;
}) => unknown | Promise<unknown>;
const holder = vi.hoisted(() => ({ hook: null as ArchivalHook | null }));
vi.mock("@cinatra-ai/extensions", () => ({
  setExtensionArtifactClaimArchivalHook: (hook: ArchivalHook | null) => {
    holder.hook = hook;
  },
  // The consolidated wiring module also installs the reactivation + all-scopes
  // hooks (cinatra#1837); this test only exercises the ARCHIVAL hook, so capture
  // the others into no-op setters so the module's wire calls resolve.
  setExtensionArtifactClaimReactivationHook: () => {},
  setExtensionArtifactClaimArchivalAllScopesHook: () => {},
}));

// Import the wiring ONCE (side-effect: installs the hook onto the captured slot).
import "@/lib/objects/extension-artifact-claim-archival-wiring";

import {
  acquireArtifactRetirementOperation,
  findReplayableUninstallOperation,
  replayArtifactUninstallOperation,
  runArtifactUninstallArchival,
} from "@/lib/objects/artifact-uninstall-operations";
import {
  activateArtifactTypeClaim,
  finalizeArtifactTypeClaimRetirement,
  readArtifactTypeClaimsForExtension,
  reserveArtifactTypeClaim,
} from "@/lib/objects/artifact-claim-store";
import {
  activateArtifactExtensionClaims,
  replayArtifactExtensionReinstall,
} from "@/lib/objects/artifact-claim-lifecycle";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(activateArtifactTypeClaim).mockReturnValue({ changed: true } as never);
  vi.mocked(finalizeArtifactTypeClaimRetirement).mockReturnValue({ changed: true } as never);
  vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([]);
  vi.mocked(acquireArtifactRetirementOperation).mockReturnValue({ action: "done" });
  vi.mocked(runArtifactUninstallArchival).mockReturnValue({ archivedAssertions: 0, processedArtifacts: 0 });
  vi.mocked(findReplayableUninstallOperation).mockReturnValue(null);
  vi.mocked(replayArtifactUninstallOperation).mockReturnValue({ insertedAssertions: 0, skipped: 0 });
});

describe("extension-artifact-claim-archival-wiring — scope mapping", () => {
  it("installs a hook (the wiring's side-effect import wires the slot)", () => {
    expect(typeof holder.hook).toBe("function");
  });

  it("maps a non-null organizationId to the org:<id> claim scope and retires", async () => {
    vi.mocked(acquireArtifactRetirementOperation)
      .mockReturnValueOnce({ action: "begin", operationId: "op1" })
      .mockReturnValue({ action: "done" });
    vi.mocked(runArtifactUninstallArchival).mockReturnValue({ archivedAssertions: 4, processedArtifacts: 2 });
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([
      { id: "c1", status: "active" } as never,
    ]);
    await holder.hook!({
      packageName: "@v/pkg-artifact",
      organizationId: "org-9",
      extensionVersion: "1.2.3",
      installId: "iext_9",
      actorPrincipalId: "user-3",
    });
    expect(acquireArtifactRetirementOperation).toHaveBeenCalledWith({
      scope: "org:org-9",
      extensionPackage: "@v/pkg-artifact",
      extensionVersion: "1.2.3",
      actor: "user-3",
    });
    expect(runArtifactUninstallArchival).toHaveBeenCalledWith({ operationId: "op1", batchSize: undefined });
    // The one live claim is retired (finalize CAS returns changed).
    expect(finalizeArtifactTypeClaimRetirement).toHaveBeenCalledWith({ claimId: "c1", actor: "user-3" });
  });

  it("maps a null organizationId to the platform claim scope", async () => {
    await holder.hook!({
      packageName: "@v/pkg-artifact",
      organizationId: null,
      extensionVersion: "1.0.0",
    });
    expect(acquireArtifactRetirementOperation).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "platform", actor: "system" }),
    );
  });

  it("FAIL-CLOSED on an EMPTY organizationId (would map to a cross-org platform sweep)", async () => {
    await expect(
      (async () =>
        holder.hook!({
          packageName: "@v/pkg-artifact",
          organizationId: "",
          extensionVersion: "1.0.0",
        }))(),
    ).rejects.toThrow(/empty organizationId/i);
    expect(acquireArtifactRetirementOperation).not.toHaveBeenCalled();
  });

  it("PROPAGATES a store failure (fail-closed — the seam aborts the archive)", async () => {
    vi.mocked(acquireArtifactRetirementOperation).mockImplementation(() => {
      throw new Error("uninstall-operation acquire failed");
    });
    // The wired closure is sync (the lifecycle leaf is sync); the dispatcher
    // fires it as `await hook(input)`, so a sync throw surfaces as a rejection
    // that aborts the archive. Mirror that call shape here.
    await expect(
      (async () =>
        holder.hook!({
          packageName: "@v/pkg-artifact",
          organizationId: "org-1",
          extensionVersion: "1.0.0",
        }))(),
    ).rejects.toThrow("uninstall-operation acquire failed");
  });
});

describe("install → rows → archive-extension → rows archived → reinstall", () => {
  it("archive (via the wired hook) opens the uninstall operation whose reinstall replays the archived rows", async () => {
    const ctx = {
      scope: "org:org-1",
      extensionPackage: "@v/pkg-artifact",
      extensionVersion: "1.0.0",
      actor: "user-1",
      installId: "iext_1",
    };

    // INSTALL: activate the manifest claim (governs the artifact rows).
    vi.mocked(reserveArtifactTypeClaim).mockReturnValueOnce("c1");
    const activated = activateArtifactExtensionClaims(ctx, [
      { type: "@v/pkg:one", claim: "dedicated" },
    ]);
    expect(activated).toEqual([{ claimId: "c1", type: "@v/pkg:one", claim: "dedicated" }]);

    // ARCHIVE the extension via the WIRED hook (what the dispatcher fires):
    // acquires the uninstall operation, archives the governed rows, retires the claim.
    vi.mocked(acquireArtifactRetirementOperation)
      .mockReturnValueOnce({ action: "begin", operationId: "op1" })
      .mockReturnValue({ action: "done" });
    vi.mocked(runArtifactUninstallArchival).mockReturnValue({ archivedAssertions: 3, processedArtifacts: 2 });
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([{ id: "c1", status: "active" } as never]);
    await holder.hook!({
      packageName: "@v/pkg-artifact",
      organizationId: "org-1",
      extensionVersion: "1.0.0",
      installId: "iext_1",
      actorPrincipalId: "user-1",
    });
    expect(acquireArtifactRetirementOperation).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "org:org-1", extensionPackage: "@v/pkg-artifact" }),
    );
    expect(runArtifactUninstallArchival).toHaveBeenCalledWith({ operationId: "op1", batchSize: undefined });
    expect(finalizeArtifactTypeClaimRetirement).toHaveBeenCalledWith({ claimId: "c1", actor: "user-1" });

    // REINSTALL: the archive left an owed operation; reinstall replays exactly the
    // archived rows, then activates the CURRENT manifest claims.
    vi.mocked(findReplayableUninstallOperation).mockReturnValue({ id: "op1" } as never);
    vi.mocked(replayArtifactUninstallOperation).mockReturnValue({ insertedAssertions: 3, skipped: 0 });
    vi.mocked(reserveArtifactTypeClaim).mockReturnValueOnce("c1b");
    const reinstall = replayArtifactExtensionReinstall(ctx, [{ type: "@v/pkg:one", claim: "dedicated" }]);
    expect(replayArtifactUninstallOperation).toHaveBeenCalledWith({
      operationId: "op1",
      installId: "iext_1",
      batchSize: undefined,
    });
    expect(reinstall).toEqual({
      replayedOperationId: "op1",
      insertedAssertions: 3,
      skippedAssertions: 0,
      activated: [{ claimId: "c1b", type: "@v/pkg:one", claim: "dedicated" }],
    });
  });
});
