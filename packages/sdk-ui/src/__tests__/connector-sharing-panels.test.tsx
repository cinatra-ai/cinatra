// @vitest-environment jsdom
//
// ConnectorSharingPanels — the SDK's ONE Sharing-tab component (cinatra#3385).
//
// cinatra#3374 drew the Sharing tab on the connector setup pages the app
// GENERATES from a declared form. A connector that ships its own React setup
// page draws its header and its tabs itself, so the app has no seam to inject
// a tab into: the tab therefore ships from THIS package, and both pages draw
// the same one — the app's generated page and a pack's own page alike. One
// implementation, never two copies.
//
// This is the package's own rendering test of the anatomy the ratified drawing
// pins for the tab (§II, the Sharing tab): the roll-up card above the list it
// counts, on a many-connections page (the maintainer's ruling of 2026-09-26,
// cinatra#3454) and only where there is more than one connection to roll up; one
// panel per owned connection (its identity row — name and mono
// line, no status badge and no per-row action — over the access picker and
// ownership card THIS package draws from data and callbacks), the locked and
// recommended marks where the connector constrains the scope, and the declared
// loading treatment.
//
// The panels below are driven the way a connector PACK drives them: data and
// callbacks only, with no host component handed in. That is the whole point of
// cinatra#3385: a pack can draw the controls, because this package draws them.
// Plus the export wiring (its own dedicated subpath, off the root and
// /marketplace barrels) and the one addition a pack makes, as the README states
// it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The panel refreshes the route after a write and navigates after a
// self-removal. Neither is exercised here; the router is stubbed so the tree
// mounts outside a Next router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import {
  ConnectorSharingPanels,
  CONNECTOR_SHARING_INTRO,
  CONNECTOR_SHARING_LOADING_LABEL,
  type ConnectorSharingPanelView,
} from "../connector-sharing-panels";
import type {
  PermissionsPanelProps,
  PermissionsPanelResult,
} from "../permissions-panel";

const PKG_DIR = join(__dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
  exports: Record<string, string>;
};
const readmeSrc = readFileSync(join(PKG_DIR, "README.md"), "utf8");
const indexSrc = readFileSync(join(PKG_DIR, "src", "index.ts"), "utf8");
const marketplaceSrc = readFileSync(join(PKG_DIR, "src", "marketplace.ts"), "utf8");
const componentSrc = readFileSync(
  join(PKG_DIR, "src", "connector-sharing-panels.tsx"),
  "utf8",
);

/**
 * The three surfaces this component emits — the ids the functional-acceptance
 * drivers grade, declared by the ratified drawing's own conformance manifest.
 */
/** The ceiling sentence a constraining connector states, as the drawing gives it. */
const CEILING_LINE =
  'Locked by this connector: access is limited to your organization (only:"organization").';

