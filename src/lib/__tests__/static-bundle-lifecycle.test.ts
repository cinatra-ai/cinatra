// Static-bundle lifecycle seeding (the manifest-completeness half of the
// static-bundle lifecycle-correctness contract). The seeder ensures ONE platform-scoped
// ANCHOR row per bundled serverEntry package so the loader's strict allow-list
// can read "no row" as retirement — and it must NEVER resurrect an operator's
// archive/uninstall decision.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";

const readInstalledExtensionsByPackageName = vi.fn();
const installExtensionManifest = vi.fn();
const transitionExtensionLifecycle = vi.fn();
const isPackageRequiredInProd = vi.fn<(pkg: string) => boolean>(() => false);

vi.mock("server-only", () => ({}));
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...args: unknown[]) =>
    readInstalledExtensionsByPackageName(...args),
}));
vi.mock("@cinatra-ai/extensions/lifecycle-primitive", () => ({
  installExtensionManifest: (...args: unknown[]) => installExtensionManifest(...args),
  transitionExtensionLifecycle: (...args: unknown[]) => transitionExtensionLifecycle(...args),
}));
vi.mock("@cinatra-ai/extensions/required-in-prod", () => ({
  isPackageRequiredInProd: (pkg: string) => isPackageRequiredInProd(pkg),
}));
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_RECORDS: [
    {
      packageName: "@cinatra-ai/bundled-connector",
      kind: "connector",
      version: "0.1.0",
      serverEntry: "./register",
      requestedHostPorts: [],
      sdkAbiRange: null,
    },
    {
      packageName: "@cinatra-ai/ui-only-ext",
      kind: "connector",
      version: "0.1.0",
      serverEntry: null, // NOT activation-relevant → never seeded
      requestedHostPorts: [],
      sdkAbiRange: null,
    },
  ],
  GENERATED_EXTENSION_SERVER_ENTRIES: {},
}));

// The real anchor helpers (pure) — the seeder and the assertions below must
// agree on the provenance shape, so we deliberately do NOT mock them.
import {
  isStaticBundleAnchorSource,
  staticBundleAnchorSource,
} from "@cinatra-ai/extensions/static-bundle-anchor";

const row = (over: Partial<InstalledExtension>): InstalledExtension => ({
  id: "iext_x",
  packageName: "@cinatra-ai/bundled-connector",
  ownerLevel: "organization",
  ownerId: "org-1",
  organizationId: "org-1",
  kind: "connector",
  status: "active",
  source: { type: "local", path: "connector:@cinatra-ai/bundled-connector", resolvedCommitOrTreeHash: "dev-fixture" },
  requiredInProd: false,
  dependencies: [],
  manifestHash: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const anchorRow = (status: InstalledExtension["status"]): InstalledExtension =>
  row({
    id: "iext_anchor",
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    status,
    source: staticBundleAnchorSource("@cinatra-ai/bundled-connector", "0.1.0"),
  });

async function runSeeder() {
  const { ensureStaticBundleLifecycleAnchors } = await import("@/lib/static-bundle-lifecycle");
  return ensureStaticBundleLifecycleAnchors();
}

describe("ensureStaticBundleLifecycleAnchors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
    installExtensionManifest.mockImplementation(async (r: Record<string, unknown>) => ({
      ...row({}),
      ...r,
    }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fresh DB (no rows) → seeds a LIVE platform anchor through the canonical primitive", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([]);
    const result = await runSeeder();
    expect(result.seededLive).toEqual(["@cinatra-ai/bundled-connector"]);
    expect(result.seededArchived).toEqual([]);
    expect(installExtensionManifest).toHaveBeenCalledTimes(1); // ui-only-ext NOT seeded
    const arg = installExtensionManifest.mock.calls[0][0];
    expect(arg.ownerLevel).toBe("platform");
    expect(arg.status).toBe("active");
    expect(isStaticBundleAnchorSource(arg.source)).toBe(true);
    expect(transitionExtensionLifecycle).not.toHaveBeenCalled();
  });

  it("anchor already exists (live) → no write", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([anchorRow("active")]);
    const result = await runSeeder();
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(result.seededLive).toEqual([]);
  });

  it("ARCHIVED anchor (uninstall tombstone) → never re-seeded, never resurrected", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([anchorRow("archived")]);
    const result = await runSeeder();
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(transitionExtensionLifecycle).not.toHaveBeenCalled();
    expect(result.seededLive).toEqual([]);
    expect(result.seededArchived).toEqual([]);
  });

  it("live org rows but no anchor → seeds a live anchor (matches effective state)", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([row({ status: "active" })]);
    const result = await runSeeder();
    expect(result.seededLive).toEqual(["@cinatra-ai/bundled-connector"]);
    expect(transitionExtensionLifecycle).not.toHaveBeenCalled();
  });

  it("rows exist but NONE live (legacy retired) → anchor is seeded then ARCHIVED, preserving the retired state", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([row({ status: "archived" })]);
    installExtensionManifest.mockResolvedValueOnce(anchorRow("active"));
    const result = await runSeeder();
    expect(result.seededArchived).toEqual(["@cinatra-ai/bundled-connector"]);
    expect(result.seededLive).toEqual([]);
    expect(transitionExtensionLifecycle).toHaveBeenCalledWith(
      "iext_anchor",
      "archive",
      expect.objectContaining({ actor: expect.objectContaining({ source: "static-bundle-lifecycle" }) }),
    );
  });

  it("legacy retired + required-in-prod in PROD → left un-anchored (never flipped live)", async () => {
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    isPackageRequiredInProd.mockReturnValue(true);
    readInstalledExtensionsByPackageName.mockResolvedValue([row({ status: "archived" })]);
    const result = await runSeeder();
    expect(installExtensionManifest).not.toHaveBeenCalled();
    expect(result.seededLive).toEqual([]);
    expect(result.seededArchived).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("insert race: install throws but a re-read finds the anchor → benign, not a failure", async () => {
    readInstalledExtensionsByPackageName
      .mockResolvedValueOnce([]) // initial read: no anchor
      .mockResolvedValueOnce([anchorRow("active")]); // re-read after the race
    installExtensionManifest.mockRejectedValueOnce(new Error("duplicate key"));
    const result = await runSeeder();
    expect(result.failed).toEqual([]);
    expect(result.seededLive).toEqual([]);
  });

  it("persistent install failure → reported in failed[] and logged, boot continues", async () => {
    readInstalledExtensionsByPackageName.mockResolvedValue([]);
    installExtensionManifest.mockRejectedValueOnce(new Error("provenance invalid"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runSeeder();
    expect(result.failed).toEqual(["@cinatra-ai/bundled-connector"]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
