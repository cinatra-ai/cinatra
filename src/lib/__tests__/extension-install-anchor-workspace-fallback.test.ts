// cinatra#2694 / S3 #2697 — the runtime connector card record's TRUST-ANCHOR
// resolution gains org-row-first / workspace-fallback.
//
// The card gate is: (a) an active canonical install addressable in the actor's
// scope, then (b) a non-null TRUSTED anchor. Before S3, (a) already admitted a
// workspace-anchored ("Workspace: All") row — the addressability predicate
// fences only rows that HAVE an owning org — while (b) resolved at EXACT-ORG
// only, so the anchor came back null for every organization and the card could
// never render. The `org-then-workspace` scope closes exactly that, without
// letting one org's source ever be resolved against another ORG's journal/grant.

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = {
  id: string;
  status: string;
  organizationId: string | null;
  ownerLevel?: string;
  ownerId?: string | null;
  isDefault?: boolean;
  source: Record<string, unknown> | null;
};
type Grant = { status: string; approvedPorts: string[]; orgId: string | null };
type Op = { phase: string; orgId: string | null };

let canonicalRows: Row[] = [];
let grants: Grant[] = [];
let ops: Op[] = [];

vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  readInstalledExtensionsByPackageName: async () => canonicalRows,
}));

const readGrant = vi.fn(async ({ orgId }: { packageName: string; orgId: string | null }) =>
  grants.find((g) => (g.orgId ?? null) === (orgId ?? null)) ?? null,
);
vi.mock("@/lib/extension-host-port-grants", () => ({
  readGrant: (...a: unknown[]) => readGrant(...(a as [{ packageName: string; orgId: string | null }])),
}));

const readInstallOp = vi.fn(async (_pkg: string, orgId: string | null) =>
  ops.find((o) => (o.orgId ?? null) === (orgId ?? null)) ?? null,
);
vi.mock("@/lib/extension-install-ops", () => ({
  readInstallOp: (...a: unknown[]) => readInstallOp(...(a as [string, string | null])),
}));

import {
  makeDefaultInstallAnchorResolver,
  pickSingleWorkspaceAnchoredActiveRow,
} from "@/lib/extension-install-anchor";

const PKG = "@acme/widgets-connector";
const ORG_A = "org-a";
const ORG_B = "org-b";

function realRow(p: Partial<Row>): Row {
  return {
    id: "iext_x",
    status: "active",
    organizationId: null,
    source: {
      type: "verdaccio",
      registryUrl: "https://registry.cinatra.ai",
      integrity: "sha512-real",
      contentHash: "deadbeef",
      version: "1.0.0",
    },
    ...p,
  };
}

const workspaceRow = (p: Partial<Row> = {}) =>
  realRow({
    id: "iext_ws",
    ownerLevel: "workspace",
    ownerId: "__platform__",
    organizationId: null,
    ...p,
  });

const orgRow = (orgId: string, p: Partial<Row> = {}) =>
  realRow({ id: `iext_${orgId}`, ownerLevel: "organization", ownerId: orgId, organizationId: orgId, ...p });

beforeEach(() => {
  canonicalRows = [];
  grants = [];
  ops = [];
  vi.clearAllMocks();
});

describe("pickSingleWorkspaceAnchoredActiveRow (pure)", () => {
  it("resolves the live workspace-anchored row", () => {
    canonicalRows = [workspaceRow()];
    expect(pickSingleWorkspaceAnchoredActiveRow(canonicalRows)?.id).toBe("iext_ws");
  });

  it("accepts a LOCKED row (removal-protected, still live)", () => {
    expect(pickSingleWorkspaceAnchoredActiveRow([workspaceRow({ status: "locked" })])?.id).toBe("iext_ws");
  });

  it("ignores an ARCHIVED workspace row", () => {
    expect(pickSingleWorkspaceAnchoredActiveRow([workspaceRow({ status: "archived" })])).toBeNull();
  });

  it("ignores a PLATFORM row at the same org-NULL scope — and is not made ambiguous by it", () => {
    const rows = [
      realRow({ id: "iext_bundled", ownerLevel: "platform", ownerId: "__platform__", organizationId: null }),
      workspaceRow(),
    ];
    expect(pickSingleWorkspaceAnchoredActiveRow(rows)?.id).toBe("iext_ws");
  });

  it("ignores ORG rows entirely", () => {
    expect(pickSingleWorkspaceAnchoredActiveRow([orgRow(ORG_A)])).toBeNull();
  });

  it("keeps the exact-one-default rule (a non-default sibling does not promote)", () => {
    expect(
      pickSingleWorkspaceAnchoredActiveRow([workspaceRow({ isDefault: false })]),
    ).toBeNull();
    expect(
      pickSingleWorkspaceAnchoredActiveRow([
        workspaceRow({ id: "def", isDefault: true }),
        workspaceRow({ id: "sbs", isDefault: false }),
      ])?.id,
    ).toBe("def");
  });
});

