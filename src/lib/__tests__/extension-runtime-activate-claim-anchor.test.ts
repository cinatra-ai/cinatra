import { beforeEach, describe, expect, it, vi } from "vitest";

// INSTALL-ANCHOR CLAIM ACTIVATION wiring (cinatra#1493): after a FINALIZED
// artifact install whose bridge rescan registered the package,
// `runHostExtensionInstallAndActivate` fires the idempotent claim-activation
// hook — and NOTHING the hook does (a conflict outcome, a manifest-read null,
// a hard throw) may surface as `finalized:false`, which would make the
// dispatcher roll back a genuinely-successful install.

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(),
}));
vi.mock("@/lib/extension-install-anchor", () => ({
  pickSingleActiveRow: vi.fn(),
}));
vi.mock("@/lib/extension-install-pipeline", () => ({
  installExtensionFromRegistry: vi.fn(),
  makeDefaultInstallPipelineDeps: vi.fn(async () => ({})),
}));
vi.mock("@/lib/extension-package-store-core", () => ({
  isExtensionStoreKind: vi.fn(() => true),
}));
vi.mock("@/lib/extension-artifact-bridge-rescan", () => ({
  rescanArtifactBridgeFromStore: vi.fn(),
}));
vi.mock("@/lib/objects/artifact-claim-install-anchor", () => ({
  readInstallAnchorManifestClaims: vi.fn(),
  runInstallAnchorClaimActivation: vi.fn(),
}));

import { readInstalledExtensionsByPackageName } from "@cinatra-ai/extensions/canonical-store";
import { pickSingleActiveRow } from "@/lib/extension-install-anchor";
import { installExtensionFromRegistry } from "@/lib/extension-install-pipeline";
import { rescanArtifactBridgeFromStore } from "@/lib/extension-artifact-bridge-rescan";
import {
  readInstallAnchorManifestClaims,
  runInstallAnchorClaimActivation,
} from "@/lib/objects/artifact-claim-install-anchor";
import { runHostExtensionInstallAndActivate } from "@/lib/extension-runtime-activate";

const PKG = "@v/pkg-artifact";
const ROW = {
  id: "row-1",
  kind: "artifact",
  organizationId: "org-1",
  source: { type: "verdaccio", version: "1.0.0" },
};
const PIPELINE_RESULT = {
  packageName: PKG,
  version: "1.0.0",
  storeDir: "/data/artifact/pkg/digest",
  digest: "d",
  integrity: "i",
  contentHash: "h",
  requestedPorts: [],
  grantStatus: "approved",
  installed: true,
  activated: false,
};
const CLAIMS = [{ type: "@v/pkg:thing", claim: "dedicated" as const }];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readInstalledExtensionsByPackageName).mockResolvedValue([ROW] as never);
  vi.mocked(pickSingleActiveRow).mockReturnValue(ROW as never);
  vi.mocked(installExtensionFromRegistry).mockResolvedValue(PIPELINE_RESULT as never);
  vi.mocked(rescanArtifactBridgeFromStore).mockResolvedValue({
    registered: [PKG],
    registeredRecords: [{ packageName: PKG, storeDir: "/store/dir" }],
    skippedNotActive: [],
  });
  vi.mocked(readInstallAnchorManifestClaims).mockResolvedValue(CLAIMS as never);
  vi.mocked(runInstallAnchorClaimActivation).mockReturnValue({
    outcome: "activated",
    activatedClaims: 1,
    replayedOperationIds: [],
  });
});

describe("runHostExtensionInstallAndActivate — claim-activation anchor (cinatra#1493)", () => {
  it("fires the hook after a finalized artifact install the rescan registered", async () => {
    const res = await runHostExtensionInstallAndActivate(PKG, "org-1");
    expect(res.finalized).toBe(true);
    expect(readInstallAnchorManifestClaims).toHaveBeenCalledWith(PIPELINE_RESULT.storeDir);
    expect(runInstallAnchorClaimActivation).toHaveBeenCalledWith({
      scope: "org:org-1",
      extensionPackage: PKG,
      extensionVersion: "1.0.0",
      installId: "row-1",
      claims: CLAIMS,
    });
  });

  it("records the pipeline's RESOLVED version, never a requested dist-tag", async () => {
    vi.mocked(installExtensionFromRegistry).mockResolvedValue({
      ...PIPELINE_RESULT,
      version: "1.2.3",
    } as never);
    await runHostExtensionInstallAndActivate(PKG, "org-1", "latest");
    expect(runInstallAnchorClaimActivation).toHaveBeenCalledWith(
      expect.objectContaining({ extensionVersion: "1.2.3" }),
    );
  });

  it("a platform-scoped row (organizationId null) activates at 'platform' scope", async () => {
    vi.mocked(pickSingleActiveRow).mockReturnValue({ ...ROW, organizationId: null } as never);
    await runHostExtensionInstallAndActivate(PKG, null);
    expect(runInstallAnchorClaimActivation).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "platform" }),
    );
  });

  it("does NOT fire when the rescan did not register the package (fail-closed skip)", async () => {
    vi.mocked(rescanArtifactBridgeFromStore).mockResolvedValue({
      registered: [],
      registeredRecords: [],
      skippedNotActive: [PKG],
    });
    const res = await runHostExtensionInstallAndActivate(PKG, "org-1");
    expect(res.finalized).toBe(true);
    expect(runInstallAnchorClaimActivation).not.toHaveBeenCalled();
  });

  it("does NOT fire for a non-artifact kind", async () => {
    vi.mocked(pickSingleActiveRow).mockReturnValue({ ...ROW, kind: "connector" } as never);
    await runHostExtensionInstallAndActivate(PKG, "org-1");
    expect(rescanArtifactBridgeFromStore).not.toHaveBeenCalled();
    expect(runInstallAnchorClaimActivation).not.toHaveBeenCalled();
  });

  it("a 'failed' (conflict) hook outcome never fails the pipeline result", async () => {
    vi.mocked(runInstallAnchorClaimActivation).mockReturnValue({
      outcome: "failed",
      conflict: true,
      reason: "conflict @v/pkg:thing@org:org-1",
    });
    const res = await runHostExtensionInstallAndActivate(PKG, "org-1");
    expect(res.finalized).toBe(true);
    expect(res.reason ?? "").not.toMatch(/pipeline-threw/);
  });

  it("a hook module THROW never fails the pipeline result (finalized stays true)", async () => {
    vi.mocked(readInstallAnchorManifestClaims).mockRejectedValue(new Error("manifest exploded"));
    const res = await runHostExtensionInstallAndActivate(PKG, "org-1");
    expect(res.finalized).toBe(true);
    expect(res.reason ?? "").not.toMatch(/pipeline-threw/);
  });

  it("a null manifest read (belt-and-braces) skips activation without failing", async () => {
    vi.mocked(readInstallAnchorManifestClaims).mockResolvedValue(null);
    const res = await runHostExtensionInstallAndActivate(PKG, "org-1");
    expect(res.finalized).toBe(true);
    expect(runInstallAnchorClaimActivation).not.toHaveBeenCalled();
  });
});
