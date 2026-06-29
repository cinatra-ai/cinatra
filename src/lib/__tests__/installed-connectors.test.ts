// cinatra#658 (PR-4) F1 — the runtime-sourced connector card index predicate.
//
// `resolveInstalledCatalogConnectorIds` is the batched actor-scoped predicate the
// /connectors card filter now uses (migrating off the sync static-only
// `isConnectorInstalled`). These prove the matrix: bundled-only, runtime-installed,
// operator-archived, cross-org, untrusted-by-scope, store-outage — keeping the
// CG-1 bundled fallback precise.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";

// A bundled connector and a NON-bundled (runtime-only) package.
const BUNDLED = "@cinatra-ai/openai-connector"; // present in STATIC_EXTENSION_MANIFEST
const RUNTIME_ONLY = "@acme/widgets-connector"; // never bundled

// Control the batched canonical read.
let rowsByPackage = new Map<string, InstalledExtension[]>();
let throwOnRead = false;

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageNames: async (names: readonly string[]) => {
    if (throwOnRead) throw new Error("canonical store outage");
    const out = new Map<string, InstalledExtension[]>();
    for (const n of names) {
      const r = rowsByPackage.get(n);
      if (r) out.set(n, r);
    }
    return out;
  },
  listInstalledExtensions: async () => [],
}));

const { resolveInstalledCatalogConnectorIds } = await import("@/lib/installed-connectors.server");

function row(over: Partial<InstalledExtension>): InstalledExtension {
  return {
    id: "row-" + Math.random().toString(36).slice(2),
    packageName: RUNTIME_ONLY,
    ownerLevel: "organization",
    ownerId: "org-1",
    organizationId: "org-1",
    kind: "connector",
    status: "active",
    source: {} as InstalledExtension["source"],
    requiredInProd: false,
    dependencies: [],
    ...over,
  } as InstalledExtension;
}

const actorOrg1 = {
  principalType: "HumanUser" as const,
  principalId: "u1",
  organizationId: "org-1",
  teamIds: [] as string[],
} as unknown as Parameters<typeof resolveInstalledCatalogConnectorIds>[1];

beforeEach(() => {
  rowsByPackage = new Map();
  throwOnRead = false;
});

describe("resolveInstalledCatalogConnectorIds (F1 batched predicate)", () => {
  it("bundled connector with NO row → installed (CG-1 bundled fallback)", async () => {
    const set = await resolveInstalledCatalogConnectorIds([BUNDLED], actorOrg1);
    expect(set.has(BUNDLED)).toBe(true);
  });

  it("runtime-only package with NO row + NOT bundled → NOT installed (fail-closed)", async () => {
    const set = await resolveInstalledCatalogConnectorIds([RUNTIME_ONLY], actorOrg1);
    expect(set.has(RUNTIME_ONLY)).toBe(false);
  });

  it("runtime-only package with a LIVE addressable row → installed", async () => {
    rowsByPackage.set(RUNTIME_ONLY, [row({ packageName: RUNTIME_ONLY, status: "active", organizationId: "org-1" })]);
    const set = await resolveInstalledCatalogConnectorIds([RUNTIME_ONLY], actorOrg1);
    expect(set.has(RUNTIME_ONLY)).toBe(true);
  });

  it("bundled connector ARCHIVED by an operator → NOT installed (fallback must not resurrect)", async () => {
    rowsByPackage.set(BUNDLED, [row({ packageName: BUNDLED, status: "archived", organizationId: "org-1" })]);
    const set = await resolveInstalledCatalogConnectorIds([BUNDLED], actorOrg1);
    expect(set.has(BUNDLED)).toBe(false);
  });

  it("a CROSS-ORG live row is NOT addressable → bundled falls back, runtime-only fails closed", async () => {
    rowsByPackage.set(BUNDLED, [row({ packageName: BUNDLED, status: "active", organizationId: "OTHER" })]);
    rowsByPackage.set(RUNTIME_ONLY, [row({ packageName: RUNTIME_ONLY, status: "active", organizationId: "OTHER" })]);
    const set = await resolveInstalledCatalogConnectorIds([BUNDLED, RUNTIME_ONLY], actorOrg1);
    // BUNDLED has no ADDRESSABLE row → bundled fallback applies → installed.
    expect(set.has(BUNDLED)).toBe(true);
    // RUNTIME_ONLY's only row is cross-org → not addressable → fail closed.
    expect(set.has(RUNTIME_ONLY)).toBe(false);
  });

  it("store OUTAGE: bundled stays visible, runtime-only fails closed", async () => {
    throwOnRead = true;
    const set = await resolveInstalledCatalogConnectorIds([BUNDLED, RUNTIME_ONLY], actorOrg1);
    expect(set.has(BUNDLED)).toBe(true);
    expect(set.has(RUNTIME_ONLY)).toBe(false);
  });

  it("a NULL actor sees only the bundled fallback", async () => {
    const set = await resolveInstalledCatalogConnectorIds([BUNDLED, RUNTIME_ONLY], null);
    expect(set.has(BUNDLED)).toBe(true);
    expect(set.has(RUNTIME_ONLY)).toBe(false);
  });
});