describe("makeDefaultInstallAnchorResolver — 'org-then-workspace' (the #2697 card seam)", () => {
  it("EXACT-ORG returns null for a workspace-anchored row — the pre-S3 gap, pinned", async () => {
    canonicalRows = [workspaceRow()];
    ops = [{ phase: "finalized", orgId: null }];
    const resolve = await makeDefaultInstallAnchorResolver(ORG_A, "exact-org");
    expect(await resolve(PKG)).toBeNull();
  });

  it("resolves the workspace row for an org actor, binding the WORKSPACE row's own scope", async () => {
    canonicalRows = [workspaceRow()];
    grants = [{ status: "approved", approvedPorts: ["settings"], orgId: null }];
    ops = [{ phase: "finalized", orgId: null }];

    const resolve = await makeDefaultInstallAnchorResolver(ORG_A, "org-then-workspace");
    const anchor = await resolve(PKG);

    expect(anchor).not.toBeNull();
    expect(anchor?.installId).toBe("iext_ws");
    expect(anchor?.orgId).toBeNull();
    // The grant + journal were read at the WORKSPACE row's scope (org NULL) —
    // never the actor's organization.
    expect(readGrant).toHaveBeenCalledWith({ packageName: PKG, orgId: null });
    expect(readInstallOp).toHaveBeenCalledWith(PKG, null);
    expect(anchor?.approvedPorts).toEqual(["settings"]);
  });

  it("serves the SAME workspace row to a SECOND organization", async () => {
    canonicalRows = [workspaceRow()];
    ops = [{ phase: "finalized", orgId: null }];
    for (const org of [ORG_A, ORG_B]) {
      const resolve = await makeDefaultInstallAnchorResolver(org, "org-then-workspace");
      expect((await resolve(PKG))?.installId, org).toBe("iext_ws");
    }
  });

  it("the ORG's own row WINS where both exist — byte-identical to exact-org", async () => {
    canonicalRows = [orgRow(ORG_A), workspaceRow()];
    grants = [{ status: "approved", approvedPorts: ["a"], orgId: ORG_A }];
    ops = [
      { phase: "finalized", orgId: ORG_A },
      { phase: "finalized", orgId: null },
    ];

    const viaFallbackScope = await (await makeDefaultInstallAnchorResolver(ORG_A, "org-then-workspace"))(PKG);
    const viaExactOrg = await (await makeDefaultInstallAnchorResolver(ORG_A, "exact-org"))(PKG);
    expect(viaFallbackScope?.installId).toBe(`iext_${ORG_A}`);
    expect(viaFallbackScope?.orgId).toBe(ORG_A);
    expect(viaFallbackScope).toEqual(viaExactOrg);
  });

  it("…while the OTHER organization gets the workspace row", async () => {
    canonicalRows = [orgRow(ORG_A), workspaceRow()];
    ops = [
      { phase: "finalized", orgId: ORG_A },
      { phase: "finalized", orgId: null },
    ];
    const anchor = await (await makeDefaultInstallAnchorResolver(ORG_B, "org-then-workspace"))(PKG);
    expect(anchor?.installId).toBe("iext_ws");
    expect(anchor?.orgId).toBeNull();
  });

  it("never falls back to ANOTHER ORG's row", async () => {
    canonicalRows = [orgRow(ORG_B)];
    ops = [{ phase: "finalized", orgId: ORG_B }];
    const anchor = await (await makeDefaultInstallAnchorResolver(ORG_A, "org-then-workspace"))(PKG);
    expect(anchor).toBeNull();
  });

  it("does NOT fall back to a bundled/system PLATFORM row", async () => {
    canonicalRows = [
      realRow({ id: "iext_bundled", ownerLevel: "platform", ownerId: "__platform__", organizationId: null }),
    ];
    ops = [{ phase: "finalized", orgId: null }];
    const anchor = await (await makeDefaultInstallAnchorResolver(ORG_A, "org-then-workspace"))(PKG);
    expect(anchor).toBeNull();
  });

  it("an ARCHIVED workspace row anchors nothing (fail closed)", async () => {
    canonicalRows = [workspaceRow({ status: "archived" })];
    ops = [{ phase: "finalized", orgId: null }];
    const anchor = await (await makeDefaultInstallAnchorResolver(ORG_A, "org-then-workspace"))(PKG);
    expect(anchor).toBeNull();
  });

  it("a workspace row with no FINALIZED journal anchors nothing (the trust gate is untouched)", async () => {
    canonicalRows = [workspaceRow()];
    ops = [{ phase: "materialized", orgId: null }];
    const anchor = await (await makeDefaultInstallAnchorResolver(ORG_A, "org-then-workspace"))(PKG);
    expect(anchor).toBeNull();
  });
});
