// @vitest-environment jsdom
//
// The Notifications approval card draws the approval's ONE pending pill and the
// repair-stuck flag (cinatra#4296). The application drawing's "Marketplace
// approval states" block (specs/app.html V.1):
//
//   Awaiting you    = `pill hold` with a dot; Awaiting others = `pill idle` with
//   a dot. "The pending pill of the approval card, as drawn on Notifications;
//   one pending state is drawn one way on every screen."
//
//   Repair stuck: "the pill is drawn beside the row's state pill. Repair stuck
//   is drawn as the existing Failed pill, and the row's meta line carries the
//   attempt count."
//
// These tests render the LIVE route's card (NotificationsFeed) and the
// marketplace approval row, and check that both draw the same pending pill.
import React, { type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("../feed-actions", () => ({ fetchFeedWindow: vi.fn() }));
vi.mock("../approval-inline-actions", () => ({
  ApprovalInlineActions: () => React.createElement("span", { "data-testid": "decide-stub" }),
}));
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
vi.mock("@/lib/approvals/marketplace-decision-actions", () => ({
  MarketplaceDecisionActions: () => null,
}));
vi.mock("@/lib/approvals/marketplace-decision-helpers", () => ({
  decideMarketplaceSubmission: vi.fn(),
  withdrawMarketplaceSubmission: vi.fn(),
  decideMarketplaceVendorApplication: vi.fn(),
}));

import type { ApprovalRow } from "@/lib/approvals/sources/types";
import type { UnifiedFeedItem } from "@/lib/approvals/unified-feed";
import * as vendorAppModeration from "@/lib/approvals/sources/marketplace-vendor-app-moderation";

import { buildFeedRowVMs, paginateFeed, type ApprovalRowVM, type FeedRowVM } from "../feed-view-model";
import type { FeedWindowResult } from "../feed-window";
import { NotificationsFeed } from "../notifications-feed";

afterEach(cleanup);

const SOURCE = "marketplace-vendor-app-moderation";
const CREATED = "2026-05-15T06:00:00.000Z";

function cardVM(over: Partial<ApprovalRowVM> & { actionable: boolean }): FeedRowVM {
  return {
    key: `approval:${SOURCE}:app-1`,
    kind: "approval",
    createdAt: CREATED,
    approval: {
      sourceId: SOURCE,
      rowId: "app-1",
      title: "Acme Tools",
      subtitle: "acme",
      status: "applied",
      direction: "inbox",
      decideKind: over.actionable ? "marketplace-moderate" : "none",
      ...over,
    },
  };
}

function drawCard(vm: FeedRowVM): HTMLElement {
  const window: FeedWindowResult = {
    ...paginateFeed([vm], "all", 1, 25),
    degraded: false,
    capped: false,
    newestNotification: null,
  };
  const { container } = render(React.createElement(NotificationsFeed, { initialWindow: window }));
  const card = container.querySelector<HTMLElement>('[data-conformance-id="approval-row"]');
  expect(card, "the feed draws no approval card").not.toBeNull();
  return card!;
}

function pills(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-slot="status-pill"]'));
}

function metaLine(card: HTMLElement): string {
  return card.querySelector("p")?.textContent ?? "";
}

/** The parts of a pill that make it look the way it does. */
function look(pill: HTMLElement) {
  const dot = pill.querySelector<HTMLElement>('[data-slot="status-pill-dot"]');
  return {
    className: pill.className,
    status: pill.getAttribute("data-status"),
    glyph: pill.getAttribute("data-glyph"),
    label: pill.textContent,
    dot: dot?.className ?? null,
  };
}

function drawModerationRow(eligibility?: ApprovalRow["eligibility"]): HTMLElement {
  const row: ApprovalRow = {
    id: "app-1",
    sourceId: SOURCE,
    title: "Acme Tools",
    status: "applied",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    eligibility,
    raw: { scope: "acme", tier: "standard", repairStuck: false, recoveryAttempts: 0 },
  };
  const el = vendorAppModeration.marketplaceVendorAppModerationSource.rowRenderer(row, {
    direction: "inbox",
  }) as ReactElement;
  return render(el).container;
}

