import { describe, it, expect, vi, beforeEach } from "vitest";

// Finding 4 (High): boot activation is PLATFORM-GLOBAL (one process, no per-org
// boot context). An ORG-scoped hot install must still resolve at boot — the
// platform-global resolver derives the row's org from the SINGLE live row across
// all orgs, then reads the grant/journal for THAT org. The exact-org resolver
// (the install-time hot-activate path) keeps its precise (package, org) binding.
//
// These tests exercise the REAL makeDefaultInstallAnchorResolver against mocked
// canonical/grant/journal stores — proving an org-scoped row is picked up by the
// platform-global (no-orgId) boot resolver, and that exact-org still binds the
// exact scope. Also covers the pure pickSingleLiveRowAcrossOrgs picker.

type Row = {
  id: string;
  status: string;
  organizationId: string | null;
  source: {
    type?: string;
    registryUrl?: string;
    integrity?: string;
    contentHash?: string;
    version?: string;
  } | null;
};
type Grant = { status: string; approvedPorts: string[]; orgId: string | null };
type Op = { phase: string; orgId: string | null };

let canonicalRows: Row[] = [];
let grants: Grant[] = [];
let ops: Op[] = [];

const readInstalledExtensionsByPackageName = vi.fn(async () => canonicalRows);
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: (...a: unknown[]) =>
    readInstalledExtensionsByPackageName(...(a as [])),
}));

const readGrant = vi.fn(async ({ orgId }: { packageName: string; orgId: string | null }) => {
  return grants.find((g) => (g.orgId ?? null) === (orgId ?? null)) ?? null;
});
vi.mock("@/lib/extension-host-port-grants", () => ({
  readGrant: (...a: unknown[]) => readGrant(...(a as [{ packageName: string; orgId: string | null }])),
}));

const readInstallOp = vi.fn(async (_pkg: string, orgId: string | null) => {
  return ops.find((o) => (o.orgId ?? null) === (orgId ?? null)) ?? null;
});
vi.mock("@/lib/extension-install-ops", () => ({
  readInstallOp: (...a: unknown[]) => readInstallOp(...(a as [string, string | null])),
}));

import {
  makeDefaultInstallAnchorResolver,
  pickSingleLiveRowAcrossOrgs,
} from "@/lib/extension-install-anchor";

const REGISTRY = "https://registry.cinatra.ai";

function realRow(p: Partial<Row>): Row {
  return {
    id: "iext_x",
    status: "active",
    organizationId: null,
    source: {
      type: "verdaccio",
      registryUrl: REGISTRY,
      integrity: "sha512-real",
      contentHash: "deadbeef",
      version: "1.0.0",
    },
    ...p,
  };
}

beforeEach(() => {
  canonicalRows = [];
  grants = [];
  ops = [];
  vi.clearAllMocks();
});

describe("pickSingleLiveRowAcrossOrgs (pure)", () => {
  it("returns the single live row regardless of its org", () => {
    const rows = [realRow({ id: "a", status: "active", organizationId: "org-7" })];
    expect(pickSingleLiveRowAcrossOrgs(rows)?.id).toBe("a");
  });
  it("accepts a locked row", () => {
    const rows = [realRow({ id: "b", status: "locked", organizationId: "org-7" })];
    expect(pickSingleLiveRowAcrossOrgs(rows)?.id).toBe("b");
  });
  it("FAILS CLOSED on >1 live row across orgs (ambiguous)", () => {
    const rows = [
      realRow({ id: "a", organizationId: "org-1" }),
      realRow({ id: "b", organizationId: "org-2" }),
    ];
    expect(pickSingleLiveRowAcrossOrgs(rows)).toBeNull();
  });
  it("ignores archived rows", () => {
    const rows = [
      realRow({ id: "a", status: "archived", organizationId: "org-1" }),
      realRow({ id: "b", status: "active", organizationId: "org-2" }),
    ];
    expect(pickSingleLiveRowAcrossOrgs(rows)?.id).toBe("b");
  });
});

describe("makeDefaultInstallAnchorResolver — PLATFORM-GLOBAL boot resolution (Finding 4)", () => {
  it("the platform-global (no-orgId) boot resolver PICKS UP an ORG-scoped hot install", async () => {
    // The hot install wrote an ORG-scoped row (organization_id = "org-9") +
    // an org-scoped finalized journal + an org-scoped approved grant.
    canonicalRows = [realRow({ id: "iext_org", organizationId: "org-9" })];
    grants = [{ status: "approved", approvedPorts: ["settings"], orgId: "org-9" }];
    ops = [{ phase: "finalized", orgId: "org-9" }];

    // Boot resolver: makeDefaultInstallAnchorResolver() with NO org → platform-global.
    const resolve = await makeDefaultInstallAnchorResolver();
    const anchor = await resolve("@cinatra-ai/org-connector");

    // The org-scoped row is resolved (platform-global load) — it does NOT vanish
    // after a restart. The grant/journal were read for the DERIVED org ("org-9").
    expect(anchor).not.toBeNull();
    expect(anchor?.trustDecision).toBe(true);
    expect(anchor?.approvedPorts).toEqual(["settings"]);
    expect(readGrant).toHaveBeenCalledWith({ packageName: "@cinatra-ai/org-connector", orgId: "org-9" });
    expect(readInstallOp).toHaveBeenCalledWith("@cinatra-ai/org-connector", "org-9");
  });

  it("the platform-global boot resolver also resolves a platform-scoped (org_id NULL) row", async () => {
    canonicalRows = [realRow({ id: "iext_plat", organizationId: null })];
    grants = [{ status: "approved", approvedPorts: [], orgId: null }];
    ops = [{ phase: "finalized", orgId: null }];

    const resolve = await makeDefaultInstallAnchorResolver();
    const anchor = await resolve("@cinatra-ai/plat-connector");
    expect(anchor).not.toBeNull();
    expect(anchor?.trustDecision).toBe(true);
  });

  it("the platform-global boot resolver FAILS CLOSED on >1 live row across orgs", async () => {
    canonicalRows = [
      realRow({ id: "a", organizationId: "org-1" }),
      realRow({ id: "b", organizationId: "org-2" }),
    ];
    grants = [{ status: "approved", approvedPorts: [], orgId: "org-1" }];
    ops = [{ phase: "finalized", orgId: "org-1" }];

    const resolve = await makeDefaultInstallAnchorResolver();
    expect(await resolve("@cinatra-ai/ambiguous")).toBeNull();
  });

  it("an EXACT-ORG resolver binds the precise (package, org) scope (install-time path)", async () => {
    // Two orgs each have a row; the exact-org resolver for org-2 must resolve
    // ONLY org-2's row (the install-time hot-activate path passes the actor's org).
    canonicalRows = [
      realRow({ id: "a", organizationId: "org-1" }),
      realRow({ id: "b", organizationId: "org-2" }),
    ];
    grants = [
      { status: "approved", approvedPorts: ["db"], orgId: "org-2" },
      { status: "approved", approvedPorts: ["secrets"], orgId: "org-1" },
    ];
    ops = [
      { phase: "finalized", orgId: "org-2" },
      { phase: "finalized", orgId: "org-1" },
    ];

    const resolve = await makeDefaultInstallAnchorResolver("org-2");
    const anchor = await resolve("@cinatra-ai/two-org");
    expect(anchor).not.toBeNull();
    // It read the grant/journal for org-2 specifically.
    expect(readGrant).toHaveBeenCalledWith({ packageName: "@cinatra-ai/two-org", orgId: "org-2" });
    expect(anchor?.approvedPorts).toEqual(["db"]);
  });
});
