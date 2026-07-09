/**
 * DOM render proof (server markup) for the marketplace-specific UI the unified
 * approvals surface adds — complementing the whole-page CI render-smoke floor:
 *   - the group-level "Marketplace not connected" Empty + Connect CTA (state a);
 *   - the sources footer that surfaces each hidden section discoverably (state b);
 *   - the marketplace row shell + inline decide affordance: Approve/Reject for a
 *     moderation row, Withdraw for a "Your requests" row, and the OPTIONAL
 *     eligibility hint disabling + annotating the action (#1045).
 *
 * Rendered with react-dom/server so it needs neither a browser nor the full app
 * build — the live browser floor is the CI render-smoke suite over every static
 * route (same rationale as source-section-render.test.tsx).
 */
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) =>
    createElement("a", { href, ...(rest as object) }, children as never),
}));
// The inline decide component imports the shared server action; stub it (never
// invoked during a static render) to avoid dragging the session/registry graph.
vi.mock("../actions", () => ({ decideApprovalRow: vi.fn() }));

import {
  MarketplaceNotConnectedGroup,
  MarketplaceSourcesFooter,
} from "../marketplace-group-views";
import { MarketplaceRowView } from "../sources/marketplace-row";
import { MarketplaceDecisionActions } from "../marketplace-decision-actions";
import type { ApprovalSource } from "../sources/types";

const CONNECT = "/configuration/environment?tab=registries";

function fakeHidden(id: string, title: string): ApprovalSource {
  return {
    id,
    title,
    availability: () => "ready",
    appliesTo: () => true,
    fetchInbox: async () => ({ availability: "ready", rows: [], actions: [] }),
    fetchMine: async () => ({ availability: "ready", rows: [], actions: [] }),
    counts: async () => ({ inbox: 0, mine: 0 }),
    rowRenderer: () => null,
    actions: { decide: async () => ({ ok: true }) },
  };
}

describe("MarketplaceNotConnectedGroup (state a)", () => {
  it("renders the not-connected Empty with a Connect CTA to the registries tab", () => {
    const html = renderToStaticMarkup(<MarketplaceNotConnectedGroup connectHref={CONNECT} />);
    expect(html).toContain("Marketplace not connected");
    expect(html).toContain("Connect registry");
    expect(html).toContain(`href="${CONNECT}"`);
  });
});

describe("MarketplaceSourcesFooter (state b)", () => {
  it("lists each hidden section discoverably with a configure link", () => {
    const html = renderToStaticMarkup(
      <MarketplaceSourcesFooter
        connectHref={CONNECT}
        hidden={[fakeHidden("a", "Extension submissions"), fakeHidden("b", "Vendor applications")]}
      />,
    );
    expect(html).toContain("Some marketplace sections are hidden");
    expect(html).toContain("Extension submissions");
    expect(html).toContain("Vendor applications");
    expect(html).toContain("Configure marketplace registries");
  });

  it("renders nothing when no section is hidden", () => {
    expect(renderToStaticMarkup(<MarketplaceSourcesFooter connectHref={CONNECT} hidden={[]} />)).toBe("");
  });
});

describe("MarketplaceRowView + inline decide", () => {
  it("renders a titled row with a status pill and a right-hand action slot", () => {
    const html = renderToStaticMarkup(
      <MarketplaceRowView
        title="@acme/widget@1.0.0"
        statusLabel="pending"
        statusVariant="secondary"
        meta="vendor #7 · submitted 2 hours ago"
        right={<span>ACTION-SLOT</span>}
      />,
    );
    expect(html).toContain("@acme/widget@1.0.0");
    expect(html).toContain("pending");
    expect(html).toContain("vendor #7");
    expect(html).toContain("ACTION-SLOT");
  });

  it("moderation row renders Approve + Reject affordances", () => {
    const html = renderToStaticMarkup(
      <MarketplaceDecisionActions sourceId="marketplace-submission-moderation" rowId="s1" mode="moderate" />,
    );
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
  });

  it("optional eligibility disables + annotates the action (#1045)", () => {
    const html = renderToStaticMarkup(
      <MarketplaceDecisionActions
        sourceId="marketplace-submission-moderation"
        rowId="s1"
        mode="moderate"
        eligibility={{ can_approve: false, reason: "Separation of duties" }}
      />,
    );
    // Approve button is disabled and the reason is surfaced.
    expect(html).toMatch(/Approve<\/button>/);
    expect(html).toContain("disabled");
    expect(html).toContain("Separation of duties");
  });

  it("a 'Your requests' row renders a Withdraw affordance", () => {
    const html = renderToStaticMarkup(
      <MarketplaceDecisionActions sourceId="marketplace-my-submissions" rowId="s1" mode="withdraw" />,
    );
    expect(html).toContain("Withdraw");
  });
});
