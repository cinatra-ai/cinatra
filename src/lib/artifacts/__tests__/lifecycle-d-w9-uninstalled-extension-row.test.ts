import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdmittedClientBundleTuple } from "@cinatra-ai/sdk-extensions/artifact-client-bundle";
import { representationProviderRegistry } from "@cinatra-ai/objects/artifact-renderer-registry";

import {
  pickGoverningRow,
  reconcileActivatedRepresentationProviders,
  _resetActivatedGenerationsForTests,
  type GoverningInstallRow,
} from "@/lib/artifacts/system-artifact-renderer-registrar";
import {
  preImportFloorReason,
  runtimeRendererFloorDiagnostic,
} from "@/lib/artifacts/runtime-renderer-descriptor";

// ---------------------------------------------------------------------------
// LIFECYCLE-D W9 — an organisation viewing a row of an extension it never
// installed. One injected display (a guardedOptional entry of a package outside
// the organisation's names) and one install row of ONE organisation are read as
// two organisations see them: what the binding resolves, and the reason the
// loader gives when it floors. The generated map is supplied by vitest's module
// factory, so this file never imports it (nor the route's dispatch file).
// ---------------------------------------------------------------------------

const W9 = vi.hoisted(() => ({
  PKG: "@example-org/w9-row-artifact",
  MIME: "application/vnd.example.w9-row+json",
  SLOT: "detail",
  readByNames: vi.fn(),
}));

vi.mock("@/lib/generated/artifact-renderers", () => ({
  GENERATED_ARTIFACT_RENDERERS: {
    [`${W9.PKG}::${W9.SLOT}`]: {
      resolution: "guardedOptional",
      packageName: W9.PKG,
      slot: W9.SLOT,
      representations: [W9.MIME],
      propsApiVersion: 2,
      load: async () => ({}),
    },
  },
}));

// The canonical-store batch reader is dynamically imported inside the reconcile,
// so the module factory intercepts it.
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageNames: (names: readonly string[]) => W9.readByNames(names),
}));

const W9_INSTALLING_ORG = "org-w9-installed";
const W9_OTHER_ORG = "org-w9-never-installed";

const W9_INSTALL_ROW: GoverningInstallRow = {
  id: "install-w9-1",
  kind: "artifact",
  status: "active",
  version: "0.1.0",
  organizationId: W9_INSTALLING_ORG,
  updatedAt: new Date("2026-07-26T10:00:00.000Z"),
};
const W9_ARCHIVED_ROW: GoverningInstallRow = { ...W9_INSTALL_ROW, status: "archived" };

const DIGEST = "c".repeat(128);
const TUPLE: AdmittedClientBundleTuple = {
  packageName: W9.PKG,
  slot: "detail",
  digest: DIGEST,
  entry: "client/detail.js",
  propsApiVersion: 2,
  sdkAbiRange: "^2.4.0",
  reactPeerRange: "^19.0.0",
  reactDomPeerRange: "^19.0.0",
  tokenModuleAbi: "1.0.0",
};
const HOST = {
  reactVersion: "19.2.7",
  reactDomVersion: "19.2.7",
  hostSdkAbi: "2.4.0",
  expectedPropsApiVersion: 2,
};

function rowsFor(rows: GoverningInstallRow[]): Map<string, GoverningInstallRow[]> {
  return new Map([[W9.PKG, rows]]);
}

// The loader's reading for one organisation over the case's rows: the install is
// live for the loader exactly when the binding's own governing pick finds a row.
function loaderReason(rows: GoverningInstallRow[], orgId: string) {
  return preImportFloorReason({
    tuple: TUPLE,
    digestQuarantined: false,
    installedActive: pickGoverningRow(rows, orgId) !== null,
    currentActiveDigest: DIGEST,
    signatureVerified: true,
    host: HOST,
  });
}

function resolveFor(orgId: string) {
  return representationProviderRegistry.resolve(orgId, W9.MIME, "detail");
}