describe("the Notifications approval card draws the V.1 pending pill", () => {
  it("draws Awaiting you as the hold status pill with the 7px dot", () => {
    const card = drawCard(cardVM({ actionable: true }));
    const [pill] = pills(card);
    expect(pill, "the card draws no status pill").toBeDefined();
    expect(pill.getAttribute("data-status")).toBe("hold");
    expect(pill.getAttribute("data-glyph")).toBe("dot");
    expect(pill.textContent).toBe("Awaiting you");
    const dot = pill.querySelector('[data-slot="status-pill-dot"]');
    expect(dot?.className).toContain("h-[7px]");
    expect(dot?.className).toContain("w-[7px]");
  });

  it("draws Awaiting others as the idle status pill with the 7px dot", () => {
    const card = drawCard(cardVM({ actionable: false, direction: "mine" }));
    const [pill] = pills(card);
    expect(pill, "the card draws no status pill").toBeDefined();
    expect(pill.getAttribute("data-status")).toBe("idle");
    expect(pill.getAttribute("data-glyph")).toBe("dot");
    expect(pill.textContent).toBe("Awaiting others");
  });

  it("draws no hand-built pill: no 6px dot span", () => {
    for (const actionable of [true, false]) {
      const card = drawCard(cardVM({ actionable }));
      expect(card.querySelector(".size-1\\.5")).toBeNull();
      cleanup();
    }
  });

  it("draws the same pending pill as the marketplace approval row (one source)", () => {
    const youCard = look(pills(drawCard(cardVM({ actionable: true })))[0]);
    cleanup();
    const youRow = look(pills(drawModerationRow())[0]);
    cleanup();
    expect(youCard).toEqual(youRow);

    const othersCard = look(pills(drawCard(cardVM({ actionable: false })))[0]);
    cleanup();
    const othersRow = look(
      pills(drawModerationRow({ can_approve: false, can_reject: false, reason: "SoD" }))[0],
    );
    expect(othersCard).toEqual(othersRow);
  });
});

describe("the Notifications approval card draws repair stuck as V.1 says", () => {
  it("draws the Failed pill beside the pending pill and the count on the meta line", () => {
    const card = drawCard(cardVM({ actionable: true, repairStuck: { attempts: 3 } }));
    expect(pills(card).map((p) => p.getAttribute("data-status"))).toEqual(["hold", "failed"]);
    expect(pills(card)[1].textContent).toBe("Failed");
    expect(metaLine(card)).toContain("3 repair attempts");
  });

  it("says '1 repair attempt' in the singular", () => {
    const card = drawCard(cardVM({ actionable: true, repairStuck: { attempts: 1 } }));
    expect(pills(card).map((p) => p.getAttribute("data-status"))).toEqual(["hold", "failed"]);
    expect(metaLine(card)).toContain("1 repair attempt");
    expect(metaLine(card)).not.toContain("1 repair attempts");
  });

  it("draws the Failed pill but no count for 0 attempts", () => {
    const card = drawCard(cardVM({ actionable: true, repairStuck: { attempts: 0 } }));
    expect(pills(card).map((p) => p.getAttribute("data-status"))).toEqual(["hold", "failed"]);
    expect(metaLine(card)).not.toContain("repair attempt");
  });

  it("draws no Failed pill when the repair is not stuck", () => {
    const card = drawCard(cardVM({ actionable: true }));
    expect(pills(card).map((p) => p.getAttribute("data-status"))).toEqual(["hold"]);
    expect(metaLine(card)).not.toContain("repair attempt");
  });
});

describe("the live feed carries only the repair fields the card draws", () => {
  function item(row: ApprovalRow): UnifiedFeedItem {
    return { kind: "approval", createdAt: row.createdAt, sourceKey: row.sourceId, id: row.id, approval: { row, direction: "inbox" } };
  }

  it("the vendor-application moderation row publishes the repair flag and count", () => {
    const toRow = (
      vendorAppModeration as unknown as {
        toVendorApplicationModerationRow?: (r: unknown, ownAppId: string | undefined, ownCreatedAt: string) => ApprovalRow;
      }
    ).toVendorApplicationModerationRow;
    expect(typeof toRow, "the source exports no row mapper").toBe("function");
    const remote = {
      application_id: "app-1",
      display_name: "Acme Tools",
      scope: "acme",
      tier: "standard",
      status: "applied",
      applied_at: CREATED,
      repair_stuck_at: "2026-05-15T07:00:00.000Z",
      recovery_attempts: 3,
      eligibility: null,
    };
    expect(toRow!(remote, undefined, CREATED).repairStuck).toEqual({ attempts: 3 });
    expect(toRow!({ ...remote, repair_stuck_at: null }, undefined, CREATED).repairStuck).toBeUndefined();
  });

  it("copies repairStuck into the view model and never the raw payload", () => {
    const row: ApprovalRow = {
      id: "app-1",
      sourceId: SOURCE,
      title: "Acme Tools",
      status: "applied",
      createdAt: CREATED,
      repairStuck: { attempts: 3 },
      raw: { scope: "acme", tier: "standard", repairStuck: true, recoveryAttempts: 3, internalToken: "secret-x" },
    } as ApprovalRow;
    const [vm] = buildFeedRowVMs([item(row)]);
    expect(vm.kind).toBe("approval");
    if (vm.kind !== "approval") return;
    expect(vm.approval.repairStuck).toEqual({ attempts: 3 });
    expect("raw" in vm.approval).toBe(false);
    expect(JSON.stringify(vm)).not.toContain("secret-x");
  });

  it("leaves repairStuck out of the view model when the row carries none", () => {
    const row: ApprovalRow = { id: "app-2", sourceId: SOURCE, title: "Beta", status: "applied", createdAt: CREATED };
    const [vm] = buildFeedRowVMs([item(row)]);
    if (vm.kind !== "approval") throw new Error("not an approval");
    expect("repairStuck" in vm.approval).toBe(false);
  });
});
