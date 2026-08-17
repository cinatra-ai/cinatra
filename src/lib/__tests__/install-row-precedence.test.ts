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
import {
  pickExactOrgActiveRow,
  pickSingleActiveRow,
  pickSingleLiveRowAcrossOrgs,
} from "@/lib/extension-install-anchor";
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

// ---------------------------------------------------------------------------
// The BOOT resolver must apply supersession too.
//
// The install path archives the superseded organization rows AFTER the workspace
// install finalizes, and it deliberately skips a LOCKED one. So a live
// organization row stands beside the live workspace row both transiently (a
// reader inside that window) and durably (the locked row). Boot must resolve the
// row in force in both cases, not read the pair as two competing installs.
// ---------------------------------------------------------------------------
describe("pickSingleLiveRowAcrossOrgs applies supersession before precedence", () => {
  const ws = {
    id: "ws",
    status: "active",
    organizationId: null,
    ownerLevel: "workspace",
    ownerId: "__platform__",
    isDefault: true,
    source: { type: "verdaccio" },
  };
  const orgRow = (over: Record<string, unknown> = {}) => ({
    id: "org",
    status: "active",
    organizationId: "org-1",
    ownerLevel: "organization",
    ownerId: "org-1",
    isDefault: true,
    source: { type: "verdaccio" },
    ...over,
  });

  it("resolves the workspace row while a LOCKED org row is still live", () => {
    expect(pickSingleLiveRowAcrossOrgs([orgRow({ status: "locked" }), ws])?.id).toBe("ws");
  });

  it("resolves the workspace row inside the finalize-then-archive window", () => {
    // Both live: the archival has not run yet. A reader must not see ambiguity.
    expect(pickSingleLiveRowAcrossOrgs([orgRow(), ws])?.id).toBe("ws");
  });

  it("a bundled row under the workspace row still loses to it", () => {
    const bundled = {
      id: "plat",
      status: "active",
      organizationId: null,
      ownerLevel: "platform",
      ownerId: null,
      isDefault: true,
      source: { type: "bundled" },
    };
    expect(pickSingleLiveRowAcrossOrgs([bundled, ws])?.id).toBe("ws");
  });

  it("with NO workspace row two competing org installs still fail closed", () => {
    const a = orgRow({ id: "a" });
    const b = orgRow({ id: "b", organizationId: "org-2", ownerId: "org-2" });
    expect(pickSingleLiveRowAcrossOrgs([a, b])).toBeNull();
  });
});

// The INSTALL-TIME picker. `pickSingleActiveRow` is what the install pipeline's
// canonical-row deps resolve through (recordProvenance, persistDependencyEdges,
// persistAccessDeclaration and the widget-auth key write all share one
// `resolveTarget` built on it — src/lib/extension-install-canonical-row-deps.ts).
//
// It is the same two-live-default-rows shape as every other seam, reached from
// the other direction: the marketplace install CREATES the second row, so the
// pair exists while the install that made it is still running. Without the
// shared policy here the install fails closed at its own provenance write and
// rolls itself back, which makes the override permanently uninstallable over a
// bundled package. Measured against the running application before this seam
// applied the policy: "recordProvenance: expected exactly 1 active
// installed_extension row … (0 or ambiguous owner scope) — fail closed".
describe("pickSingleActiveRow applies source precedence", () => {
  const platformBundled = {
    id: "bundled",
    status: "active",
    organizationId: null,
    ownerLevel: "platform",
    ownerId: "__platform__",
    isDefault: true,
    source: { type: "bundled", packageName: "@x/y", version: "0.1.0" },
  };
  const workspaceInstall = {
    id: "installed",
    status: "active",
    organizationId: null,
    ownerLevel: "workspace",
    ownerId: "__platform__",
    isDefault: true,
    source: { type: "verdaccio", packageName: "@x/y", version: "0.1.2" },
  };

  it("resolves the marketplace row over the bundled anchor in one scope", () => {
    expect(pickSingleActiveRow([platformBundled, workspaceInstall], null)?.id).toBe(
      "installed",
    );
  });

  it("is order independent", () => {
    expect(pickSingleActiveRow([workspaceInstall, platformBundled], null)?.id).toBe(
      "installed",
    );
  });

  it("still resolves the bundled anchor when no override exists", () => {
    expect(pickSingleActiveRow([platformBundled], null)?.id).toBe("bundled");
  });

  it("two competing marketplace installs still fail closed", () => {
    const other = { ...workspaceInstall, id: "other", ownerLevel: "platform" };
    expect(pickSingleActiveRow([workspaceInstall, other], null)).toBeNull();
  });

  it("rows of an unknown provenance keep the previous exactly-one rule", () => {
    const legacyA = { id: "a", status: "active", organizationId: null, isDefault: true };
    const legacyB = { id: "b", status: "active", organizationId: null, isDefault: true };
    expect(pickSingleActiveRow([legacyA], null)?.id).toBe("a");
    expect(pickSingleActiveRow([legacyA, legacyB], null)).toBeNull();
  });

  it("an out-of-scope org row is filtered before the policy runs", () => {
    const otherOrg = { ...workspaceInstall, id: "other-org", organizationId: "org-9" };
    expect(pickSingleActiveRow([platformBundled, otherOrg], null)?.id).toBe("bundled");
  });
});