beforeEach(() => {
  representationProviderRegistry._clearForTests(true);
  _resetActivatedGenerationsForTests();
  W9.readByNames.mockReset();
  W9.readByNames.mockResolvedValue(new Map());
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.doUnmock("@/lib/generated/artifact-renderers");
  vi.doUnmock("@cinatra-ai/extensions/canonical-store");
  vi.resetModules();
});

describe("an organisation viewing a row of an extension it never installed", () => {
  // Drives system-artifact-renderer-registrar.ts:580-623 (the reconcile), :528
  // (the organisation's own row is the governing one), registry :407 (resolve)
  // and descriptor :188-193 (a live install passes the loader's install reading).
  it("the installing organisation resolves the extension's own display", async () => {
    const rows = [W9_INSTALL_ROW];
    W9.readByNames.mockResolvedValue(rowsFor(rows));
    const res = await reconcileActivatedRepresentationProviders(W9_INSTALLING_ORG);
    expect(res.bound).toEqual([W9.PKG]);
    // registry :329 derives the key from the package and slot; :424-430 returns it.
    expect(resolveFor(W9_INSTALLING_ORG)).toEqual({
      tier: "extension",
      packageName: W9.PKG,
      generatedKey: `${W9.PKG}::${W9.SLOT}`,
      pattern: W9.MIME,
      slot: W9.SLOT,
    });
    expect(loaderReason(rows, W9_INSTALLING_ORG)).toBeNull();
  });

  // Drives registrar :524-531 (another organisation's row is never governing),
  // :609-615 (no governing row retires) and descriptor :67-72 and :188.
  it("another organisation viewing the same row gets the floor with its named reason", async () => {
    const rows = [W9_INSTALL_ROW];
    W9.readByNames.mockResolvedValue(rowsFor(rows));
    await reconcileActivatedRepresentationProviders(W9_INSTALLING_ORG);
    await reconcileActivatedRepresentationProviders(W9_OTHER_ORG);

    expect(resolveFor(W9_INSTALLING_ORG)).not.toBeNull();
    expect(resolveFor(W9_OTHER_ORG)).toBeNull();
    const reason = loaderReason(rows, W9_OTHER_ORG);
    expect(reason).toBe("archived");

    // descriptor :67-72: package, slot and reason, and nothing else.
    const line = runtimeRendererFloorDiagnostic(W9.PKG, "detail", "archived");
    expect(line).toBe(
      `dynamic artifact renderer unavailable — package "${W9.PKG}", slot "detail", reason "archived"`,
    );
    expect(line).not.toContain(W9_INSTALLING_ORG);
    expect(line).not.toContain(W9_OTHER_ORG);
    expect(line).not.toContain(W9_INSTALL_ROW.id);
  });

  // Drives registrar :524 (an archived row is not live) and :609-615 (the
  // organisation's binding is retired), and descriptor :188.
  it("archiving the install floors the installing organisation too", async () => {
    W9.readByNames.mockResolvedValue(rowsFor([W9_INSTALL_ROW]));
    const first = await reconcileActivatedRepresentationProviders(W9_INSTALLING_ORG);
    expect(first.bound).toEqual([W9.PKG]);
    expect(resolveFor(W9_INSTALLING_ORG)).not.toBeNull();

    const archived = [W9_ARCHIVED_ROW];
    W9.readByNames.mockResolvedValue(rowsFor(archived));
    const res = await reconcileActivatedRepresentationProviders(W9_INSTALLING_ORG);
    expect(res.retired).toEqual([W9.PKG]);
    expect(resolveFor(W9_INSTALLING_ORG)).toBeNull();
    expect(loaderReason(archived, W9_INSTALLING_ORG)).toBe("archived");
  });

  // Drives registrar :609-621 (the binding is per organisation).
  it("the other organisation's reading never binds from the installing organisation's row", async () => {
    W9.readByNames.mockResolvedValue(rowsFor([W9_INSTALL_ROW]));
    const res = await reconcileActivatedRepresentationProviders(W9_OTHER_ORG);
    expect(res.bound).toEqual([]);
    expect(resolveFor(W9_OTHER_ORG)).toBeNull();
    expect(resolveFor(W9_INSTALLING_ORG)).toBeNull();
  });
});
