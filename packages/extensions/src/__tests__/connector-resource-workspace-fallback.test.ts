// cinatra#2694 / S3 #2697, re-grounded by S4 #2698 — the ASYNC canonical
// connector-access resolver's EFFECTIVE-ROW rule (`resolveConnectorResource`).
//
// Before S3 this resolver read ONE identity — the actor org's own row — so a
// connector installed at "Workspace: All" was invisible to every organization.
// S3 added the workspace arm as a FALLBACK behind the org row; the owner ruling
// of 2026-08-16 inverts that precedence, because a LIVE workspace row supersedes
// every organization row. The inversion is load-bearing: identity reads return
// ARCHIVED rows too, and a workspace install now archives the organization row
// in place, so an org-first order would govern the connector by the superseded
// row. These pin the resolution over the canonical store's identity read.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InstalledExtension } from "../canonical-types";

type Identity = {
  organizationId: string | null;
  ownerLevel: string;
  ownerId: string | null;
  packageName: string;
};

const identityReads: Identity[] = [];
let rowsByIdentityKey = new Map<string, InstalledExtension>();

const keyOf = (i: Identity) =>
  `${i.organizationId ?? "NULL"}|${i.ownerLevel}|${i.ownerId ?? "NULL"}|${i.packageName}`;

vi.mock("../canonical-store", () => ({
  readInstalledExtensionByIdentity: async (identity: Identity) => {
    identityReads.push(identity);
    return rowsByIdentityKey.get(keyOf(identity)) ?? null;
  },
  readInstalledExtensionById: async () => null,
}));

const { resolveConnectorResource } = await import("../extension-resource-identity");

const PKG = "@acme/widgets-connector";
const ORG_A = "org-a";
const ORG_B = "org-b";

function row(over: Partial<InstalledExtension>): InstalledExtension {
  return {
    id: "row-" + Math.random().toString(36).slice(2),
    packageName: PKG,
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

function seed(r: InstalledExtension): InstalledExtension {
  rowsByIdentityKey.set(
    keyOf({
      organizationId: r.organizationId,
      ownerLevel: r.ownerLevel,
      ownerId: r.ownerId,
      packageName: r.packageName,
    }),
    r,
  );
  return r;
}

const orgRow = () => row({});
const workspaceRow = () =>
  row({ ownerLevel: "workspace", ownerId: "__platform__", organizationId: null });

beforeEach(() => {
  rowsByIdentityKey = new Map();
  identityReads.length = 0;
});

describe("resolveConnectorResource — the organization's own row", () => {
  it("resolves the org's OWN row when no workspace row exists", async () => {
    const r = seed(orgRow());
    const resolved = await resolveConnectorResource(ORG_A, PKG);
    expect(resolved?.resourceId).toBe(r.id);
    expect(resolved?.owner.organizationId).toBe(ORG_A);
    // Two identity reads: the workspace arm is consulted first and misses.
    expect(identityReads.map((i) => i.ownerLevel)).toEqual(["workspace", "organization"]);
  });

  it("a non-connector row at the org identity fails closed — it does NOT fall through", async () => {
    seed(row({ kind: "artifact" }));
    expect(await resolveConnectorResource(ORG_A, PKG)).toBeNull();
  });
});

describe("resolveConnectorResource — the live workspace row is the effective row", () => {
  it("serves the workspace row to an org that has no row of its own", async () => {
    const ws = seed(workspaceRow());
    const resolved = await resolveConnectorResource(ORG_A, PKG);
    expect(resolved?.resourceId).toBe(ws.id);
    expect(resolved?.owner).toEqual({
      ownerLevel: "workspace",
      ownerId: "__platform__",
      organizationId: null,
    });
  });

  it("serves the SAME workspace row to TWO different organizations", async () => {
    const ws = seed(workspaceRow());
    expect((await resolveConnectorResource(ORG_A, PKG))?.resourceId).toBe(ws.id);
    expect((await resolveConnectorResource(ORG_B, PKG))?.resourceId).toBe(ws.id);
  });

  it("a LIVE workspace row supersedes the organization's own row for EVERY org", async () => {
    // cinatra#2698: the organization's row is superseded, so it is not the row
    // whose permissions and owner context govern the connector — not even for
    // the organization that installed it.
    seed(orgRow());
    const ws = seed(workspaceRow());
    expect((await resolveConnectorResource(ORG_A, PKG))?.resourceId).toBe(ws.id);
    expect((await resolveConnectorResource(ORG_B, PKG))?.resourceId).toBe(ws.id);
  });

  it("an ARCHIVED workspace row supersedes nothing — the organization row governs", async () => {
    const own = seed(orgRow());
    seed(row({ ownerLevel: "workspace", ownerId: "__platform__", organizationId: null, status: "archived" }));
    expect((await resolveConnectorResource(ORG_A, PKG))?.resourceId).toBe(own.id);
  });

  it("an archived workspace row still serves an org with NO row of its own", async () => {
    // Status was never a FILTER here and still is not — only a preference.
    const ws = seed(
      row({ ownerLevel: "workspace", ownerId: "__platform__", organizationId: null, status: "archived" }),
    );
    expect((await resolveConnectorResource(ORG_B, PKG))?.resourceId).toBe(ws.id);
  });

  it("a non-connector workspace row fails closed", async () => {
    seed(row({ ownerLevel: "workspace", ownerId: "__platform__", organizationId: null, kind: "artifact" }));
    expect(await resolveConnectorResource(ORG_A, PKG)).toBeNull();
  });

  it("no row anywhere → null (the connector shim's absence-only legacy fallback)", async () => {
    expect(await resolveConnectorResource(ORG_A, PKG)).toBeNull();
  });

  it("an org-LESS caller resolves nothing — unchanged from before S3", async () => {
    seed(workspaceRow());
    expect(await resolveConnectorResource(null, PKG)).toBeNull();
    expect(await resolveConnectorResource(undefined, PKG)).toBeNull();
    expect(identityReads).toHaveLength(0);
  });
});
