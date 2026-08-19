// The install pipeline's CANONICAL-ROW writers, over the two-live-default-rows
// shape a marketplace install creates.
//
// `recordProvenance`, `persistDependencyEdges`, `persistAccessDeclaration` and
// the widget-auth key write all resolve through one `resolveTarget` in
// `makeCanonicalRowInstallDeps`, which picks with `pickSingleActiveRow`. This is
// the production wiring that failed against the running application: installing
// a marketplace override for a package that also ships bundled put a live
// default bundled anchor and a live default marketplace row in one org scope,
// the picker read that pair as cross-owner ambiguity, and the install rolled
// itself back at its own provenance write —
//
//   recordProvenance: expected exactly 1 active installed_extension row for …
//   in org (global) (0 or ambiguous owner scope) — fail closed
//
// so the override was permanently uninstallable over a bundled package. The
// pure-picker tests in `install-row-precedence.test.ts` state the policy; these
// tests pin the wiring, so a future change that stops threading the policy
// through this factory fails here rather than in a real install.
import { describe, it, expect, vi, beforeEach } from "vitest";

const BUNDLED_ROW_ID = "iext_bundled_anchor";
const MARKETPLACE_ROW_ID = "iext_marketplace_override";
const PKG = "@acme/two-version-connector";

let rows: Array<Record<string, unknown>>;
const sourceSwitchExtension = vi.fn(async (..._args: unknown[]) => {});
const recordExtensionDependencies = vi.fn(async (..._args: unknown[]) => {});
const recordExtensionAccessDeclaration = vi.fn(async (..._args: unknown[]) => {});

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: async () => rows,
  readInstalledExtensionById: async (id: string) => rows.find((r) => r.id === id) ?? null,
}));
vi.mock("@cinatra-ai/extensions/lifecycle-primitive", () => ({
  sourceSwitchExtension: (...args: unknown[]) => sourceSwitchExtension(...args),
  recordExtensionDependencies: (...args: unknown[]) => recordExtensionDependencies(...args),
  recordExtensionAccessDeclaration: (...args: unknown[]) =>
    recordExtensionAccessDeclaration(...args),
}));
// The `current` digest mirror is a best-effort store write, irrelevant here.
vi.mock("@/lib/extension-store-io", () => ({
  mirrorCurrentDigestBestEffort: async () => {},
}));

const { makeCanonicalRowInstallDeps } = await import(
  "@/lib/extension-install-canonical-row-deps"
);

const bundledAnchor = (over: Record<string, unknown> = {}) => ({
  id: BUNDLED_ROW_ID,
  packageName: PKG,
  kind: "connector",
  status: "active",
  organizationId: null,
  ownerLevel: "platform",
  ownerId: "__platform__",
  isDefault: true,
  version: "0.1.0",
  source: { type: "bundled", packageName: PKG, version: "0.1.0" },
  ...over,
});
const marketplaceOverride = (over: Record<string, unknown> = {}) => ({
  id: MARKETPLACE_ROW_ID,
  packageName: PKG,
  kind: "connector",
  status: "active",
  organizationId: null,
  ownerLevel: "workspace",
  ownerId: "__platform__",
  isDefault: true,
  version: "0.1.2",
  source: { type: "verdaccio", packageName: PKG, version: "0.1.2" },
  ...over,
});

const deps = () =>
  makeCanonicalRowInstallDeps({ provenanceRegistryUrl: (url: string) => url });

const provenanceInput = {
  packageName: PKG,
  orgId: null,
  registryUrl: "https://registry.example",
  version: "0.1.2",
  integrity: "sha512-abc",
  contentHash: "hash",
  digest: "digest",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the canonical-row writers resolve through source precedence", () => {
  it("recordProvenance targets the marketplace row, not the bundled anchor", async () => {
    rows = [bundledAnchor(), marketplaceOverride()];
    await deps().recordProvenance(provenanceInput);
    expect(sourceSwitchExtension).toHaveBeenCalledTimes(1);
    expect(sourceSwitchExtension.mock.calls[0]![0]).toBe(MARKETPLACE_ROW_ID);
  });

  it("is order independent", async () => {
    rows = [marketplaceOverride(), bundledAnchor()];
    await deps().recordProvenance(provenanceInput);
    expect(sourceSwitchExtension.mock.calls[0]![0]).toBe(MARKETPLACE_ROW_ID);
  });

  it("a LOCKED marketplace row is still live and still wins", async () => {
    rows = [bundledAnchor(), marketplaceOverride({ status: "locked" })];
    await deps().recordProvenance(provenanceInput);
    expect(sourceSwitchExtension.mock.calls[0]![0]).toBe(MARKETPLACE_ROW_ID);
  });

  it("persistDependencyEdges targets the same row", async () => {
    rows = [bundledAnchor(), marketplaceOverride()];
    await deps().persistDependencyEdges!({ packageName: PKG, orgId: null, dependencies: [] });
    expect(recordExtensionDependencies.mock.calls[0]![0]).toBe(MARKETPLACE_ROW_ID);
  });

  it("persistAccessDeclaration targets the same row", async () => {
    rows = [bundledAnchor(), marketplaceOverride()];
    await deps().persistAccessDeclaration!({
      packageName: PKG,
      orgId: null,
      declaration: null,
    });
    expect(recordExtensionAccessDeclaration.mock.calls[0]![0]).toBe(MARKETPLACE_ROW_ID);
  });

  it("with no override the bundled anchor is still the target", async () => {
    rows = [bundledAnchor()];
    await deps().recordProvenance(provenanceInput);
    expect(sourceSwitchExtension.mock.calls[0]![0]).toBe(BUNDLED_ROW_ID);
  });

  it("two competing marketplace installs still fail closed", async () => {
    rows = [
      marketplaceOverride(),
      marketplaceOverride({ id: "iext_other", ownerLevel: "platform" }),
    ];
    await expect(deps().recordProvenance(provenanceInput)).rejects.toThrow(
      /expected exactly 1 active installed_extension row/,
    );
    expect(sourceSwitchExtension).not.toHaveBeenCalled();
  });

  it("a bound row id still wins over the resolution, unchanged", async () => {
    rows = [bundledAnchor(), marketplaceOverride()];
    await makeCanonicalRowInstallDeps({
      provenanceRegistryUrl: (url: string) => url,
      boundRowId: BUNDLED_ROW_ID,
      mirrorCurrentDigest: false,
    }).recordProvenance(provenanceInput);
    expect(sourceSwitchExtension.mock.calls[0]![0]).toBe(BUNDLED_ROW_ID);
  });
});
