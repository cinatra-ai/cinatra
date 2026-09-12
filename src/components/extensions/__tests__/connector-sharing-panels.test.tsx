// @vitest-environment jsdom
//
// The Sharing tab's body (cinatra#3374), against the ratified drawing
// (design/specs/app-connectors.html §II, "Sharing tab"):
//  - "The roll-up card is the Connections status card of the Setup tab, with no
//    Check and no All connections link: the list it counts is directly beneath
//    it" — so it heads the list whenever there IS a list, not only when there is
//    more than one connection (its Setup-tab sibling's plural rule);
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
  it("heads the list with the roll-up card even for a SINGLE owned connection", async () => {
    await render(<ConnectorSharingPanels panels={[panel(0)]} />);
    const rollup = container.querySelector('[data-conformance-id="connector-sharing-rollup"]');
    expect(rollup).toBeTruthy();
    // The count it carries is the list beneath it.
    expect(rollup!.textContent).toContain("1");
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

  it('keeps the plural-only roll-up on a `multiple` mount (the pages with no tab strip)', async () => {
    // The bundled-react setup pages and the §II error treatments mount the
    // section directly. This issue does not change them: one connection there
    // still heads no roll-up, exactly as before.
    await render(<ConnectorSharingPanels panels={[panel(0)]} rollup="multiple" />);
    expect(
      container.querySelector('[data-conformance-id="connector-sharing-rollup"]'),
    ).toBeNull();
    expect(container.querySelector('[data-slot="connection-row"]')).toBeTruthy();
  });

  it('heads a `multiple` mount once it holds more than one connection', async () => {
    await render(
      <ConnectorSharingPanels panels={[panel(0), panel(1)]} rollup="multiple" />,
    );
    const rollup = container.querySelector(
      '[data-conformance-id="connector-sharing-rollup"]',
    );
    expect(rollup).toBeTruthy();
    expect(rollup!.textContent).toContain("2");
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
