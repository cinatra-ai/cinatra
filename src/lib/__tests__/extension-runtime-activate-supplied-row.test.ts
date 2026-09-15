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

import { runHostExtensionInstallAndActivate } from "@/lib/extension-runtime-activate";

const DIGEST = "a".repeat(64);
const PKG = "@acme/thing-skill";

const row = (source: unknown, kind = "skill") => ({
  id: "iext_1",
  packageName: PKG,
  kind,
  status: "active",
  source,
});

beforeEach(() => {
  vi.clearAllMocks();
  installFromSupplied.mockResolvedValue({ installed: true, activated: false, reason: "metadata-only-kind" });
  readSuppliedSnapshot.mockResolvedValue(new Uint8Array([1, 2, 3]));
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
