// @vitest-environment jsdom
//
// A moderation row whose eligibility refuses BOTH decisions is "Awaiting
// others", and the application drawing's "Marketplace approval states" block
// (specs/app.html V.1) says of it: "the row draws no decide action"
// (cinatra#4296). The REAL MarketplaceDecisionActions renders here; only its
// server action is replaced, so the test sees the controls it draws.
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("../actions", () => ({ decideApprovalRow: vi.fn(async () => ({ ok: false })) }));
vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: vi.fn(() => null) }));
vi.mock("@/lib/marketplace-credentials", () => ({
  resolveMarketplaceAdminToken: vi.fn(() => {
    throw new Error("MARKETPLACE_ADMIN_TOKEN_MISSING");
  }),
  hasConsumerOrVendorMarketplaceToken: vi.fn(() => false),
  resolveConsumerOrVendorMarketplaceToken: vi.fn(() => {
    throw new Error("VENDOR_CREDENTIALS_MISSING");
  }),
}));
vi.mock("../marketplace-decision-helpers", () => ({
  decideMarketplaceSubmission: vi.fn(),
  withdrawMarketplaceSubmission: vi.fn(),
  decideMarketplaceVendorApplication: vi.fn(),
}));

import { MarketplaceDecisionActions } from "../marketplace-decision-actions";
import { marketplaceSubmissionModerationSource } from "../sources/marketplace-submission-moderation";
import { marketplaceVendorAppModerationSource } from "../sources/marketplace-vendor-app-moderation";
import type { ApprovalRow, ApprovalSource, RowEligibility } from "../sources/types";

afterEach(cleanup);

const BOTH_REFUSED: RowEligibility = { can_approve: false, can_reject: false, reason: "SoD" };

function buttonLabels(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll("button")).map((b) => (b.textContent ?? "").trim());
}

function drawRow(source: ApprovalSource, sourceId: string, status: string, raw: unknown, eligibility?: RowEligibility) {
  const row: ApprovalRow = {
    id: "r1",
    sourceId,
    title: "Row title",
    status,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    raw,
    eligibility,
  };
  return render(source.rowRenderer(row, { direction: "inbox" }) as ReactElement).container;
}

describe("MarketplaceDecisionActions: both decisions refused", () => {
  it("draws no Approve or Reject control and no decision form", () => {
    const { container } = render(
      <MarketplaceDecisionActions sourceId="s" rowId="r1" mode="moderate" eligibility={BOTH_REFUSED} />,
    );
    expect(buttonLabels(container)).toEqual([]);
    expect(container.querySelector("form")).toBeNull();
  });

  it("still draws both controls when only one decision is refused (the other stays decidable)", () => {
    const { container } = render(
      <MarketplaceDecisionActions
        sourceId="s"
        rowId="r1"
        mode="moderate"
        eligibility={{ can_approve: true, can_reject: false, reason: "SoD" }}
      />,
    );
    expect(buttonLabels(container)).toEqual(["Approve", "Reject"]);
  });

  it("still draws both controls with no eligibility hint", () => {
    const { container } = render(<MarketplaceDecisionActions sourceId="s" rowId="r1" mode="moderate" />);
    expect(buttonLabels(container)).toEqual(["Approve", "Reject"]);
  });
});

describe("a moderation row the viewer may not decide draws no decide action", () => {
  it("vendor-application moderation: Awaiting others and no Approve or Reject", () => {
    const c = drawRow(
      marketplaceVendorAppModerationSource,
      "marketplace-vendor-app-moderation",
      "applied",
      { scope: "acme", tier: "standard", repairStuck: false, recoveryAttempts: 0 },
      BOTH_REFUSED,
    );
    const pill = c.querySelector('[data-slot="status-pill"]');
    expect(pill?.textContent).toBe("Awaiting others");
    expect(buttonLabels(c)).toEqual([]);
  });

  it("extension-submission moderation: Awaiting others and no Approve or Reject", () => {
    const c = drawRow(
      marketplaceSubmissionModerationSource,
      "marketplace-submission-moderation",
      "pending",
      { vendorId: 7, promotionState: "none" },
      BOTH_REFUSED,
    );
    const pill = c.querySelector('[data-slot="status-pill"]');
    expect(pill?.textContent).toBe("Awaiting others");
    expect(buttonLabels(c)).toEqual([]);
  });
});
