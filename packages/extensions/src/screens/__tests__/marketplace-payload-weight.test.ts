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

import {
  ExtensionCardIconImage,
  MarketplaceCardIcon,
} from "@/components/extension-card-icon-image";

import { createElement } from "react";

import { deriveExtensionAccent } from "@/lib/extension-accent";

import { encodeFlight, flightBytes, valueBytes } from "./flight-payload-model";
import {
  buildMarketplaceFailureCopy,
  marketplaceFailureCopy,
} from "../marketplace-failure-copy";
import { MarketplaceListingCardInstallFace } from "../marketplace-listing-card";

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
const MarketplaceCardInstallShell = vi.fn();

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
vi.mock("../marketplace-card-shell", () => ({ MarketplaceCardInstallShell }));
vi.mock("../marketplace-install-form", () => ({
  MarketplaceInstallForm,
  MarketplaceInstallSubmit,
}));

// The card's icon chain is a REAL client component (`"use client"` in
// extension-card-icon-image.tsx) reached from the server card body, so flight
// stops at it too — it is a boundary, not a rendered subtree.
const CLIENTS = new Set<unknown>([
  ExtensionCardIconImage,
  MarketplaceCardIcon,
  MarketplaceDetailModal,
  CardFaceSwitcher,
  InstallPanelOpenButton,
  InstallPanelCloseButton,
  ExtensionInstallScopePanel,
  MarketplaceInstallForm,
  MarketplaceInstallSubmit,
  InstallPanelScopeProvider,
  MarketplaceCardInstallShell,
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
      // "*" is a DECLARED, satisfiable range → the compatible verdict, so the
      // CTA resolves to the live "Install now" state (the production case for a
      // fresh instance browsing the catalog). A range the host cannot satisfy
      // would grey every card out and measure the LIGHTEST composition.
      sdkAbiRange: "*",
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
    installAction: noopAction,
    updateAction: noopAction,
    restoreAction: noopAction,
  });
}

function gridBytes(nodes: Array<{ node: unknown }>): number {
  return nodes.reduce((sum, c) => sum + flightBytes(c.node as never, CLIENTS), 0);
}

const KB = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`;

function isElement(v: unknown): v is { type: unknown; props: Record<string, unknown> } {
  return typeof v === "object" && v !== null && "props" in v && "type" in v;
}

/** Per-card attribution: what the grid actually spends its bytes on. */
function attribute(nodes: Array<{ node: unknown }>) {
  let idle = 0;
  let installShellOverhead = 0;
  let installCapable = 0;

  for (const { node } of nodes) {
    if (!isElement(node)) continue;
    if (node.type === MarketplaceCardInstallShell) {
      installCapable += 1;
      const idleBytes = flightBytes(node.props.idleFace as never, CLIENTS);
      idle += idleBytes;
      installShellOverhead += flightBytes(node as never, CLIENTS) - idleBytes;
    } else {
      idle += flightBytes(node as never, CLIENTS);
    }
  }
  return { idle, installShellOverhead, installCapable };
}

/**
 * The pre-fix composition, re-measured rather than remembered: the SAME cards,
 * with the install face server-composed per card (the real face shell + the
 * panel carrying the card-invariant picker context) and the classified failure
 * copy shipped as props on every form CTA — exactly what the browse screen
 * emitted before cinatra#2539.
 */
function legacyExtraBytes(count: number): number {
  const cards = buildCatalog(count);
  let bytes = 0;
  for (const card of cards) {
    if (["connector", "artifact"].includes(card.kindSlug)) {
      // The never-shown install face, server-composed per card.
      const face = createElement(
        MarketplaceListingCardInstallFace as never,
        {
          card,
          accentColor: deriveExtensionAccent(card.packageName),
          closeControl: createElement(InstallPanelCloseButton as never, null),
        } as never,
        createElement(ExtensionInstallScopePanel as never, {
          packageName: card.packageName,
          packageVersion: card.packageVersion,
          displayName: card.displayName,
          installTargets: INSTALL_TARGETS,
          ownerEntityNames: OWNER_ENTITY_NAMES,
          activeOrgId: "org_01HZY",
          availability: AVAILABILITY,
          failureCopyByCategory: buildMarketplaceFailureCopy("install", card.displayName),
          defaultFailureMessage: marketplaceFailureCopy(
            "unrecoverable",
            "install",
            card.displayName,
          ),
          installAction: noopAction,
        } as never),
      );
      bytes += flightBytes(face as never, CLIENTS);
    } else {
      // The form CTA's classified copy, shipped instead of derived.
      bytes +=
        valueBytes({
          failureCopyByCategory: buildMarketplaceFailureCopy("install", card.displayName),
          defaultFailureMessage: marketplaceFailureCopy(
            "unrecoverable",
            "install",
            card.displayName,
          ),
        }) - valueBytes({ operation: "install", displayName: card.displayName });
    }
  }
  return bytes;
}

describe("marketplace browse grid — RSC payload weight (cinatra#2539)", () => {
  it("attributes the grid payload for a production-sized catalog", async () => {
    for (const count of [49, 88]) {
      const nodes = await buildGrid(count);
      const total = gridBytes(nodes);
      const a = attribute(nodes);
      console.log(
        `[payload] catalog=${count} → grid ${KB(total)} (${Math.round(total / count)} B/card)\n` +
          `          visible idle faces        ${KB(a.idle)}\n` +
          `          install-shell overhead    ${KB(a.installShellOverhead)} over ${a.installCapable} cards` +
          ` (${a.installCapable ? Math.round(a.installShellOverhead / a.installCapable) : 0} B/card)`,
      );
      expect(nodes).toHaveLength(count);
    }
  });

  it("ships NO install-panel context in the grid payload", async () => {
    // The picker rows, the entity-name lookup and the classified failure copy
    // are card-invariant or derivable; none of them belongs in a per-card row.
    // Asserting on the serialized payload keeps the guarantee independent of
    // how the composition is spelled.
    const nodes = await buildGrid(88);
    const payload = JSON.stringify(
      nodes.map((c) => encodeFlight(c.node as never, { clients: CLIENTS })),
    );
    expect(payload).not.toContain("Workspace: Admins only");
    expect(payload).not.toContain("ownerEntityNames");
    expect(payload).not.toContain("installTargets");
    expect(payload).not.toContain("failureCopyByCategory");
    expect(payload).not.toContain("You are not an administrator of this project.");
  });

  it("costs an install-capable card no more than its own card data", async () => {
    // The install face is composed on the CLIENT when it opens, so the only
    // thing an install-capable card adds to the payload is the card data its
    // header band re-uses — not a second serialized card.
    const nodes = await buildGrid(88);
    const a = attribute(nodes);
    expect(a.installCapable).toBeGreaterThan(0);
    const perCard = a.installShellOverhead / a.installCapable;
    // The legacy composition cost 5088 B/card for the same face.
    expect(perCard).toBeLessThan(1400);
  });

  it("beats the pre-fix composition by the measured margin", async () => {
    const nodes = await buildGrid(88);
    const after = gridBytes(nodes);
    const a = attribute(nodes);
    const before = after - a.installShellOverhead + legacyExtraBytes(88);
    const saved = before - after;
    console.log(
      `[payload] 88-card catalog: before ${KB(before)} → after ${KB(after)} ` +
        `(-${KB(saved)}, -${((saved / before) * 100).toFixed(1)}%)`,
    );
    expect(saved / before).toBeGreaterThan(0.2);
  });
});
