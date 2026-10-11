// The development version record never rewrites an uploaded or a
// registry-installed package's provenance (cinatra#3788).
//
// The dev watcher records a `0.0.0-dev.<sha>` checkout source against every
// canonical row of a package it loaded from the extension scan tree. When the
// agent runtime mount IS that scan tree, an upload materializes into it, and
// the record then rewrote the upload's row to a checkout shape: the row lost
// its `contentDigest`, `isSuppliedDigestSource` turned false, the supplied
// store payload stopped resolving, and every later upload of the package was
// refused. The guard below decides per row, for every kind.
//
// Store reads and the lifecycle primitive are mocked at the module boundary,
// the way the package's other lifecycle tests mock them, so no Postgres is
// needed.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isSuppliedDigestSource } from "../canonical-types";
import type { ExtensionSource, InstalledExtension } from "../canonical-types";

vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(),
}));
vi.mock("../lifecycle-primitive", () => ({
  sourceSwitchExtension: vi.fn(async () => undefined),
}));

import * as store from "../canonical-store";
import { sourceSwitchExtension } from "../lifecycle-primitive";
import { recordDevExtensionVersion } from "../dev-version";

const PKG = "@cinatra-ai/foo-agent";
const SHA = "abc1234";
const DIGEST = "a".repeat(64);

