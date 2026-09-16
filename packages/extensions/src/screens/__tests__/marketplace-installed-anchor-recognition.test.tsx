/**
 * The marketplace listing card's four-state install control, read from the
 * page's OWN install-state read — cinatra#3522.
 *
 * THE DEFECT (measured 2026-09-16 on a development instance, picture round of
 * cinatra#3494). Six packages the image ships — a connector, four artifacts and
 * a core skill — each carried an ACTIVE `installed_extension` row at their
 * bundled version, and every one of their cards still drew a LIVE "Install now".
 *
 * THE CAUSE is upstream of the drawing. `marketplace-card-nodes.tsx` already
 * draws all four states off the card model, and `marketplace-card-model.ts`
 * already decides them from `installedVersionByName` — but the map never got an
 * entry for those six. `extensions-marketplace-screen.tsx`'s
 * `applyWorkspaceInstallState` overlaid a live WORKSPACE-anchored row only
 * (`findLiveWorkspaceRow`), and `isWorkspaceAnchoredRow` (canonical-types.ts)
 * deliberately excludes `owner_level='platform'` — which is exactly the tier the
 * boot seeder writes a bundled package's anchor at
 * (src/lib/static-bundle-lifecycle.ts:441, `ownerLevel: "platform"`). So the
 * package read back as "no row", and no row renders as "not installed".
 *
 * WHAT IS PINNED HERE, against the ratified drawing (the design spec
 * `specs/app-extensions.html` §I): "The install CTA is the four-state machine
 * taken straight from /configuration/marketplace: Install now when it isn't
 * installed, a disabled Installed pill at the current version, Update now when a
 * newer version sits in the catalog, and Restore for one that was removed."
 *
 * The six-listing shape of the measurement is driven through the read's own rule
 * (`findLiveInstalledAnchorRow`) into the map the screen hands the grid, and the
 * grid is RENDERED — each card's control text and disabled state read back out
 * of the markup, which is the same reading the proof round takes off the DOM.
 *
 * The `"use client"` halves of the composition are stood in as same-named,
 * same-props passthroughs (the sibling marketplace-payload-weight suite's own
 * pattern) so the suite stays out of the browser dependency graph; every
 * assertion below lands on REAL components — the listing card, the CTA Button
 * and the card model.
 */
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { InstalledExtension } from "../../canonical-types";
import { findLiveInstalledAnchorRow } from "../../lifecycle-target-resolver";
import type { MarketplaceCardData } from "../marketplace-card-model";

