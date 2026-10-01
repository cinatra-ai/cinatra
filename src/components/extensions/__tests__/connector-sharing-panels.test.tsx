// @vitest-environment jsdom
//
// The Sharing tab's body (cinatra#3374), against the ratified drawing
// (design/specs/app-connectors.html §II, "Sharing tab"):
//  - "The roll-up card is the Connections status card of the Setup tab, with
//    no Check and no All connections link: the list it counts is directly
//    beneath it", which the maintainer read on 2026-09-26 (cinatra#3454) as
//    the page's SHAPE and not the count: only a many-connections page has that
//    Setup card, so only its Sharing tab heads the list with the roll-up, and
//    it still needs "more than one connection to roll up";
//  - each panel is "a connection row — … carrying its name and mono line and
//    nothing else: no status badge and no per-row action";
//  - "Beneath each row sits the shared permissions card", drawn by the shared
//    component itself from data and callbacks (cinatra#3385), so the app's
//    generated page and a pack's own page draw the same two controls;
//  - a connector that constrains the scope marks its panel, so the locked and
//    recommended lines are addressable surfaces of their own.

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import {
  ConnectorSharingPanels,
  CONNECTOR_SHARING_LOADING_LABEL,
  type ConnectorSharingPanelView,
} from "@cinatra-ai/sdk-ui/connector-sharing-panels";
import type { PermissionsPanelProps } from "@cinatra-ai/sdk-ui/permissions-panel";
import {
  CONNECTOR_SHARING_INITIAL_SCOPE,
  CONNECTOR_SHARING_INITIAL_SCOPE_LABEL,
  CONNECTOR_SHARING_LOCKED_VALUE,
  CONNECTOR_SHARING_LOCKED_VALUE_LABEL,
  CONNECTOR_SHARING_OWNER_SCOPE,
  CONNECTOR_SHARING_OWNER_SCOPE_LABEL,
} from "@/app/design-fixtures/conformance/connector-sharing-seed";

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

/** The permissions DATA and bindings the tab states for one connection. */
function permissions(i: number): PermissionsPanelProps {
  return {
    canEdit: true,
    initialPolicy: {
      runListVisibility: [CONNECTOR_SHARING_INITIAL_SCOPE],
      runDataVisibility: [CONNECTOR_SHARING_OWNER_SCOPE],
      runExecuteVisibility: [CONNECTOR_SHARING_OWNER_SCOPE],
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
      savePolicy: async () => ({ ok: true as const }),
      searchCandidates: async () => ({ ok: true as const, results: [], hasMore: false }),
      addCoOwner: async () => ({ ok: true as const }),
      removeCoOwner: async () => ({ ok: true as const }),
    },
  };
}

