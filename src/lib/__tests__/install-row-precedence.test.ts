// Source-aware install-row precedence: the picker acceptance item.
//
// The defect: a package that ships in the image AND has a marketplace install
// holds two live default rows. Every row-selection seam read that pair as
// ambiguity and refused, so the boot resolver produced no anchor, the loader
// logged "no trusted install record", and NEITHER version served. The
// marketplace install shadowed the working bundled one without replacing it.
//
// The policy is stated once and applied by every seam, so setup, settings, the
// action route and the provider writer can never disagree about which row is the
// package.
import { describe, it, expect } from "vitest";
import { applyInstallRowPrecedence } from "@cinatra-ai/extensions/static-bundle-anchor";
import { pickSingleLiveRowAcrossOrgs } from "@/lib/extension-install-anchor";
import {
  pickActiveInstall,
  type InstallRowForPick,
} from "@/lib/extension-install-resolution";

const bundled = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: "active",
  organizationId: null,
  source: { type: "bundled", packageName: "@x/y", version: "0.1.0" },
  ...over,
});
const marketplace = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: "active",
  organizationId: "org-1",
  source: { type: "verdaccio", packageName: "@x/y", version: "0.1.1" },
  ...over,
});

describe("applyInstallRowPrecedence", () => {
  it("one marketplace default OUTRANKS the bundled fallback row", () => {
    const picked = applyInstallRowPrecedence([bundled("plat"), marketplace("org")]);
    expect(picked.map((r) => r.id)).toEqual(["org"]);
  });

  it("order does not matter: the override wins whichever way the rows arrive", () => {
    const picked = applyInstallRowPrecedence([marketplace("org"), bundled("plat")]);
    expect(picked.map((r) => r.id)).toEqual(["org"]);
  });

  it("TWO marketplace defaults drop every candidate, so the caller fails closed", () => {
    const picked = applyInstallRowPrecedence([
      bundled("plat"),
      marketplace("org-a"),
      marketplace("org-b", { organizationId: "org-2" }),
    ]);
    expect(picked).toEqual([]);
  });

  it("bundled only: the input is returned unchanged", () => {
    const rows = [bundled("plat")];
    expect(applyInstallRowPrecedence(rows)).toEqual(rows);
  });

  it("a NON-default marketplace sibling never becomes the override", () => {
    const picked = applyInstallRowPrecedence([
      bundled("plat"),
      marketplace("sibling", { isDefault: false }),
    ]);
    // No default override present, so the bundled fallback still decides.
    expect(picked.map((r) => r.id)).toEqual(["plat", "sibling"]);
  });

  it("a row of some OTHER provenance leaves the whole set untouched", () => {
    const rows = [
      bundled("plat"),
      marketplace("org"),
      { id: "legacy", status: "active", organizationId: null, source: { type: "local" } },
    ];
    expect(applyInstallRowPrecedence(rows)).toEqual(rows);
  });

  it("is a no-op below two candidates", () => {
    expect(applyInstallRowPrecedence([])).toEqual([]);
    const one = [marketplace("org")];
    expect(applyInstallRowPrecedence(one)).toEqual(one);
  });
});

describe("pickSingleLiveRowAcrossOrgs: the boot resolver seam", () => {
  it("resolves the marketplace override instead of failing closed on the pair", () => {
    // Before precedence this returned null, which is exactly what produced
    // "no trusted install record" and a package that served nothing.
    const picked = pickSingleLiveRowAcrossOrgs([bundled("plat"), marketplace("org")]);
    expect(picked?.id).toBe("org");
  });

  it("still fails closed on two competing marketplace installs", () => {
    expect(
      pickSingleLiveRowAcrossOrgs([
        bundled("plat"),
        marketplace("org-a"),
        marketplace("org-b", { organizationId: "org-2" }),
      ]),
    ).toBeNull();
  });

  it("bundled-only is unchanged: the single live default resolves", () => {
    expect(pickSingleLiveRowAcrossOrgs([bundled("plat")])?.id).toBe("plat");
  });

  it("an ARCHIVED override does not outrank a live bundled row", () => {
    const picked = pickSingleLiveRowAcrossOrgs([
      bundled("plat"),
      marketplace("org", { status: "archived" }),
    ]);
    expect(picked?.id).toBe("plat");
  });

  it("a LOCKED marketplace row is live and still wins", () => {
    const picked = pickSingleLiveRowAcrossOrgs([
      bundled("plat"),
      marketplace("org", { status: "locked" }),
    ]);
    expect(picked?.id).toBe("org");
  });
});

// ---------------------------------------------------------------------------
// SUPERSESSION COMES FIRST, PRECEDENCE SECOND.
//
// A live workspace install is the one row in force and supersedes every
// organization row of the same package. The install path archives those org
// rows, but it deliberately SKIPS a LOCKED one, so a live locked org row can
// still stand beside the live workspace row.
//
// Precedence must not see that pair. Both rows are product-installed defaults,
// so to precedence alone they look like competing peers and its fail-closed arm
// would drop both, leaving the seam with no row to address. Which
// product-installed row is in force is supersession's question; precedence only
// answers product-install versus the copy bundled in the image.
// ---------------------------------------------------------------------------
describe("supersession is applied before precedence", () => {
  /** The pick type plus the provenance the precedence policy reads: real rows
   *  always carry `source`, the narrowed pick type simply does not name it. */
  type PickRow = InstallRowForPick & {
    source: { type: string; packageName?: string; version?: string };
  };
  const workspaceRow: PickRow = {
    id: "ws",
    status: "active",
    organizationId: null,
    ownerLevel: "workspace",
    ownerId: "__platform__",
    isDefault: true,
    source: { type: "verdaccio", packageName: "@x/y", version: "0.1.1" },
  };
  const lockedOrgRow: PickRow = {
    id: "org-locked",
    status: "locked",
    organizationId: "org-1",
    ownerLevel: "organization",
    ownerId: "org-1",
    isDefault: true,
    source: { type: "verdaccio", packageName: "@x/y", version: "0.1.0" },
  };
  const actor = {
    organizationId: "org-1",
    ownerId: "user-1",
    teamIds: [] as string[],
    orgRole: "org_owner" as const,
  };

  it("addresses the workspace row when a superseded LOCKED org row is still live", () => {
    const picked = pickActiveInstall([lockedOrgRow, workspaceRow], actor);
    // Not null, and specifically the row in force.
    expect(picked?.id).toBe("ws");
  });

  it("is order-independent", () => {
    expect(pickActiveInstall([workspaceRow, lockedOrgRow], actor)?.id).toBe("ws");
  });

  it("with NO workspace row the org row still resolves, unchanged", () => {
    expect(pickActiveInstall([lockedOrgRow], actor)?.id).toBe("org-locked");
  });

  it("a bundled row beside the workspace row still loses to it", () => {
    const bundledPlatform: PickRow = {
      id: "plat",
      status: "active",
      organizationId: null,
      ownerLevel: "platform",
      ownerId: null,
      isDefault: true,
      source: { type: "bundled", packageName: "@x/y", version: "0.1.0" },
    };
    expect(pickActiveInstall([bundledPlatform, workspaceRow], actor)?.id).toBe("ws");
  });
});