vi.mock("../marketplace-detail-modal", async () => {
  const { Button } = await import("@/components/ui/button");
  return {
    MarketplaceDetailModal: () => <Button variant="link">More details</Button>,
  };
});
vi.mock("../card-face-switcher", async () => {
  const { Button } = await import("@/components/ui/button");
  const Passthrough = ({ children }: { children?: ReactNode }) => (
    <Button size="sm">{children}</Button>
  );
  return {
    CardFaceSwitcher: ({ children }: { children?: ReactNode }) => <>{children}</>,
    InstallPanelOpenButton: Passthrough,
    InstallPanelCloseButton: Passthrough,
  };
});
vi.mock("../marketplace-card-shell", () => ({
  MarketplaceCardInstallShell: ({ idleFace }: { idleFace: ReactNode }) => <>{idleFace}</>,
}));
vi.mock("../marketplace-install-form", async () => {
  const { Button } = await import("@/components/ui/button");
  return {
    MarketplaceInstallForm: ({ children }: { children?: ReactNode }) => <form>{children}</form>,
    MarketplaceInstallSubmit: ({ children }: { children?: ReactNode }) => (
      <Button size="sm">{children}</Button>
    ),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The measurement's six listings, with a fictional vendor scope.
// ---------------------------------------------------------------------------

type Listing = {
  packageName: string;
  displayName: string;
  kindSlug: MarketplaceCardData["kindSlug"];
  kindLabel: string;
  /** The version the CATALOGUE offers. */
  catalogVersion: string;
  /** The version the instance has installed, or null for a listing with no row. */
  installedVersion: string | null;
};

const LISTINGS: Listing[] = [
  {
    packageName: "@example-vendor/appointment-schedules-connector",
    displayName: "Appointment Schedules",
    kindSlug: "connector",
    kindLabel: "Connector",
    catalogVersion: "0.1.1",
    installedVersion: "0.1.1",
  },
  {
    packageName: "@example-vendor/chart-artifact",
    displayName: "Chart",
    kindSlug: "artifact",
    kindLabel: "Artifact",
    catalogVersion: "0.1.0",
    installedVersion: "0.1.0",
  },
  {
    packageName: "@example-vendor/pdf-artifact",
    displayName: "PDF Extractor",
    kindSlug: "artifact",
    kindLabel: "Artifact",
    // The catalogue moved ahead of the bundled version: the drawing's
    // "Update now when a newer version sits in the catalog".
    catalogVersion: "0.1.2",
    installedVersion: "0.1.1",
  },
  {
    packageName: "@example-vendor/video-artifact",
    displayName: "Video",
    kindSlug: "artifact",
    kindLabel: "Artifact",
    catalogVersion: "0.1.1",
    installedVersion: "0.1.1",
  },
  {
    packageName: "@example-vendor/chat-assistant-core-skill",
    displayName: "Chat Assistant Core",
    kindSlug: "skill",
    kindLabel: "Skill",
    catalogVersion: "0.1.2",
    installedVersion: "0.1.2",
  },
  {
    packageName: "@example-vendor/meeting-notes-skill",
    displayName: "Meeting Notes",
    kindSlug: "skill",
    kindLabel: "Skill",
    catalogVersion: "0.4.0",
    // Not installed at all — the drawing's "Install now when it isn't installed".
    installedVersion: null,
  },
];

function cardOf(listing: Listing): MarketplaceCardData {
  return {
    packageName: listing.packageName,
    packageVersion: listing.catalogVersion,
    displayName: listing.displayName,
    description: "Fixture listing.",
    kindSlug: listing.kindSlug,
    kindLabel: listing.kindLabel,
    badge: { text: "Free", variant: "free" },
    freshnessAt: "2026-09-01T00:00:00Z",
    rating: { average: 4.5, count: 40 },
    detailHref: `/configuration/marketplace/example-vendor/${listing.displayName}`,
    installCount: 120,
    manifestLogoUrl: null,
    iconSlug: null,
    iconUrl: null,
    vendorLogoUrl: null,
    sdkAbiRange: null,
    vendor: null,
  } as MarketplaceCardData;
}

/**
 * The BUNDLED/FLEET anchor row the boot seeder writes: `owner_level='platform'`,
 * `organization_id IS NULL`, live, at the image's version. This is the shape the
 * screen's canonical read hands the overlay.
 */
function platformAnchorRow(listing: Listing): InstalledExtension {
  return {
    id: `iext_${listing.displayName.toLowerCase().replace(/\W+/g, "")}`,
    packageName: listing.packageName,
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: listing.kindSlug === "skill" ? "skill" : listing.kindSlug,
    status: "active",
    source: {
      type: "bundled",
      packageName: listing.packageName,
      version: listing.installedVersion ?? "0.0.0",
    },
    version: listing.installedVersion ?? "0.0.0",
    requiredInProd: true,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as InstalledExtension;
}

/**
 * The map the marketplace page hands the grid, built through the READ'S OWN
 * RULE — `findLiveInstalledAnchorRow`, the seam `applyWorkspaceInstallState`
 * delegates the tier ranking to. A platform anchor carries no workspace reach,
 * so the ordinary four-state control applies to it.
 */
function installedVersionByNameFromRows(
  rowsByName: Map<string, InstalledExtension[]>,
): Map<string, { version: string; isArchived: boolean; workspaceReach?: "workspace" | "admin" }> {
  const map = new Map<
    string,
    { version: string; isArchived: boolean; workspaceReach?: "workspace" | "admin" }
  >();
  for (const rows of rowsByName.values()) {
    const picked = findLiveInstalledAnchorRow(rows);
    if (!picked) continue;
    map.set(picked.row.packageName, {
      version: picked.row.version ?? "",
      isArchived: false,
      ...(picked.isWorkspaceAnchor ? { workspaceReach: "workspace" as const } : {}),
    });
  }
  return map;
}

const noopAction = async () => undefined;

type ControlReading = { packageName: string; ctaState: string; text: string; disabled: boolean };

async function renderGrid(): Promise<ControlReading[]> {
  const { buildMarketplaceCardNodes } = await import("../marketplace-card-nodes");
  const rowsByName = new Map<string, InstalledExtension[]>();
  for (const listing of LISTINGS) {
    if (listing.installedVersion === null) continue;
    rowsByName.set(listing.packageName, [platformAnchorRow(listing)]);
  }
  const nodes = buildMarketplaceCardNodes({
    cards: LISTINGS.map(cardOf),
    installedVersionByName: installedVersionByNameFromRows(rowsByName),
    registryConnected: true,
    installAction: noopAction,
    updateAction: noopAction,
    restoreAction: noopAction,
  });
  return nodes.map(({ meta, node }) => {
    const html = renderToStaticMarkup(node as never);
    const slot = html.match(/<div[^>]*data-cta-state="([a-z]+)"[^>]*>([\s\S]*?)<\/div>/);
    const ctaState = slot?.[1] ?? "";
    const slotHtml = slot?.[2] ?? "";
    const button = slotHtml.match(/<button([^>]*)>([\s\S]*?)<\/button>/);
    return {
      packageName: meta.packageName,
      ctaState,
      text: (button?.[2] ?? "").replace(/<[^>]*>/g, "").trim(),
      disabled: /(^|\s)disabled(=|\s|$)/.test(button?.[1] ?? ""),
    };
  });
}

function reading(readings: ControlReading[], packageName: string): ControlReading {
  const found = readings.find((r) => r.packageName === packageName);
  if (!found) throw new Error(`no card rendered for ${packageName}`);
  return found;
}

describe("marketplace listing cards — a bundled/fleet installed package is recognised as installed (cinatra#3522)", () => {
  it("renders the six-listing shape of the measurement with one control per state", async () => {
    const readings = await renderGrid();
    expect(readings).toHaveLength(6);

    // "a disabled Installed pill at the current version" — the four listings the
    // instance has at exactly the catalogue's version.
    for (const packageName of [
      "@example-vendor/appointment-schedules-connector",
      "@example-vendor/chart-artifact",
      "@example-vendor/video-artifact",
      "@example-vendor/chat-assistant-core-skill",
    ]) {
      const r = reading(readings, packageName);
      expect(r.ctaState, packageName).toBe("installed");
      expect(r.text, packageName).toBe("Installed");
      expect(r.disabled, packageName).toBe(true);
    }

    // "Update now when a newer version sits in the catalog".
    const stale = reading(readings, "@example-vendor/pdf-artifact");
    expect(stale.ctaState).toBe("update");
    expect(stale.text).toBe("Update now");
    expect(stale.disabled).toBe(false);

    // "Install now when it isn't installed".
    const absent = reading(readings, "@example-vendor/meeting-notes-skill");
    expect(absent.ctaState).toBe("install");
    expect(absent.text).toBe("Install now");
    expect(absent.disabled).toBe(false);
  });

  it("never draws a live Install now for a package carrying a live installed row", async () => {
    const readings = await renderGrid();
    const installedPackages = new Set(
      LISTINGS.filter((l) => l.installedVersion !== null).map((l) => l.packageName),
    );
    for (const r of readings) {
      if (!installedPackages.has(r.packageName)) continue;
      expect(r.ctaState, r.packageName).not.toBe("install");
      expect(r.text, r.packageName).not.toBe("Install now");
    }
  });

  it("recognises the live PLATFORM anchor as the package's install state, with no workspace reach", () => {
    const listing = LISTINGS[0]!;
    const picked = findLiveInstalledAnchorRow([platformAnchorRow(listing)]);
    expect(picked).not.toBeNull();
    expect(picked?.isWorkspaceAnchor).toBe(false);
    expect(picked?.row.version).toBe("0.1.1");
  });

  it("leaves an ARCHIVED platform anchor unrecognised (a removed package is not installed)", () => {
    const listing = LISTINGS[0]!;
    const archived = { ...platformAnchorRow(listing), status: "archived" } as InstalledExtension;
    expect(findLiveInstalledAnchorRow([archived])).toBeNull();
  });
});

describe("the marketplace page's read delegates the tier ranking to the shared seam (cinatra#3522)", () => {
  // The screen is a React Server Component wired to auth + DB reads and cannot
  // be imported in this package's node-environment sandbox (the sibling
  // extensions-marketplace-screen-registry-link suite records the same
  // constraint), so the wiring is asserted against the screen's own source.
  const screenSource = readFileSync(
    path.join(__dirname, "..", "extensions-marketplace-screen.tsx"),
    "utf8",
  );

  it("overlays the install map through findLiveInstalledAnchorRow, not the workspace-only pick", () => {
    expect(screenSource).toContain("findLiveInstalledAnchorRow");
    expect(screenSource).not.toContain("findLiveWorkspaceRow");
  });

  it("writes the bundled/fleet tier's entry without a workspace reach label", () => {
    expect(screenSource).toContain("for (const row of livePlatformRows)");
    const platformBlock = screenSource.slice(
      screenSource.indexOf("for (const row of livePlatformRows)"),
      screenSource.lastIndexOf("for (const row of liveWorkspaceRows)"),
    );
    expect(platformBlock).toContain("isArchived: false");
    expect(platformBlock).not.toContain("workspaceReach");
  });
});