function panel(i: number, extra: Partial<ConnectorSharingPanelView> = {}): ConnectorSharingPanelView {
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

async function render(node: React.ReactElement) {
  await act(async () => {
    root.render(node);
  });
}

describe("the sharing conformance seed — the access binding is falsifiable (#3374)", () => {
  it("seeds runListVisibility away from the owner floor and from every override", () => {
    // The picker binds to `runListVisibility`. If the seed carried the owner
    // floor there, a panel that IGNORED the policy — and fell back to the
    // floor, or echoed an override — would pass the `access` field assertion
    // on a lookalike. These three values are pairwise distinct, so it cannot.
    expect(CONNECTOR_SHARING_INITIAL_SCOPE).not.toBe(CONNECTOR_SHARING_OWNER_SCOPE);
    expect(CONNECTOR_SHARING_INITIAL_SCOPE).not.toBe(CONNECTOR_SHARING_LOCKED_VALUE);
    expect(CONNECTOR_SHARING_INITIAL_SCOPE_LABEL).not.toBe(
      CONNECTOR_SHARING_OWNER_SCOPE_LABEL,
    );
    expect(CONNECTOR_SHARING_INITIAL_SCOPE_LABEL).not.toBe(
      CONNECTOR_SHARING_LOCKED_VALUE_LABEL,
    );
  });
});

describe("ConnectorSharingPanels", () => {
  it("draws NO roll-up card above a SINGLE connection — the list starts with the panel", async () => {
    // The drawing's own words: "the roll-up card heads the list, and only when
    // there is more than one connection to roll up". One connection is nothing
    // to roll up, so the list starts with that connection's own panel. ONE rule
    // for every mount — the Sharing tab and the pages that draw no tab strip
    // (the bundled-react setup pages and the §II error treatments) alike.
    await render(<ConnectorSharingPanels panels={[panel(0)]} pageShape="many" />);
    expect(
      container.querySelector('[data-conformance-id="connector-sharing-rollup"]'),
    ).toBeNull();
    // FIRST in the list: the connection's panel, its identity row and its card.
    const first = container.querySelector('[data-conformance-id="connector-sharing"]');
    expect(first).toBeTruthy();
    expect(first!.querySelector('[data-slot="connection-row"]')).toBeTruthy();
    expect(accessTrigger(first!)).toBeTruthy();
  });

  it("draws NO roll-up on a SINGLE-shape page that lists TWO connections", async () => {
    // The maintainer's ruling of 2026-09-26 (cinatra#3454): the roll-up
    // follows the page's SHAPE, not the count. The roll-up card is the
    // Connections status card of the Setup tab, and the generated connector
    // page draws no Connections tab, so its Sharing tab heads its list with
    // nothing however many connections the owner saved.
    await render(
      <ConnectorSharingPanels panels={[panel(0), panel(1)]} pageShape="single" />,
    );
    expect(
      container.querySelector('[data-conformance-id="connector-sharing-rollup"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-conformance-id="connector-sharing"]').length,
    ).toBe(2);
  });

  it("takes the SINGLE shape when the caller states none", async () => {
    // No production page carries the many-connections shape today, so a
    // caller that says nothing gets the shape its page actually has.
    await render(<ConnectorSharingPanels panels={[panel(0), panel(1)]} />);
    expect(
      container.querySelector('[data-conformance-id="connector-sharing-rollup"]'),
    ).toBeNull();
  });

  it("heads the list with the roll-up card once a SECOND connection is listed", async () => {
    await render(
      <ConnectorSharingPanels panels={[panel(0), panel(1)]} pageShape="many" />,
    );
    const rollup = container.querySelector('[data-conformance-id="connector-sharing-rollup"]');
    expect(rollup).toBeTruthy();
    // The count it carries is the list beneath it.
    expect(rollup!.textContent).toContain("2");
    // No Check and no "All connections" link — the card gets no action slot.
    expect(rollup!.querySelector("button")).toBeNull();
    expect(rollup!.querySelector("a")).toBeNull();
    expect(rollup!.textContent).not.toContain("All connections");
    // ABOVE the list: the roll-up precedes the first panel in document order.
    const firstPanel = container.querySelector('[data-conformance-id="connector-sharing"]')!;
    expect(
      rollup!.compareDocumentPosition(firstPanel) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws one panel per connection: the row (no badge, no action) over the permissions card", async () => {
    await render(<ConnectorSharingPanels panels={[panel(0), panel(1)]} />);
    const panels = container.querySelectorAll('[data-conformance-id="connector-sharing"]');
    expect(panels.length).toBe(2);
    const first = panels[0];
    const row = first.querySelector('[data-slot="connection-row"]')!;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain("connection-0");
    expect(row.textContent).toContain("key-0");
    expect(row.querySelector('[data-slot="connection-status-badge"]')).toBeNull();
    expect(row.querySelector("button")).toBeNull();
    // The shared card beneath the row: the access picker, the ownership card
    // and the one Save bar, drawn by the shared component itself.
    expect(accessTrigger(first)).toBeTruthy();
    expect(
      first.querySelector('input[placeholder="Search by name or email…"]'),
    ).toBeTruthy();
    expect(
      [...first.querySelectorAll("button")].filter(
        (b) => b.textContent?.trim() === "Save changes",
      ).length,
    ).toBe(1);
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
    expect(surface.textContent).toContain(CONNECTOR_SHARING_LOADING_LABEL);
    expect(container.querySelector('[data-slot="connection-row"]')).toBeNull();
  });
});
