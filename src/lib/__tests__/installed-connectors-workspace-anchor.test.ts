// cinatra#2694 / S3 #2697 — runtime connector DISCOVERY includes the org-NULL
// workspace-anchored rows alongside the active organization's rows.
//
// The epic's claim, verified on this branch before the change: the rest of this
// path already admitted an org-NULL row —
//   - `isInstallRowAddressableByActor` (src/lib/extension-install-resolution.ts,
//     lines 136-139) fences only rows that HAVE an owning org;
//   - the CATALOG path reads by package name with no org filter at all
//     (`readInstalledExtensionsByPackageNames`, resolveInstalledCatalogConnectorIds).
// The runtime-only discovery read was the sole gap: it pinned
// `organization_id = <actor org>` exactly, so a workspace-anchored connector was
// never even a candidate. These pin the closed gap AND its narrowness.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";

const RUNTIME_ONLY = "@acme/widgets-connector"; // no catalog descriptor
const ORG_A = "org-a";

/** Every `listInstalledExtensions` call the discovery read makes. */
let listCalls: Array<{ kind?: string; organizationId?: string | null }> = [];
let allRows: InstalledExtension[] = [];
/** Package names whose card record passes the (stubbed) trust gate. */
let trustedCards = new Set<string>();
/** When set, the Nth discovery read throws (canonical-store outage). */
let throwOnListCall: number | null = null;

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageNames: async () => new Map(),
  listInstalledExtensions: async (filters: { kind?: string; organizationId?: string | null }) => {
    listCalls.push(filters);
    if (throwOnListCall !== null && listCalls.length === throwOnListCall) {
      throw new Error("canonical store outage");
    }
    // Mirror the store's real filter semantics: `organizationId: null` means
    // `organization_id IS NULL`; a string means exact equality.
    return allRows.filter((r) => {
      if (filters.kind && r.kind !== filters.kind) return false;
      if (filters.organizationId === undefined) return true;
      return (r.organizationId ?? null) === (filters.organizationId ?? null);
    });
  },
}));

vi.mock("@/lib/extension-install-resolution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/extension-install-resolution")>();
  return {
    ...actual,
    // The trust gate itself is unchanged by S3 and needs an on-disk store; stub
    // it to a pure yes/no so these tests isolate DISCOVERY.
    resolveRuntimeConnectorCardRecord: async (packageName: string) =>
      trustedCards.has(packageName)
        ? { packageName, vendor: "acme", slug: "widgets", displayName: "Widgets", logo: null, uiSurface: null }
        : null,
  };
});

const { listRuntimeOnlyConnectorCards } = await import("@/lib/installed-connectors.server");

function row(over: Partial<InstalledExtension>): InstalledExtension {
  return {
    id: "row-" + Math.random().toString(36).slice(2),
    packageName: RUNTIME_ONLY,
    ownerLevel: "organization",
    ownerId: ORG_A,
    organizationId: ORG_A,
    kind: "connector",
    status: "active",
    source: {} as InstalledExtension["source"],
    requiredInProd: false,
    dependencies: [],
    ...over,
  } as InstalledExtension;
}

const workspaceRow = (over: Partial<InstalledExtension> = {}) =>
  row({ ownerLevel: "workspace", ownerId: "__platform__", organizationId: null, ...over });

const actor = (organizationId: string | null) =>
  ({
    principalType: "HumanUser",
    principalId: "u1",
    organizationId,
    teamIds: [],
    platformRole: "member",
    orgRole: "member",
  }) as unknown as Parameters<typeof listRuntimeOnlyConnectorCards>[0];

beforeEach(() => {
  listCalls = [];
  allRows = [];
  throwOnListCall = null;
  trustedCards = new Set([RUNTIME_ONLY]);
});

describe("listRuntimeOnlyConnectorCards — org-NULL workspace rows are discovered", () => {
  it("an org actor with NO row of its own still discovers the workspace-anchored connector", async () => {
    allRows = [workspaceRow()];
    const cards = await listRuntimeOnlyConnectorCards(actor(ORG_A));
    expect(cards.map((c) => c.packageName)).toEqual([RUNTIME_ONLY]);
  });

  it("the SAME workspace row is discovered from a second organization", async () => {
    allRows = [workspaceRow()];
    for (const org of [ORG_A, "org-b"]) {
      const cards = await listRuntimeOnlyConnectorCards(actor(org));
      expect(cards.map((c) => c.packageName), org).toEqual([RUNTIME_ONLY]);
    }
  });

  it("an org actor reads BOTH scopes; an org-LESS actor still reads exactly one", async () => {
    allRows = [workspaceRow()];
    await listRuntimeOnlyConnectorCards(actor(ORG_A));
    expect(listCalls).toEqual([
      { kind: "connector", organizationId: ORG_A },
      { kind: "connector", organizationId: null },
    ]);

    listCalls = [];
    await listRuntimeOnlyConnectorCards(actor(null));
    expect(listCalls).toEqual([{ kind: "connector", organizationId: null }]);
  });

  it("the org's OWN row still wins the per-package pick where both rows exist", async () => {
    const own = row({});
    allRows = [own, workspaceRow()];
    // Both rows are addressable; the discovery pick prefers the actor's own org
    // row (it is listed first and is not cross-org), so the card is resolved
    // against the org's install — the workspace row serves only the others.
    const cards = await listRuntimeOnlyConnectorCards(actor(ORG_A));
    expect(cards.map((c) => c.packageName)).toEqual([RUNTIME_ONLY]);
  });

  it("an ARCHIVED workspace row is not a candidate (fail-closed, unchanged)", async () => {
    allRows = [workspaceRow({ status: "archived" })];
    expect(await listRuntimeOnlyConnectorCards(actor(ORG_A))).toEqual([]);
  });

  it("a CROSS-ORG row is still never discovered", async () => {
    allRows = [row({ organizationId: "other-org", ownerId: "other-org" })];
    expect(await listRuntimeOnlyConnectorCards(actor(ORG_A))).toEqual([]);
  });

  it("a bundled/system PLATFORM row at the same org-NULL scope is NOT pulled in", async () => {
    // The org-NULL arm is narrowed to the workspace anchor, so the bundled/system
    // tier keeps exactly the path it had.
    allRows = [row({ ownerLevel: "platform", ownerId: "__platform__", organizationId: null })];
    expect(await listRuntimeOnlyConnectorCards(actor(ORG_A))).toEqual([]);
  });

  it("a canonical-store outage on EITHER read still yields no cards (fail closed)", async () => {
    // Both reads are awaited together, so an outage on either arm must take the
    // whole discovery down to the unchanged fail-closed posture.
    for (const failing of [1, 2]) {
      listCalls = [];
      allRows = [workspaceRow()];
      throwOnListCall = failing;
      expect(await listRuntimeOnlyConnectorCards(actor(ORG_A)), `read ${failing}`).toEqual([]);
      throwOnListCall = null;
    }
  });
});
