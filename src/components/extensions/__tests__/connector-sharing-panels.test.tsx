// @vitest-environment jsdom
//
// The Sharing tab's body (cinatra#3374), against the ratified drawing
// (design/specs/app-connectors.html §II, "Sharing tab"):
//  - "the roll-up card heads the list, and only when there is more than one
//    connection to roll up" — so a single connection heads NO roll-up and the
//    list starts with that connection's panel; and where it does head the list,
//    "The roll-up card is the Connections status card of the Setup tab, with no
//    Check and no All connections link: the list it counts is directly beneath
//    it";
//  - each panel is "a connection row — … carrying its name and mono line and
//    nothing else: no status badge and no per-row action";
//  - "Beneath each row sits the shared permissions card";
//  - a connector that constrains the scope marks its panel, so the locked and
//    recommended lines are addressable surfaces of their own.

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConnectorSharingPanels,
  CONNECTOR_SHARING_LOADING_LABEL,
  type ConnectorSharingPanelView,
} from "@cinatra-ai/sdk-ui/connector-sharing-panels";
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

function panel(i: number, extra: Partial<ConnectorSharingPanelView> = {}): ConnectorSharingPanelView {
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
    await render(<ConnectorSharingPanels panels={[panel(0)]} />);
    expect(
      container.querySelector('[data-conformance-id="connector-sharing-rollup"]'),
    ).toBeNull();
    // FIRST in the list: the connection's panel, its identity row and its card.
    const first = container.querySelector('[data-conformance-id="connector-sharing"]');
    expect(first).toBeTruthy();
    expect(first!.querySelector('[data-slot="connection-row"]')).toBeTruthy();
    expect(first!.querySelector('[data-testid="permissions-0"]')).toBeTruthy();
  });

  it("heads the list with the roll-up card once a SECOND connection is listed", async () => {
    await render(<ConnectorSharingPanels panels={[panel(0), panel(1)]} />);
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
    expect(first.querySelector('[data-testid="permissions-0"]')).toBeTruthy();
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
