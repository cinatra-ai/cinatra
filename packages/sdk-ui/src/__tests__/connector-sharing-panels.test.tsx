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
// counts, one panel per owned connection (its identity row — name and mono
// line, no status badge and no per-row action — over the access picker and
// ownership card, handed in as a node), the locked and recommended marks where
// the connector constrains the scope, and the declared loading treatment.
// Plus the export wiring (its own dedicated subpath, off the root and
// /marketplace barrels) and the one addition a pack makes, as the README states
// it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConnectorSharingPanels,
  CONNECTOR_SHARING_INTRO,
  CONNECTOR_SHARING_LOADING_LABEL,
  type ConnectorSharingPanelView,
} from "../connector-sharing-panels";

const PKG_DIR = join(__dirname, "..", "..");
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
  exports: Record<string, string>;
};
const readmeSrc = readFileSync(join(PKG_DIR, "README.md"), "utf8");
const indexSrc = readFileSync(join(PKG_DIR, "src", "index.ts"), "utf8");
const marketplaceSrc = readFileSync(join(PKG_DIR, "src", "marketplace.ts"), "utf8");

/**
 * The three surfaces this component emits — the ids the functional-acceptance
 * drivers grade, declared by the ratified drawing's own conformance manifest.
 */
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

function panel(
  i: number,
  extra: Partial<ConnectorSharingPanelView> = {},
): ConnectorSharingPanelView {
  return {
    key: `p${i}`,
    name: `connection-${i}`,
    url: `key-${i}`,
    scopeConstraint: null,
    permissions: <div data-testid={`permissions-${i}`}>permissions</div>,
    ...extra,
  };
}

async function render(node: React.ReactElement) {
  await act(async () => {
    root.render(node);
  });
}

describe("ConnectorSharingPanels — the roll-up card", () => {
  it("heads the list even for a SINGLE owned connection, with no Check and no link", async () => {
    await render(<ConnectorSharingPanels panels={[panel(0)]} />);
    const rollup = container.querySelector(
      '[data-conformance-id="connector-sharing-rollup"]',
    );
    expect(rollup).toBeTruthy();
    // The count it carries is the list directly beneath it.
    expect(rollup!.textContent).toContain("1");
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

  it("keeps the plural-only rule on a `multiple` mount", async () => {
    await render(<ConnectorSharingPanels panels={[panel(0)]} rollup="multiple" />);
    expect(
      container.querySelector('[data-conformance-id="connector-sharing-rollup"]'),
    ).toBeNull();
    expect(container.querySelector('[data-slot="connection-row"]')).toBeTruthy();
  });

  it("heads a `multiple` mount once it holds more than one connection", async () => {
    await render(
      <ConnectorSharingPanels panels={[panel(0), panel(1)]} rollup="multiple" />,
    );
    const rollup = container.querySelector(
      '[data-conformance-id="connector-sharing-rollup"]',
    );
    expect(rollup).toBeTruthy();
    expect(rollup!.textContent).toContain("2");
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
    // The access picker and ownership card are the caller's node — this
    // component mounts no client of its own, so a pack cannot end up drawing a
    // connector-specific copy of the two controls.
    const permissions = first.querySelector('[data-testid="permissions-0"]')!;
    expect(permissions).toBeTruthy();
    expect(
      row.compareDocumentPosition(permissions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("marks a panel whose connector declares a ceiling, and one that only recommends", async () => {
    await render(
      <ConnectorSharingPanels
        panels={[
          panel(0, { scopeConstraint: "locked" }),
          panel(1, { scopeConstraint: "recommended" }),
        ]}
      />,
    );
    const marked = [
      ...container.querySelectorAll('[data-conformance-id="connector-sharing-locked"]'),
    ].map((n) => n.getAttribute("data-variant"));
    expect(marked).toEqual(["locked", "recommended"]);
    // The mark WRAPS that panel's picker — the locked reason and the
    // recommendation line are drawn by the permissions node inside it.
    const locked = container.querySelector(
      '[data-conformance-id="connector-sharing-locked"][data-variant="locked"]',
    )!;
    expect(locked.querySelector('[data-testid="permissions-0"]')).toBeTruthy();
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
    expect(readmeSrc).toContain("rollup");
  });
});
