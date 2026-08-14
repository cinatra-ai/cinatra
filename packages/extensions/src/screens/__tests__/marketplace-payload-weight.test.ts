// ---------------------------------------------------------------------------
// Marketplace browse grid — RSC payload weight (cinatra#2539, page-size half).
//
// The database half of #2539 is fixed and merged (PR #2718: the identity cache
// wired, 12.4 -> 0.75 identity reads and 2104ms -> 719ms blocked event loop per
// render). What remained is PAGE SIZE: the healthy-path render still ships a
// multi-megabyte payload, and the dominant term is what this suite measures.
//
// WHAT IS MEASURED. /configuration/marketplace hands the filter-only client
// grid ONE node per catalog entry. Everything the server renders is serialized
// into the flight payload, and every prop handed to a client component is
// serialized WITH it — including a prop whose value is a server-rendered tree
// the viewer may never see. For an access-target install (connector / artifact)
// each card carries a second, never-shown face: a full card shell plus the
// install panel, and the panel repeats the CARD-INVARIANT picker context
// (installTargets, ownerEntityNames, activeOrgId, availability) once per card.
//
// The encoder is a model of React's flight row format (see
// ./flight-payload-model.ts): absolute bytes are indicative, the DELTA between
// two compositions run through it is exact.
//
// The budgets below are regression fences, not aspirations: they are set from
// the measured post-fix numbers with headroom, so a future change that puts the
// per-card duplication back turns this suite red.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";

import { flightBytes, valueBytes } from "./flight-payload-model";

// The "use client" halves of the composition are stood in as same-named,
// same-props stubs. Flight NEVER renders a client component — it emits a module
// reference plus the serialized props — so the payload is byte-identical either
// way, and the suite stays out of the browser dependency graph (Radix, toast,
// next/navigation, the detail server action).
const MarketplaceDetailModal = vi.fn();
const CardFaceSwitcher = vi.fn();
const InstallPanelOpenButton = vi.fn();
const InstallPanelCloseButton = vi.fn();
const ExtensionInstallScopePanel = vi.fn();
const MarketplaceInstallForm = vi.fn();
const MarketplaceInstallSubmit = vi.fn();
const InstallPanelScopeProvider = vi.fn();

vi.mock("../marketplace-detail-modal", () => ({ MarketplaceDetailModal }));
vi.mock("../card-face-switcher", () => ({
  CardFaceSwitcher,
  InstallPanelOpenButton,
  InstallPanelCloseButton,
}));
vi.mock("../extension-install-scope-panel", () => ({
  ExtensionInstallScopePanel,
  InstallPanelScopeProvider,
}));
vi.mock("../marketplace-install-form", () => ({
  MarketplaceInstallForm,
  MarketplaceInstallSubmit,
}));

const CLIENTS = new Set<unknown>([
  MarketplaceDetailModal,
  CardFaceSwitcher,
  InstallPanelOpenButton,
  InstallPanelCloseButton,
  ExtensionInstallScopePanel,
  MarketplaceInstallForm,
  MarketplaceInstallSubmit,
  InstallPanelScopeProvider,
]);

// ---------------------------------------------------------------------------
// Fixture catalog — production-shaped, deterministic.
//
// Sizes are drawn from the real surfaces: this repo's own extension closure is
// 88 packages (cinatra-dev-extensions.lock.json + cinatra-required-extensions
// .lock.json), and the issue reproduced its render against ~49 installed rows.
// Both counts are measured below. Field lengths match the storefront catalog
// shape the browse mapper produces (a ~150-character description, a scoped
// package name, a semver, a vendor block).
// ---------------------------------------------------------------------------

const KINDS = ["agent", "skill", "connector", "artifact"] as const;

function buildCatalog(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const kind = KINDS[i % KINDS.length];
    const slug = `${kind}-package-${String(i).padStart(3, "0")}`;
    return {
      packageName: `@cinatra-ai/${slug}`,
      packageVersion: `1.${i % 9}.${i % 7}`,
      displayName: `${kind[0].toUpperCase()}${kind.slice(1)} Package ${i}`,
      description:
        "Connects your workspace to the service, keeps records in sync both ways, " +
        "and exposes the operations your agents call during a run.",
      kindSlug: kind,
      kindLabel: `${kind[0].toUpperCase()}${kind.slice(1)}`,
      badge: { text: "Free", variant: "free" as const },
      freshnessAt: new Date("2026-07-05T09:00:00.000Z").toISOString(),
      rating: { average: 4.8, count: 312 },
      detailHref: `/configuration/marketplace/cinatra-ai/${slug}`,
      installCount: 2100,
      manifestLogoUrl: null,
      iconSlug: slug,
      iconUrl: null,
      vendorLogoUrl: null,
      vendor: { name: "Cinatra", slug: "cinatra", storeUrl: null },
      sdkAbiRange: "^1.0.0",
    };
  });
}

