// @vitest-environment jsdom
//
// The four marketplace approval sources draw their row state as the roster
// status pill, never as a Badge (cinatra#4296). The application drawing's
// "Marketplace approval states" block:
//
//   "Every state of a marketplace approval row takes one of the pills above;
//    none rides on a Badge, and the pill's own label is shown, never the raw
//    state word."
//
// and, for repair stuck: "the pill is drawn beside the row's state pill. Repair
// stuck is drawn as the existing Failed pill, and the row's meta line carries
// the attempt count."
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

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
vi.mock("../../marketplace-decision-actions", () => ({ MarketplaceDecisionActions: () => null }));
vi.mock("../../marketplace-decision-helpers", () => ({
  decideMarketplaceSubmission: vi.fn(),
  withdrawMarketplaceSubmission: vi.fn(),
  decideMarketplaceVendorApplication: vi.fn(),
}));
// The marketplace client is not mocked here: the sources import it, but a
// rowRenderer never calls it, and its module has no import-time effect.

import { marketplaceSubmissionModerationSource } from "../marketplace-submission-moderation";
import { marketplaceVendorAppModerationSource } from "../marketplace-vendor-app-moderation";
import { marketplaceMySubmissionsSource } from "../marketplace-my-submissions";
import { marketplaceVendorAppStatusSource } from "../marketplace-vendor-app-status";
import type { ApprovalRow, ApprovalSource, RowEligibility } from "../types";

afterEach(cleanup);

const CREATED = new Date(Date.now() - 60_000).toISOString();

function row(sourceId: string, status: string, raw: unknown, eligibility?: RowEligibility): ApprovalRow {
  return { id: "r1", sourceId, title: "Row title", status, createdAt: CREATED, raw, eligibility };
}

function draw(source: ApprovalSource, r: ApprovalRow, direction: "inbox" | "mine") {
  const el = source.rowRenderer(r, { direction }) as ReactElement;
  const { container } = render(el);
  return container;
}

function statePill(container: HTMLElement): HTMLElement {
  const pills = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="status-pill"]'));
  expect(pills.length, "the row draws no status pill").toBeGreaterThan(0);
  return pills[0];
}

const SUBMISSION_RAW = { vendorId: 7, promotionState: "none" };
const MY_SUBMISSION_RAW = { promotionState: "none", promotionError: null, decisionReason: null };
const VENDOR_APP_RAW = { scope: "acme", tier: "standard", repairStuck: false, recoveryAttempts: 0 };
const STATUS_RAW = { tier: "standard", decisionReason: null, decidedAt: null, repairStuck: false };

describe("moderation rows the viewer may decide: Awaiting you", () => {
  it("extension-submission moderation draws pending as the hold pill with a dot", () => {
    const c = draw(
      marketplaceSubmissionModerationSource,
      row("marketplace-submission-moderation", "pending", SUBMISSION_RAW),
      "inbox",
    );
    const pill = statePill(c);
    expect(pill.getAttribute("data-status")).toBe("hold");
    expect(pill.getAttribute("data-glyph")).toBe("dot");
    expect(pill.textContent).toBe("Awaiting you");
    expect(c.querySelector('[data-slot="badge"]')).toBeNull();
    expect(c.textContent).not.toMatch(/\bpending\b/);
  });

  it("vendor-application moderation draws applied as the hold pill with a dot", () => {
    const c = draw(
      marketplaceVendorAppModerationSource,
      row("marketplace-vendor-app-moderation", "applied", VENDOR_APP_RAW),
      "inbox",
    );
    const pill = statePill(c);
    expect(pill.getAttribute("data-status")).toBe("hold");
    expect(pill.getAttribute("data-glyph")).toBe("dot");
    expect(pill.textContent).toBe("Awaiting you");
  });
});

