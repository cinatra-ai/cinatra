import { beforeEach, describe, expect, it, vi } from "vitest";

// Claim-lifecycle orchestration (cinatra#1432, epic #1424) — the host-side
// composition that ties an artifact extension's manifest objectTypes claims to
// the claim registry (#1425) + the replayable uninstall store. The two stores
// are mocked; this pins the COMPOSITION:
//   AC-1: install reserves -> activates each claim in order; a DEDICATED
//         conflict propagates as the install error AND retires the claims this
//         install already activated (no partial winner set).
//   AC-2: uninstall opens an operation, archives, then retires the live claims;
//         reinstall replays the owed operation then activates the CURRENT
//         manifest claims (type-changed-while-absent = current claims win).

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
  beginArtifactUninstallOperation: vi.fn(() => "op1"),
  runArtifactUninstallArchival: vi.fn(() => ({ archivedAssertions: 0, processedArtifacts: 0 })),
  findReplayableUninstallOperation: vi.fn(() => null),
  replayArtifactUninstallOperation: vi.fn(() => ({ insertedAssertions: 0, skipped: 0 })),
}));

import {
  ArtifactClaimConflictError,
  activateArtifactTypeClaim,
  beginArtifactTypeClaimRetirement,
  finalizeArtifactTypeClaimRetirement,
  readArtifactTypeClaimsForExtension,
  reserveArtifactTypeClaim,
} from "@/lib/objects/artifact-claim-store";
import {
  beginArtifactUninstallOperation,
  findReplayableUninstallOperation,
  replayArtifactUninstallOperation,
  runArtifactUninstallArchival,
} from "@/lib/objects/artifact-uninstall-operations";
import {
  activateArtifactExtensionClaims,
  replayArtifactExtensionReinstall,
  retireArtifactExtensionClaims,
} from "@/lib/objects/artifact-claim-lifecycle";

const CTX = {
  scope: "org:org-1",
  extensionPackage: "@v/pkg-artifact",
  extensionVersion: "1.0.0",
  actor: "user-1",
  installId: "inst-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(activateArtifactTypeClaim).mockReturnValue({ changed: true });
  vi.mocked(beginArtifactTypeClaimRetirement).mockReturnValue({ changed: true });
  vi.mocked(finalizeArtifactTypeClaimRetirement).mockReturnValue({ changed: true });
  vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([]);
  vi.mocked(beginArtifactUninstallOperation).mockReturnValue("op1");
  vi.mocked(runArtifactUninstallArchival).mockReturnValue({ archivedAssertions: 0, processedArtifacts: 0 });
  vi.mocked(findReplayableUninstallOperation).mockReturnValue(null);
  vi.mocked(replayArtifactUninstallOperation).mockReturnValue({ insertedAssertions: 0, skipped: 0 });
});

describe("activateArtifactExtensionClaims (AC-1 install)", () => {
  it("reserves then activates each claim in order and returns their ids", () => {
    vi.mocked(reserveArtifactTypeClaim).mockReturnValueOnce("c1").mockReturnValueOnce("c2");
    const activated = activateArtifactExtensionClaims(CTX, [
      { type: "@v/pkg:one", claim: "dedicated", dispositions: { projection: "artifact-safe" } },
      { type: "@v/pkg:two", claim: "default" },
    ]);
    expect(activated).toEqual([
      { claimId: "c1", type: "@v/pkg:one", claim: "dedicated" },
      { claimId: "c2", type: "@v/pkg:two", claim: "default" },
    ]);
    expect(reserveArtifactTypeClaim).toHaveBeenNthCalledWith(1, expect.objectContaining({
      scope: "org:org-1",
      objectTypeId: "@v/pkg:one",
      claimKind: "dedicated",
      extensionPackage: "@v/pkg-artifact",
      dispositions: { projection: "artifact-safe" },
    }));
    expect(activateArtifactTypeClaim).toHaveBeenNthCalledWith(1, { claimId: "c1", actor: "user-1" });
    expect(activateArtifactTypeClaim).toHaveBeenNthCalledWith(2, { claimId: "c2", actor: "user-1" });
  });

  it("a DEDICATED conflict propagates AND retires the already-activated claims (no partial set)", () => {
    vi.mocked(reserveArtifactTypeClaim)
      .mockReturnValueOnce("c1")
      .mockImplementationOnce(() => {
        throw new ArtifactClaimConflictError("org:org-1", "@v/pkg:two");
      });
    expect(() =>
      activateArtifactExtensionClaims(CTX, [
        { type: "@v/pkg:one", claim: "default", dispositions: { projection: "none" } },
        { type: "@v/pkg:two", claim: "dedicated" },
      ]),
    ).toThrow(ArtifactClaimConflictError);
    // c1 was activated then rolled back; c2 never reserved.
    expect(activateArtifactTypeClaim).toHaveBeenCalledTimes(1);
    expect(beginArtifactTypeClaimRetirement).toHaveBeenCalledWith({ claimId: "c1", actor: "user-1" });
    expect(finalizeArtifactTypeClaimRetirement).toHaveBeenCalledWith({ claimId: "c1", actor: "user-1" });
  });
});