/** A platform admin in one org with 3 teams and 4 projects, plus the two
 *  always-offered workspace scopes (cinatra#1527) — 10 picker rows. */
const INSTALL_TARGETS = [
  { value: "workspace", label: "Workspace: All", level: "workspace", id: "", disabled: false },
  { value: "admin", label: "Workspace: Admins only", level: "admin", id: "", disabled: false },
  {
    value: "org:org_01HZY",
    label: "Acme Corporation",
    level: "organization",
    id: "org_01HZY",
    disabled: false,
  },
  ...["Engineering", "Revenue Operations", "Customer Success"].map((name, i) => ({
    value: `team:team_0${i}`,
    label: name,
    level: "team" as const,
    id: `team_0${i}`,
    disabled: false,
  })),
  ...["Website Relaunch", "Data Platform", "Support Desk", "Partner Portal"].map((name, i) => ({
    value: `project:proj_0${i}`,
    label: name,
    level: "project" as const,
    id: `proj_0${i}`,
    disabled: i % 2 === 1,
    ...(i % 2 === 1 ? { reason: "You are not an administrator of this project." } : {}),
  })),
] as never[];

const OWNER_ENTITY_NAMES: Record<string, string> = {
  "org:org_01HZY": "Acme Corporation",
  "team:team_00": "Engineering",
  "team:team_01": "Revenue Operations",
  "team:team_02": "Customer Success",
  "project:proj_00": "Website Relaunch",
  "project:proj_01": "Data Platform",
  "project:proj_02": "Support Desk",
  "project:proj_03": "Partner Portal",
};

const AVAILABILITY = {
  state: "ready",
  defaultValue: "workspace",
} as never;

const noopAction = async () => undefined;

async function buildGrid(count: number) {
  const { buildMarketplaceCardNodes } = await import("../marketplace-card-nodes");
  return buildMarketplaceCardNodes({
    cards: buildCatalog(count) as never,
    installedVersionByName: new Map(),
    registryConnected: true,
    installTargets: INSTALL_TARGETS,
    ownerEntityNames: OWNER_ENTITY_NAMES,
    activeOrgId: "org_01HZY",
    installPanelAvailability: AVAILABILITY,
    installAction: noopAction,
    updateAction: noopAction,
    restoreAction: noopAction,
  });
}

function gridBytes(nodes: Array<{ node: unknown }>): number {
  return nodes.reduce((sum, c) => sum + flightBytes(c.node as never, CLIENTS), 0);
}

const KB = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

describe("marketplace browse grid — RSC payload weight (cinatra#2539)", () => {
  it("reports the per-card and whole-grid payload for a production-sized catalog", async () => {
    for (const count of [49, 88]) {
      const nodes = await buildGrid(count);
      const total = gridBytes(nodes);
      // eslint-disable-next-line no-console
      console.log(
        `[payload] catalog=${count} cards → grid flight payload ${KB(total)} ` +
          `(${Math.round(total / count)} B/card)`,
      );
      expect(nodes).toHaveLength(count);
    }
  });

  it("keeps the card-invariant install context OUT of the per-card payload", async () => {
    // The picker context is one server computation shared by every panel. It
    // must be serialized ONCE for the grid, not once per install-capable card:
    // duplicating it is O(cards x targets) bytes for data that never differs.
    const sharedContextBytes =
      valueBytes(INSTALL_TARGETS) + valueBytes(OWNER_ENTITY_NAMES) + valueBytes(AVAILABILITY);

    const nodes = await buildGrid(88);
    const total = gridBytes(nodes);
    const installCapable = nodes.filter((c) =>
      ["connector", "artifact"].includes(c.meta.kind as string),
    ).length;

    // eslint-disable-next-line no-console
    console.log(
      `[payload] shared install context ${KB(sharedContextBytes)}; ` +
        `${installCapable} install-capable cards; grid total ${KB(total)}`,
    );

    // If the context were repeated per card it would account for this much:
    const duplicatedIfPerCard = sharedContextBytes * installCapable;
    expect(total).toBeLessThan(duplicatedIfPerCard);
  });
});