describe("rows the viewer may not decide: Awaiting others", () => {
  it("a moderation row whose eligibility refuses both decisions draws the idle pill with a dot", () => {
    const c = draw(
      marketplaceSubmissionModerationSource,
      row("marketplace-submission-moderation", "pending", SUBMISSION_RAW, {
        can_approve: false,
        can_reject: false,
        reason: "SoD",
      }),
      "inbox",
    );
    const pill = statePill(c);
    expect(pill.getAttribute("data-status")).toBe("idle");
    expect(pill.getAttribute("data-glyph")).toBe("dot");
    expect(pill.textContent).toBe("Awaiting others");
  });

  it("the viewer's own submission draws pending as Awaiting others, never a Badge", () => {
    const c = draw(
      marketplaceMySubmissionsSource,
      row("marketplace-my-submissions", "pending", MY_SUBMISSION_RAW),
      "mine",
    );
    const pill = statePill(c);
    expect(pill.getAttribute("data-status")).toBe("idle");
    expect(pill.textContent).toBe("Awaiting others");
    expect(c.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("the instance's own vendor application draws applied as Awaiting others, never a Badge", () => {
    const c = draw(
      marketplaceVendorAppStatusSource,
      row("marketplace-vendor-app-status", "applied", STATUS_RAW),
      "mine",
    );
    const pill = statePill(c);
    expect(pill.getAttribute("data-status")).toBe("idle");
    expect(pill.textContent).toBe("Awaiting others");
    expect(c.querySelector('[data-slot="badge"]')).toBeNull();
  });
});

describe("the decided states take their roster pill and label", () => {
  it.each([
    ["approved", "approved", "Approved"],
    ["promoted", "approved", "Approved"],
    ["rejected", "declined", "Declined"],
    ["withdrawn", "withdrawn", "Withdrawn"],
    ["superseded", "archived", "Archived"],
  ])("the viewer's own submission in state '%s' draws the %s pill labelled %s", (state, status, label) => {
    const c = draw(
      marketplaceMySubmissionsSource,
      row("marketplace-my-submissions", state, MY_SUBMISSION_RAW),
      "mine",
    );
    const pill = statePill(c);
    expect(pill.getAttribute("data-status")).toBe(status);
    expect(pill.textContent).toBe(label);
    expect(c.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("the instance's own vendor application in state 'reset' draws the Reset pill", () => {
    const c = draw(
      marketplaceVendorAppStatusSource,
      row("marketplace-vendor-app-status", "reset", STATUS_RAW),
      "mine",
    );
    const pill = statePill(c);
    expect(pill.getAttribute("data-status")).toBe("reset");
    expect(pill.textContent).toBe("Reset");
  });
});

describe("repair stuck: the Failed pill beside the state pill, the count on the meta line", () => {
  it("draws the Failed pill after the state pill and moves the attempt count to the meta line", () => {
    const c = draw(
      marketplaceVendorAppModerationSource,
      row("marketplace-vendor-app-moderation", "applied", {
        ...VENDOR_APP_RAW,
        repairStuck: true,
        recoveryAttempts: 3,
      }),
      "inbox",
    );
    const pills = Array.from(c.querySelectorAll<HTMLElement>('[data-slot="status-pill"]'));
    expect(pills.map((p) => p.getAttribute("data-status"))).toEqual(["hold", "failed"]);
    expect(pills[1].textContent).toBe("Failed");
    // No destructive Badge carries the flag any more.
    expect(c.textContent).not.toContain("repair stuck ·");
    const meta = c.querySelector("p");
    expect(meta?.textContent).toContain("3 repair attempts");
  });

  it("says '1 repair attempt' in the singular for exactly one attempt", () => {
    const c = draw(
      marketplaceVendorAppModerationSource,
      row("marketplace-vendor-app-moderation", "applied", {
        ...VENDOR_APP_RAW,
        repairStuck: true,
        recoveryAttempts: 1,
      }),
      "inbox",
    );
    const pills = Array.from(c.querySelectorAll<HTMLElement>('[data-slot="status-pill"]'));
    expect(pills.map((p) => p.getAttribute("data-status"))).toEqual(["hold", "failed"]);
    const meta = c.querySelector("p")?.textContent ?? "";
    expect(meta).toContain("1 repair attempt");
    expect(meta).not.toContain("1 repair attempts");
  });

  it("draws the Failed pill but no attempt count when a stuck repair has 0 attempts", () => {
    const c = draw(
      marketplaceVendorAppModerationSource,
      row("marketplace-vendor-app-moderation", "applied", {
        ...VENDOR_APP_RAW,
        repairStuck: true,
        recoveryAttempts: 0,
      }),
      "inbox",
    );
    const pills = Array.from(c.querySelectorAll<HTMLElement>('[data-slot="status-pill"]'));
    expect(pills.map((p) => p.getAttribute("data-status"))).toEqual(["hold", "failed"]);
    expect(c.querySelector("p")?.textContent ?? "").not.toContain("repair attempt");
  });

  it("draws no Failed pill when the application is not stuck", () => {
    const c = draw(
      marketplaceVendorAppModerationSource,
      row("marketplace-vendor-app-moderation", "applied", VENDOR_APP_RAW),
      "inbox",
    );
    const pills = Array.from(c.querySelectorAll<HTMLElement>('[data-slot="status-pill"]'));
    expect(pills.map((p) => p.getAttribute("data-status"))).toEqual(["hold"]);
  });
});