describe("retireArtifactExtensionClaims (AC-2 uninstall)", () => {
  it("opens an operation, archives, then retires only the not-yet-retired claims", () => {
    vi.mocked(runArtifactUninstallArchival).mockReturnValue({ archivedAssertions: 3, processedArtifacts: 2 });
    vi.mocked(readArtifactTypeClaimsForExtension).mockReturnValue([
      { id: "c1", status: "active" } as never,
      { id: "c9", status: "retired" } as never,
    ]);
    vi.mocked(finalizeArtifactTypeClaimRetirement).mockReturnValue({ changed: true });

    const result = retireArtifactExtensionClaims(CTX);
    expect(beginArtifactUninstallOperation).toHaveBeenCalledWith({
      scope: "org:org-1",
      extensionPackage: "@v/pkg-artifact",
      extensionVersion: "1.0.0",
      actor: "user-1",
    });
    expect(runArtifactUninstallArchival).toHaveBeenCalledWith({ operationId: "op1", batchSize: undefined });
    // c1 retired; c9 (already retired) skipped.
    expect(beginArtifactTypeClaimRetirement).toHaveBeenCalledTimes(1);
    expect(beginArtifactTypeClaimRetirement).toHaveBeenCalledWith({ claimId: "c1", actor: "user-1" });
    expect(result).toEqual({
      operationId: "op1",
      archivedAssertions: 3,
      processedArtifacts: 2,
      retiredClaims: ["c1"],
    });
  });
});

describe("replayArtifactExtensionReinstall (AC-2 reinstall)", () => {
  it("replays the owed operation then activates the CURRENT manifest claims", () => {
    vi.mocked(findReplayableUninstallOperation).mockReturnValue({ id: "op1" } as never);
    vi.mocked(replayArtifactUninstallOperation).mockReturnValue({ insertedAssertions: 2, skipped: 1 });
    vi.mocked(reserveArtifactTypeClaim).mockReturnValueOnce("c-new");

    // Type CHANGED while absent: the current manifest claims a different type.
    const result = replayArtifactExtensionReinstall(CTX, [{ type: "@v/pkg:renamed", claim: "dedicated", schema: {} } as never]);

    expect(replayArtifactUninstallOperation).toHaveBeenCalledWith({
      operationId: "op1",
      installId: "inst-1",
      batchSize: undefined,
    });
    // Fresh activation uses the CURRENT type, not whatever was archived.
    expect(reserveArtifactTypeClaim).toHaveBeenCalledWith(
      expect.objectContaining({ objectTypeId: "@v/pkg:renamed", claimKind: "dedicated" }),
    );
    expect(result).toEqual({
      replayedOperationId: "op1",
      insertedAssertions: 2,
      skippedAssertions: 1,
      activated: [{ claimId: "c-new", type: "@v/pkg:renamed", claim: "dedicated" }],
    });
  });

  it("with no owed operation, is a plain install of the current claims", () => {
    vi.mocked(findReplayableUninstallOperation).mockReturnValue(null);
    vi.mocked(reserveArtifactTypeClaim).mockReturnValueOnce("c1");

    const result = replayArtifactExtensionReinstall(CTX, [{ type: "@v/pkg:one", claim: "default", schema: {} } as never]);
    expect(replayArtifactUninstallOperation).not.toHaveBeenCalled();
    expect(result.replayedOperationId).toBeNull();
    expect(result.insertedAssertions).toBe(0);
    expect(result.activated).toEqual([{ claimId: "c1", type: "@v/pkg:one", claim: "default" }]);
  });
});