// ---------------------------------------------------------------------------
// The install-time picker must apply SUPERSESSION FIRST, like its siblings.
//
// It applied precedence WITHOUT supersession, and its exact-scope filter is what
// hid the omission: the superseding WORKSPACE row lives at org-NULL and the row
// it supersedes lives at an organization scope, so the pair is never in one
// picker call. `runInstallAnchorClaimBackstop`
// (src/lib/objects/artifact-claim-install-anchor.ts) walks EVERY live org scope
// and calls this picker once per scope — so it asked for the superseded scope,
// this picker answered with the superseded row, and the backstop activated a
// claim against a row the rest of the system had already replaced.
// ---------------------------------------------------------------------------
describe("pickSingleActiveRow applies supersession before precedence", () => {
  const ws = {
    id: "ws",
    status: "active",
    organizationId: null,
    ownerLevel: "workspace",
    ownerId: "__platform__",
    isDefault: true,
    source: { type: "verdaccio" },
  };
  const orgRow = (over: Record<string, unknown> = {}) => ({
    id: "org",
    status: "active",
    organizationId: "org-1",
    ownerLevel: "organization",
    ownerId: "org-1",
    isDefault: true,
    source: { type: "verdaccio" },
    ...over,
  });

  it("a superseded ORG scope resolves NOTHING while the workspace row is live", () => {
    // The claim backstop's exact call. Before the fix this returned the org row.
    expect(pickSingleActiveRow([orgRow(), ws], "org-1")).toBeNull();
  });

  it("holds for a LOCKED org row, the one the install path deliberately skips", () => {
    expect(pickSingleActiveRow([orgRow({ status: "locked" }), ws], "org-1")).toBeNull();
  });

  it("the workspace scope itself still resolves the row in force", () => {
    expect(pickSingleActiveRow([orgRow(), ws], null)?.id).toBe("ws");
  });

  it("with NO workspace row the org row still resolves, unchanged", () => {
    expect(pickSingleActiveRow([orgRow()], "org-1")?.id).toBe("org");
  });

  it("a PLATFORM anchor at org-NULL supersedes nothing — the org row still resolves", () => {
    // Only a WORKSPACE-anchored row supersedes; a bundled platform anchor sits at
    // the same org-NULL scope and must not take an organization's install away.
    const bundledPlatform = {
      id: "plat",
      status: "active",
      organizationId: null,
      ownerLevel: "platform",
      ownerId: null,
      isDefault: true,
      source: { type: "bundled" },
    };
    expect(pickSingleActiveRow([orgRow(), bundledPlatform], "org-1")?.id).toBe("org");
  });

  it("rows carrying no ownerLevel at all are passed through untouched", () => {
    // Legacy/fixture rows: no anchor data → no supersession → the pre-S4 outcome.
    const legacy = { id: "a", status: "active", organizationId: "org-1", isDefault: true };
    expect(pickSingleActiveRow([legacy], "org-1")?.id).toBe("a");
  });

  it("`pickExactOrgActiveRow` still answers THIS ORG'S OWN row, supersession or not", () => {
    // The install-anchor resolver's `exact-org` arm asks a different question,
    // and the owner's 2026-08-16 ruling kept that arm unchanged when
    // `org-then-workspace` was inverted to workspace-first. The two pickers are
    // one body plus that one rule, so they can only differ where they must.
    expect(pickExactOrgActiveRow([orgRow(), ws], "org-1")?.id).toBe("org");
    expect(pickSingleActiveRow([orgRow(), ws], "org-1")).toBeNull();
    // Identical everywhere supersession does not apply.
    expect(pickExactOrgActiveRow([orgRow()], "org-1")?.id).toBe("org");
    expect(pickExactOrgActiveRow([orgRow(), ws], null)?.id).toBe("ws");
  });
});