const SHARING_SURFACES = [
  "connector-sharing",
  "connector-sharing-rollup",
  "connector-sharing-locked",
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const OK: PermissionsPanelResult = { ok: true };

/**
 * Exactly what a connector pack states: the stored grant, the scopes the actor
 * holds, the owner, and four bindings. No host component, and no node the pack
 * would have to build for itself.
 */
function permissions(i: number, extra: Partial<PermissionsPanelProps> = {}): PermissionsPanelProps {
  return {
    canEdit: true,
    initialPolicy: {
      runListVisibility: ["owner"],
      runDataVisibility: ["owner"],
      runExecuteVisibility: ["owner"],
      allowRunSharing: true,
    },
    owner: {
      userId: `owner-${i}`,
      name: `Owner ${i}`,
      email: `owner-${i}@example.com`,
      image: null,
    },
    coOwners: [],
    availableScopes: { orgs: [], projects: [], canGrantWorkspace: true },
    currentUserId: `owner-${i}`,
    allowSharing: true,
    selfRemoveRedirect: "/connectors",
    actions: {
      savePolicy: async () => OK,
      searchCandidates: async () => ({ ok: true as const, results: [], hasMore: false }),
      addCoOwner: async () => OK,
      removeCoOwner: async () => OK,
    },
    ...extra,
  };
}

function panel(
  i: number,
  extra: Partial<ConnectorSharingPanelView> = {},
): ConnectorSharingPanelView {
  return {
    key: `p${i}`,
    name: `connection-${i}`,
    url: `key-${i}`,
    scopeConstraint: null,
    permissions: permissions(i),
    ...extra,
  };
}

/** The access picker's trigger inside one panel. */
function accessTrigger(scope: Element): Element | null {
  return scope.querySelector('[role="combobox"]');
}

/** The ownership card's people-search field inside one panel. */
function ownershipSearch(scope: Element): Element | null {
  return scope.querySelector('input[placeholder="Search by name or email…"]');
}

/** The panel's one Save bar. */
function saveButton(scope: Element): Element | null {
  return [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Save changes",
  ) ?? null;
}

async function render(node: React.ReactElement) {
  await act(async () => {
    root.render(node);
  });
}

describe("ConnectorSharingPanels — the roll-up card", () => {
  it("draws NO card above a SINGLE owned connection — the list starts with the panel", async () => {
    // The drawing's own words: "the roll-up card heads the list, and only when
    // there is more than one connection to roll up". One connection is nothing
    // to roll up, so the list starts with that connection's own panel — one
    // rule for every page that draws this component.
    await render(<ConnectorSharingPanels panels={[panel(0)]} pageShape="many" />);
    expect(
      container.querySelector('[data-conformance-id="connector-sharing-rollup"]'),
    ).toBeNull();
    const first = container.querySelector('[data-conformance-id="connector-sharing"]');
    expect(first).toBeTruthy();
    expect(first!.querySelector('[data-slot="connection-row"]')).toBeTruthy();
    expect(accessTrigger(first!)).toBeTruthy();
  });

  it("draws NO card on a SINGLE-shape page, however many panels it lists", async () => {
    // The maintainer's ruling of 2026-09-26 (cinatra#3454): the roll-up
    // follows the page's SHAPE, not the count. The roll-up card is "the
    // Connections status card of the Setup tab", and a page whose tab strip
    // has no Connections tab carries no such card, so it heads its Sharing
    // list with nothing, even above several panels.
    await render(<ConnectorSharingPanels panels={[panel(0), panel(1)]} pageShape="single" />);
    expect(
      container.querySelector('[data-conformance-id="connector-sharing-rollup"]'),
    ).toBeNull();
    // The panels themselves are untouched: the list simply starts with the
    // first one.
    expect(
      container.querySelectorAll('[data-conformance-id="connector-sharing"]').length,
    ).toBe(2);
  });

  it("takes the SINGLE shape when the caller states none", async () => {
    // No production page carries the many-connections shape today, so the
    // default is the shape the pages actually have. A caller that says
    // nothing gets no roll-up.
    await render(<ConnectorSharingPanels panels={[panel(0), panel(1)]} />);
    expect(
      container.querySelector('[data-conformance-id="connector-sharing-rollup"]'),
    ).toBeNull();
    expect(componentSrc).toContain('pageShape = "single"');
  });

  it("heads the list once a SECOND connection is listed, with no Check and no link", async () => {
    await render(
      <ConnectorSharingPanels panels={[panel(0), panel(1)]} pageShape="many" />,
    );
    const rollup = container.querySelector(
      '[data-conformance-id="connector-sharing-rollup"]',
    );
    expect(rollup).toBeTruthy();
    // The count it carries is the list directly beneath it.
    expect(rollup!.textContent).toContain("2");
    // No action slot at all: that is what drops the Check and the "All
    // connections" link the Setup tab's sibling card carries.
    expect(rollup!.querySelector("button")).toBeNull();
    expect(rollup!.querySelector("a")).toBeNull();
    expect(rollup!.textContent).not.toContain("All connections");
    // ABOVE the list: it precedes the first panel in document order.
    const firstPanel = container.querySelector('[data-conformance-id="connector-sharing"]')!;
    expect(
      rollup!.compareDocumentPosition(firstPanel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws the permissions panel itself, with no caller node and no host import", () => {
    // The gap cinatra#3385 closes: the card used to arrive as a
    // `React.ReactNode` the caller built, which a pack cannot build.
    expect(componentSrc).not.toContain("permissions: React.ReactNode");
    expect(componentSrc).toContain("<PermissionsPanel {...panel.permissions} />");
    // Nothing in this package reaches the app.
    expect(componentSrc).not.toContain('from "@/');
  });

  it("states the page's SHAPE, never the caller's wish for a card", () => {
    // The one thing a caller may state is what its page is, not whether it
    // wants the card: the shape decides, and the drawing's own "more than one
    // connection to roll up" still decides beside it.
    expect(componentSrc).toContain('pageShape?: "single" | "many"');
    expect(componentSrc).not.toContain("rollup ===");
    expect(componentSrc).toContain("panels.length > 1");
  });
});

describe("ConnectorSharingPanels — one panel per owned connection", () => {
  it("draws the identity row (no badge, no action) over the panel's permissions node", async () => {
    await render(<ConnectorSharingPanels panels={[panel(0), panel(1)]} />);
    const panels = container.querySelectorAll('[data-conformance-id="connector-sharing"]');
    expect(panels.length).toBe(2);
    const first = panels[0];
    expect(first.getAttribute("data-state")).toBe("ready");
    const row = first.querySelector('[data-slot="connection-row"]')!;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("connection-0");
    expect(row.textContent).toContain("key-0");
    expect(row.querySelector('[data-slot="connection-status-badge"]')).toBeNull();
    expect(row.querySelector("button")).toBeNull();
    // The access picker and the ownership card are drawn by THIS package from
    // the data and callbacks above: no host component and no node the caller
    // had to build, so a pack draws the same two controls the app draws.
    const picker = accessTrigger(first)!;
    expect(picker).toBeTruthy();
    expect(ownershipSearch(first)).toBeTruthy();
    expect(saveButton(first)).toBeTruthy();
    expect(first.textContent).toContain("Access");
    expect(first.textContent).toContain("Ownership");
    expect(
      row.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("marks a panel whose connector declares a ceiling, and one that only recommends", async () => {
    await render(
      <ConnectorSharingPanels
        panels={[
          panel(0, {
            scopeConstraint: "locked",
            permissions: permissions(0, {
              accessDisabledScopes: ["workspace"],
              accessDisabledReasons: { workspace: CEILING_LINE },
              accessScopeNote: CEILING_LINE,
              // The lock is a claim that the connector caps the scope, so the
              // panel draws it only where the caller states a ceiling
              // (cinatra#3454). The Sharing tab section states the same kind.
              accessScopeNoteKind: "locked",
            }),
          }),
          panel(1, { scopeConstraint: "recommended" }),
        ]}
      />,
    );
    const marked = [
      ...container.querySelectorAll('[data-conformance-id="connector-sharing-locked"]'),
    ].map((n) => n.getAttribute("data-variant"));
    expect(marked).toEqual(["locked", "recommended"]);
    // The mark WRAPS that panel's picker, and the line the connector states
    // sits under it with a lock. This package draws both.
    const locked = container.querySelector(
      '[data-conformance-id="connector-sharing-locked"][data-variant="locked"]',
    )!;
    expect(accessTrigger(locked)).toBeTruthy();
    expect(locked.textContent).toContain(CEILING_LINE);
    const line = [...locked.querySelectorAll("p")].find(
      (p) => p.textContent?.trim() === CEILING_LINE,
    )!;
    expect(line).toBeTruthy();
    expect(line.querySelectorAll("svg").length).toBe(1);
  });

  it("leaves an unconstrained panel unmarked", async () => {
    await render(<ConnectorSharingPanels panels={[panel(0)]} />);
    expect(
      container.querySelector('[data-conformance-id="connector-sharing-locked"]'),
    ).toBeNull();
  });

  it("renders the declared loading treatment instead of a blank tab", async () => {
    await render(<ConnectorSharingPanels panels={[]} state="loading" />);
    const surface = container.querySelector(
      '[data-conformance-id="connector-sharing"][data-state="loading"]',
    )!;
    expect(surface).toBeTruthy();
    expect(surface.querySelector('[data-slot="connector-sharing-loading"]')).toBeTruthy();
    expect(surface.textContent).toContain(CONNECTOR_SHARING_LOADING_LABEL);
    expect(container.querySelector('[data-slot="connection-row"]')).toBeNull();
    expect(
      container.querySelector('[data-conformance-id="connector-sharing-rollup"]'),
    ).toBeNull();
  });

  it("carries the drawing's own line for the tab, so every page draws the same words", () => {
    expect(CONNECTOR_SHARING_INTRO).toContain(
      "Shared use always acts through your connected account and is audited.",
    );
  });
});

describe("ConnectorSharingPanels — the one addition a pack makes", () => {
  it("ships from its own dedicated subpath", async () => {
    expect(pkg.exports["./connector-sharing-panels"]).toBe(
      "./src/connector-sharing-panels.tsx",
    );
    const mod = await import("@cinatra-ai/sdk-ui/connector-sharing-panels");
    expect(typeof mod.ConnectorSharingPanels).toBe("function");
  });

  it("stays OFF the root and /marketplace barrels (the route-graph ratchet)", () => {
    expect(indexSrc).not.toContain("connector-sharing-panels");
    expect(marketplaceSrc).not.toContain("connector-sharing-panels");
  });

  it("is documented with its import, its props and the surfaces the drivers grade", () => {
    expect(readmeSrc).toContain(
      'import { ConnectorSharingPanels } from "@cinatra-ai/sdk-ui/connector-sharing-panels";',
    );
    for (const surface of SHARING_SURFACES) expect(readmeSrc).toContain(surface);
    // The pack-side declaration, by name: a pack that draws its own setup page
    // is the one that leaves `cinatra.uiSurface` off `schema-config`.
    expect(readmeSrc).toContain("cinatra.uiSurface");
    expect(readmeSrc).toContain("scopeConstraint");
  });
});