function row(over: Partial<InstalledExtension> & { source: ExtensionSource }): InstalledExtension {
  return {
    id: "ext-1",
    packageName: PKG,
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "agent",
    status: "active",
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as InstalledExtension;
}

const uploadedLocal: ExtensionSource = {
  type: "local",
  path: "/srv/extensions/foo-agent",
  resolvedCommitOrTreeHash: "deadbee",
  contentDigest: DIGEST,
};
const uploadedGithub: ExtensionSource = {
  type: "github",
  repo: "owner/repo",
  ref: "v1",
  resolvedSha: "deadbee",
  contentDigest: DIGEST,
};
const registry: ExtensionSource = {
  type: "verdaccio",
  registryUrl: "http://localhost:4873",
  packageName: PKG,
  version: "1.2.3",
  integrity: "sha512-x",
};
const checkout: ExtensionSource = {
  type: "local",
  path: "/repo/extensions/foo-agent",
  resolvedCommitOrTreeHash: "0ldsha0",
};
const bundled: ExtensionSource = {
  type: "bundled",
  packageName: PKG,
  version: "0.2.0",
};

function setRows(rows: InstalledExtension[]): void {
  vi.mocked(store.readInstalledExtensionsByPackageName).mockResolvedValue(rows);
}

async function record() {
  return recordDevExtensionVersion(PKG, "/repo/extensions/foo-agent", {
    sha: SHA,
    actorSource: "dev-watcher",
  });
}

describe("recordDevExtensionVersion provenance guard (cinatra#3788)", () => {
  beforeEach(() => {
    process.env.CINATRA_RUNTIME_MODE = "development";
    vi.mocked(store.readInstalledExtensionsByPackageName).mockReset();
    vi.mocked(sourceSwitchExtension).mockReset();
    vi.mocked(sourceSwitchExtension).mockResolvedValue(undefined as never);
  });

  it("skips a local row that carries a content digest (an upload) and names it", async () => {
    setRows([row({ id: "ext-upload", source: uploadedLocal })]);
    const out = await record();
    expect(sourceSwitchExtension).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, updated: 0 });
    if (!out.ok) throw new Error("expected the ok arm");
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]).toMatchObject({
      id: "ext-upload",
      kind: "agent",
      sourceType: "local",
      hasContentDigest: true,
    });
    expect(out.skipped[0]?.reason).toMatch(/supplied/i);
  });

  it("skips a github row that carries a content digest (an upload)", async () => {
    setRows([row({ id: "ext-gh", source: uploadedGithub })]);
    const out = await record();
    expect(sourceSwitchExtension).not.toHaveBeenCalled();
    if (!out.ok) throw new Error("expected the ok arm");
    expect(out.updated).toBe(0);
    expect(out.skipped[0]).toMatchObject({
      id: "ext-gh",
      sourceType: "github",
      hasContentDigest: true,
    });
  });

  it("skips a registry row", async () => {
    setRows([row({ id: "ext-reg", source: registry })]);
    const out = await record();
    expect(sourceSwitchExtension).not.toHaveBeenCalled();
    if (!out.ok) throw new Error("expected the ok arm");
    expect(out.updated).toBe(0);
    expect(out.skipped[0]).toMatchObject({
      id: "ext-reg",
      sourceType: "verdaccio",
      hasContentDigest: false,
    });
    expect(out.skipped[0]?.reason).toMatch(/registry/i);
  });

  it("switches a local row without a content digest (a source checkout)", async () => {
    setRows([row({ id: "ext-tree", source: checkout })]);
    const out = await record();
    expect(sourceSwitchExtension).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sourceSwitchExtension).mock.calls[0]?.[0]).toBe("ext-tree");
    expect(vi.mocked(sourceSwitchExtension).mock.calls[0]?.[1]).toMatchObject({
      type: "local",
      resolvedCommitOrTreeHash: SHA,
    });
    if (!out.ok) throw new Error("expected the ok arm");
    expect(out.updated).toBe(1);
    expect(out.skipped).toEqual([]);
  });

  it("switches a github row without a content digest (a source checkout)", async () => {
    setRows([
      row({
        id: "ext-gh-tree",
        source: { type: "github", repo: "owner/repo", ref: "main", resolvedSha: "0ldsha0" },
      }),
    ]);
    const out = await record();
    expect(sourceSwitchExtension).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sourceSwitchExtension).mock.calls[0]?.[0]).toBe("ext-gh-tree");
    if (!out.ok) throw new Error("expected the ok arm");
    expect(out.updated).toBe(1);
    expect(out.skipped).toEqual([]);
  });

  it("switches a static-bundle row", async () => {
    setRows([row({ id: "ext-bundle", source: bundled })]);
    const out = await record();
    expect(sourceSwitchExtension).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sourceSwitchExtension).mock.calls[0]?.[0]).toBe("ext-bundle");
    if (!out.ok) throw new Error("expected the ok arm");
    expect(out.updated).toBe(1);
    expect(out.skipped).toEqual([]);
  });

  it("keeps the connector kind on its current road: the switch is attempted and the primitive decides", async () => {
    setRows([row({ id: "ext-conn", kind: "connector", source: checkout })]);
    const out = await record();
    expect(sourceSwitchExtension).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sourceSwitchExtension).mock.calls[0]?.[0]).toBe("ext-conn");
    if (!out.ok) throw new Error("expected the ok arm");
    expect(out.updated).toBe(1);
  });

  it("switches exactly the checkout row when a package holds an upload and a checkout", async () => {
    setRows([
      row({ id: "ext-upload", source: uploadedLocal }),
      row({ id: "ext-tree", source: checkout }),
    ]);
    const out = await record();
    expect(sourceSwitchExtension).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sourceSwitchExtension).mock.calls[0]?.[0]).toBe("ext-tree");
    if (!out.ok) throw new Error("expected the ok arm");
    expect(out.updated).toBe(1);
    expect(out.skipped.map((s) => s.id)).toEqual(["ext-upload"]);
  });

  // THE INSTALL-ROAD REGRESSION, at the level the package's tests reach (no
  // database). Round 3 of cinatra#3693 found the break here: after the watcher
  // recorded over a materialized upload, the row's source was a digest-less
  // checkout, `isSuppliedDigestSource` answered false, and the supplied store
  // payload resolver returned null, so the next upload of the package was
  // refused with "no FINALIZED store payload". With the guard the row is left
  // alone, so the predicate the resolver reads still answers true.
  it("leaves an uploaded row's source a supplied digest source, so the store payload stays resolvable", async () => {
    const uploaded = row({ id: "ext-upload", source: uploadedLocal });
    setRows([uploaded]);
    await record();
    expect(sourceSwitchExtension).not.toHaveBeenCalled();
    expect(uploaded.source).toEqual(uploadedLocal);
    expect(isSuppliedDigestSource(uploaded.source)).toBe(true);
  });
});
