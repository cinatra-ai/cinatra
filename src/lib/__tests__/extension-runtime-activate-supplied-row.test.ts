/**
 * THE ACTIVATE HOOK NO LONGER REFUSES A SUPPLIED ROW OUTRIGHT (cinatra#3204 D1).
 *
 * The hook used to answer `non-verdaccio-source` to every row whose source was
 * not `verdaccio`, so a supplied package could not be driven through the
 * pipeline at all. It now routes a supplied row that carries a well-formed
 * CONTENT DIGEST to the supplied entry.
 *
 * The gate is the DIGEST, not the source type, and these tests are mostly about
 * that distinction: every local/github row that exists today carries no content
 * digest, so it must still take the old refusal, byte for byte. A change that
 * opened the hook to source TYPE would pass a happy-path test and silently start
 * driving rows the handler owns.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.fn(async (_packageName?: string) => [] as unknown[]);
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (p: string) => rows(p),
}));

vi.mock("@/lib/extension-install-anchor", () => ({
  pickSingleActiveRow: (r: unknown[]) => r[0] ?? null,
  pickSingleWorkspaceAnchoredActiveRow: (r: unknown[]) => r[0] ?? null,
}));

const readSuppliedSnapshot = vi.fn(async (_source?: unknown) => new Uint8Array([1, 2, 3]));
vi.mock("@/lib/extension-package-store", () => ({
  readSuppliedSnapshot: (s: unknown) => readSuppliedSnapshot(s),
  resolveSuppliedSnapshotRoot: () => "/data/extension-uploads",
}));

const installFromSupplied = vi.fn(
  async (_input: unknown, _deps: unknown) =>
    ({ installed: true, activated: false, reason: "metadata-only-kind" }) as {
      installed: boolean;
      activated: boolean;
      reason?: string;
    },
);
const installFromRegistry = vi.fn(async (_input: unknown, _deps: unknown) => ({
  installed: true,
  activated: true,
}));
vi.mock("@/lib/extension-install-pipeline", () => ({
  installExtensionFromSuppliedSnapshot: (i: unknown, d: unknown) => installFromSupplied(i, d),
  installExtensionFromRegistry: (i: unknown, d: unknown) => installFromRegistry(i, d),
  makeDefaultInstallPipelineDeps: async () => ({}),
}));
vi.mock("@/lib/extension-install-pipeline-deps", () => ({
  makeDefaultSuppliedInstallPipelineDeps: async () => ({}),
}));

// The artifact kind's POST-INSTALL projection — the work that turns a finalized
// artifact install into an object type this process can actually render and list.
const rescan = vi.fn(async (_o?: unknown) => ({ registered: [PKG_ARTIFACT], registeredRecords: [] }));
vi.mock("@/lib/extension-artifact-bridge-rescan", () => ({
  rescanArtifactBridgeFromStore: (o: unknown) => rescan(o),
}));
const admitRenderers = vi.fn(async (_o?: unknown) => [] as unknown[]);
vi.mock("@/lib/artifacts/admit-runtime-artifact-renderers", () => ({
  admitRuntimeArtifactRenderersForStoreDir: (o: unknown) => admitRenderers(o),
}));
const bindProviders = vi.fn((_o?: unknown) => 0);
vi.mock("@/lib/artifacts/system-artifact-renderer-registrar", () => ({
  bindActivatedRepresentationProvidersForInstall: (o: unknown) => bindProviders(o),
}));
const readClaims = vi.fn(async (_d?: unknown) => null as unknown);
const runClaimActivation = vi.fn((_o?: unknown) => ({ outcome: "activated" }));
vi.mock("@/lib/objects/artifact-claim-install-anchor", () => ({
  readInstallAnchorManifestClaims: (d: unknown) => readClaims(d),
  runInstallAnchorClaimActivation: (o: unknown) => runClaimActivation(o),
}));

import { runHostExtensionInstallAndActivate } from "@/lib/extension-runtime-activate";

const DIGEST = "a".repeat(64);
const PKG = "@acme/thing-skill";
const PKG_ARTIFACT = "@acme/thing-artifact";

const row = (
  source: unknown,
  kind = "skill",
  extra: { organizationId?: string | null; version?: string | null } = {},
) => ({
  id: "iext_1",
  packageName: PKG,
  kind,
  status: "active",
  organizationId: null as string | null,
  source,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  installFromSupplied.mockResolvedValue({ installed: true, activated: false, reason: "metadata-only-kind" });
  readSuppliedSnapshot.mockResolvedValue(new Uint8Array([1, 2, 3]));
  rescan.mockResolvedValue({ registered: [PKG_ARTIFACT], registeredRecords: [] });
  admitRenderers.mockResolvedValue([]);
  readClaims.mockResolvedValue(null);
});

describe("a SUPPLIED row carrying a content digest is driven, not refused", () => {
  it("routes a local row with a digest to the supplied entry and reports finalized", async () => {
    rows.mockResolvedValue([
      row({ type: "local", path: "snapshots/x.tgz", resolvedCommitOrTreeHash: DIGEST, contentDigest: DIGEST }),
    ]);
    const result = await runHostExtensionInstallAndActivate(PKG, null, "1.0.0");
    expect(installFromSupplied).toHaveBeenCalledTimes(1);
    expect(installFromRegistry).not.toHaveBeenCalled();
    expect(result.finalized).toBe(true);
    expect(result.reason).not.toBe("non-verdaccio-source");
  });

  it("passes the row's HONEST provenance through to the entry", async () => {
    rows.mockResolvedValue([
      row({
        type: "github",
        repo: "owner/repo",
        ref: "v1",
        resolvedSha: "b".repeat(40),
        path: "snapshots/gh.tgz",
        contentDigest: DIGEST,
      }),
    ]);
    await runHostExtensionInstallAndActivate(PKG, null, "1.0.0");
    const input = installFromSupplied.mock.calls[0]?.[0] as unknown as {
      supplied: { provenance: Record<string, unknown> };
    };
    expect(input.supplied.provenance).toMatchObject({
      type: "github",
      repo: "owner/repo",
      resolvedSha: "b".repeat(40),
      contentDigest: DIGEST,
    });
  });

  it("reports a NAMED, non-finalizing outcome when the snapshot cannot be read", async () => {
    rows.mockResolvedValue([
      row({ type: "local", path: "gone.tgz", resolvedCommitOrTreeHash: DIGEST, contentDigest: DIGEST }),
    ]);
    readSuppliedSnapshot.mockRejectedValue(new Error("missing or unreadable"));
    const result = await runHostExtensionInstallAndActivate(PKG, null, "1.0.0");
    expect(result.finalized).toBe(false);
    expect(result.reason).toMatch(/^supplied-snapshot-unreadable:/);
    expect(installFromSupplied).not.toHaveBeenCalled();
  });

  it("reports a NAMED, non-finalizing outcome when the supplied install refuses", async () => {
    rows.mockResolvedValue([
      row({ type: "local", path: "x.tgz", resolvedCommitOrTreeHash: DIGEST, contentDigest: DIGEST }),
    ]);
    installFromSupplied.mockRejectedValue(new Error("content digest does not match"));
    const result = await runHostExtensionInstallAndActivate(PKG, null, "1.0.0");
    expect(result.finalized).toBe(false);
    expect(result.reason).toMatch(/^supplied-install-failed:/);
  });
});

describe("NO silent widening — every row that exists today keeps its behaviour", () => {
  it("still refuses a local row with NO content digest", async () => {
    rows.mockResolvedValue([row({ type: "local", path: "x", resolvedCommitOrTreeHash: "abc" })]);
    const result = await runHostExtensionInstallAndActivate(PKG, null, "1.0.0");
    expect(result).toEqual({ activated: false, reason: "non-verdaccio-source" });
    expect(installFromSupplied).not.toHaveBeenCalled();
  });

  it("still refuses a github row with NO content digest", async () => {
    rows.mockResolvedValue([row({ type: "github", repo: "o/r", ref: "main", resolvedSha: "abc" })]);
    const result = await runHostExtensionInstallAndActivate(PKG, null, "1.0.0");
    expect(result.reason).toBe("non-verdaccio-source");
  });

  it("still refuses a supplied row whose digest is malformed", async () => {
    rows.mockResolvedValue([
      row({ type: "local", path: "x", resolvedCommitOrTreeHash: "abc", contentDigest: "pending" }),
    ]);
    const result = await runHostExtensionInstallAndActivate(PKG, null, "1.0.0");
    expect(result.reason).toBe("non-verdaccio-source");
  });

  it("still refuses a bundled row", async () => {
    rows.mockResolvedValue([row({ type: "bundled", packageName: PKG, version: "1.0.0" })]);
    const result = await runHostExtensionInstallAndActivate(PKG, null, "1.0.0");
    expect(result.reason).toBe("non-verdaccio-source");
  });

  it("still drives a verdaccio row through the REGISTRY entry", async () => {
    rows.mockResolvedValue([
      row({
        type: "verdaccio",
        registryUrl: "https://registry.cinatra.ai",
        packageName: PKG,
        version: "1.0.0",
        integrity: "sha512-abc",
      }),
    ]);
    await runHostExtensionInstallAndActivate(PKG, null, "1.0.0");
    expect(installFromRegistry).toHaveBeenCalledTimes(1);
    expect(installFromSupplied).not.toHaveBeenCalled();
  });

  it("still reports no-active-canonical-row when there is no row at all", async () => {
    rows.mockResolvedValue([]);
    const result = await runHostExtensionInstallAndActivate(PKG, null, "1.0.0");
    expect(result.reason).toBe("no-active-canonical-row");
  });
});

// ---------------------------------------------------------------------------
// THE ARTIFACT KIND'S POST-INSTALL PROJECTION, ON THIS ROAD TOO (cinatra#3204).
//
// An artifact package is metadata-only: the pipeline finalizes it and the
// in-process activation half is inert by construction, so NOTHING about the
// finalized install registers its object type in this process. The registry road
// has always closed that gap right after finalize — the store rescan registers
// the type, the runtime renderer bundles are admitted, and the manifest's
// objectTypes claims are activated. The supplied road ran none of it, so an
// uploaded artifact package installed correctly and then rendered no object of
// its type, and its own settings address answered 404 because the installed list
// reads the object-type registry the rescan writes.
// ---------------------------------------------------------------------------
const suppliedLocal = {
  type: "local",
  path: "snapshots/a.tgz",
  resolvedCommitOrTreeHash: DIGEST,
  contentDigest: DIGEST,
};

describe("a finalized SUPPLIED artifact install is projected like a store one", () => {
  it("rescans the store for THIS package so its object type registers in process", async () => {
    rows.mockResolvedValue([row(suppliedLocal, "artifact")]);
    installFromSupplied.mockResolvedValue({
      installed: true,
      activated: false,
      reason: "metadata-only-kind",
      storeDir: "/data/extensions/artifact/thing/abc",
      version: "1.0.0",
    } as never);
    const result = await runHostExtensionInstallAndActivate(PKG_ARTIFACT, null, "1.0.0");
    expect(result.finalized).toBe(true);
    expect(rescan).toHaveBeenCalledTimes(1);
    expect(rescan).toHaveBeenCalledWith({ onlyPackage: PKG_ARTIFACT });
  });

  it("admits the package's runtime renderer bundles once the bridge registered it", async () => {
    rows.mockResolvedValue([row(suppliedLocal, "artifact")]);
    installFromSupplied.mockResolvedValue({
      installed: true,
      activated: false,
      reason: "metadata-only-kind",
      storeDir: "/data/extensions/artifact/thing/abc",
      version: "1.0.0",
    } as never);
    await runHostExtensionInstallAndActivate(PKG_ARTIFACT, null, "1.0.0");
    expect(admitRenderers).toHaveBeenCalledWith({
      packageName: PKG_ARTIFACT,
      storeDir: "/data/extensions/artifact/thing/abc",
    });
  });

  it("activates the manifest's objectTypes claims for the finalized install", async () => {
    rows.mockResolvedValue([row(suppliedLocal, "artifact")]);
    readClaims.mockResolvedValue([{ type: "thing" }]);
    installFromSupplied.mockResolvedValue({
      installed: true,
      activated: false,
      reason: "metadata-only-kind",
      storeDir: "/data/extensions/artifact/thing/abc",
      version: "1.0.0",
    } as never);
    await runHostExtensionInstallAndActivate(PKG_ARTIFACT, null, "1.0.0");
    expect(runClaimActivation).toHaveBeenCalledTimes(1);
    expect(runClaimActivation.mock.calls[0]?.[0]).toMatchObject({
      extensionPackage: PKG_ARTIFACT,
      installId: "iext_1",
    });
  });

  it("projects NOTHING when the bridge did not register the package", async () => {
    rows.mockResolvedValue([row(suppliedLocal, "artifact")]);
    rescan.mockResolvedValue({ registered: [], registeredRecords: [] });
    readClaims.mockResolvedValue([{ type: "thing" }]);
    installFromSupplied.mockResolvedValue({
      installed: true,
      activated: false,
      reason: "metadata-only-kind",
      storeDir: "/data/extensions/artifact/thing/abc",
      version: "1.0.0",
    } as never);
    await runHostExtensionInstallAndActivate(PKG_ARTIFACT, null, "1.0.0");
    expect(admitRenderers).not.toHaveBeenCalled();
    expect(runClaimActivation).not.toHaveBeenCalled();
  });

  it("never un-finalizes the committed install when the projection throws", async () => {
    rows.mockResolvedValue([row(suppliedLocal, "artifact")]);
    rescan.mockRejectedValue(new Error("store unreadable"));
    installFromSupplied.mockResolvedValue({
      installed: true,
      activated: false,
      reason: "metadata-only-kind",
      storeDir: "/data/extensions/artifact/thing/abc",
      version: "1.0.0",
    } as never);
    const result = await runHostExtensionInstallAndActivate(PKG_ARTIFACT, null, "1.0.0");
    expect(result.finalized).toBe(true);
  });

  it("leaves every other kind's supplied install untouched", async () => {
    rows.mockResolvedValue([row(suppliedLocal, "skill")]);
    await runHostExtensionInstallAndActivate(PKG, null, "1.0.0");
    expect(rescan).not.toHaveBeenCalled();
    expect(admitRenderers).not.toHaveBeenCalled();
  });

  // THE INSTALL'S OWN ORG AND ITS RESOLVED VERSION, not the requested ones. The
  // supplied road reads the SAME canonical row the registry road reads
  // (`readInstalledExtensionsByPackageName`), so the projection must scope this
  // install's claims and its representation binding to that row's org — a
  // platform scope on an org install would bind another tenant's providers.
  it("scopes the projection to THIS row's org and the pipeline's RESOLVED version", async () => {
    rows.mockResolvedValue([row(suppliedLocal, "artifact", { organizationId: "org_9" })]);
    readClaims.mockResolvedValue([{ type: "thing" }]);
    installFromSupplied.mockResolvedValue({
      installed: true,
      activated: false,
      reason: "metadata-only-kind",
      storeDir: "/data/extensions/artifact/thing/abc",
      // The pipeline's RESOLVED concrete version, deliberately different from
      // the requested "1.0.0" below.
      version: "2.3.0",
    } as never);
    await runHostExtensionInstallAndActivate(PKG_ARTIFACT, "org_9", "1.0.0");
    expect(readClaims).toHaveBeenCalledWith("/data/extensions/artifact/thing/abc");
    expect(runClaimActivation.mock.calls[0]?.[0]).toMatchObject({
      scope: "org:org_9",
      extensionPackage: PKG_ARTIFACT,
      extensionVersion: "2.3.0",
      installId: "iext_1",
    });
    expect(bindProviders.mock.calls[0]?.[0]).toMatchObject({
      packageName: PKG_ARTIFACT,
      row: { id: "iext_1", organizationId: "org_9", version: "2.3.0", status: "active" },
    });
  });

  // A DURABLY ROLLED-BACK update did NOT take: the previous version is the live
  // one, so admitting the new digest's renderers, binding its providers or
  // activating its claims would project a version that is not installed. The
  // rescan still runs (it re-reads whatever the store now holds) — the same
  // semantics the registry road has always had.
  it("projects nothing beyond the rescan for a durably ROLLED-BACK artifact update", async () => {
    rows.mockResolvedValue([row(suppliedLocal, "artifact", { organizationId: "org_9" })]);
    readClaims.mockResolvedValue([{ type: "thing" }]);
    installFromSupplied.mockResolvedValue({
      installed: true,
      activated: false,
      rolledBack: true,
      reason: "metadata-only-kind",
      storeDir: "/data/extensions/artifact/thing/abc",
      version: "2.3.0",
    } as never);
    const result = await runHostExtensionInstallAndActivate(PKG_ARTIFACT, "org_9", "1.0.0");
    expect(result.finalized).toBe(true);
    expect(rescan).toHaveBeenCalledTimes(1);
    expect(admitRenderers).not.toHaveBeenCalled();
    expect(bindProviders).not.toHaveBeenCalled();
    expect(runClaimActivation).not.toHaveBeenCalled();
  });

  it("projects nothing when the supplied install did not finalize", async () => {
    rows.mockResolvedValue([row(suppliedLocal, "artifact")]);
    installFromSupplied.mockResolvedValue({
      installed: false,
      activated: false,
      reason: "refused",
    } as never);
    await runHostExtensionInstallAndActivate(PKG_ARTIFACT, null, "1.0.0");
    expect(rescan).not.toHaveBeenCalled();
  });
});
