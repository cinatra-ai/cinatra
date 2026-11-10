// @vitest-environment jsdom
//
// The two extension-submission sources draw "submitted <distance>" on a row's
// meta line from `submitted_at`, which the marketplace client only casts
// (cinatra#4296). A malformed stamp used to reach date-fns, which throws a
// RangeError on an invalid date, so the row failed to render. Now the row
// renders and its meta line leaves the time off; a valid stamp is drawn as
// before.
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const identity = vi.hoisted(() => ({ value: null as null | { vendorState: string } }));

vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: vi.fn(() => identity.value) }));
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

import { marketplaceSubmissionModerationSource } from "../marketplace-submission-moderation";
import { marketplaceMySubmissionsSource } from "../marketplace-my-submissions";
import type { ApprovalRow, ApprovalSource } from "../types";

afterEach(() => {
  cleanup();
  identity.value = null;
});

const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

// The stamps that must not reach date-fns.
const MALFORMED: Array<[string, unknown]> = [
  ["text", "garbage"],
  ["an empty string", ""],
  ["a month 13", "2026-13-45T00:00:00.000Z"],
  ["null", null],
  ["undefined", undefined],
  ["an object", {}],
];

function row(sourceId: string, createdAt: unknown, raw: unknown): ApprovalRow {
  return { id: "r1", sourceId, title: "Row title", status: "pending", createdAt, raw } as ApprovalRow;
}

function draw(source: ApprovalSource, r: ApprovalRow, direction: "inbox" | "mine"): HTMLElement {
  return render(source.rowRenderer(r, { direction }) as ReactElement).container;
}

function metaLine(root: HTMLElement): string {
  return root.querySelector("p")?.textContent ?? "";
}

const MODERATION_RAW = { vendorId: 7, promotionState: "requested" };
const MY_RAW = { promotionState: "requested", promotionError: null, decisionReason: "needs a licence" };

describe("submission moderation: a malformed submitted_at", () => {
  it.each(MALFORMED)("%s: the row renders, its title and the rest of its meta line, without a time", (_n, stamp) => {
    identity.value = { vendorState: "approved" };
    const r = row("marketplace-submission-moderation", stamp, MODERATION_RAW);
    let c: HTMLElement | undefined;
    expect(() => {
      c = draw(marketplaceSubmissionModerationSource, r, "inbox");
    }).not.toThrow();
    expect(c!.textContent).toContain("Row title");
    expect(metaLine(c!)).toBe("vendor #7 · promotion requested");
  });

  it("a valid stamp is drawn as before", () => {
    identity.value = { vendorState: "approved" };
    const c = draw(
      marketplaceSubmissionModerationSource,
      row("marketplace-submission-moderation", THREE_DAYS_AGO, MODERATION_RAW),
      "inbox",
    );
    expect(metaLine(c)).toBe("vendor #7 · submitted 3 days ago · promotion requested");
  });

  it("an unregistered instance draws no vendor copy", () => {
    const c = draw(
      marketplaceSubmissionModerationSource,
      row("marketplace-submission-moderation", THREE_DAYS_AGO, MODERATION_RAW),
      "inbox",
    );
    expect(metaLine(c)).toBe("submitted 3 days ago · promotion requested");
  });
});

describe("the instance's own submissions: a malformed submitted_at", () => {
  it.each(MALFORMED)("%s: the row renders, its title and the rest of its meta line, without a time", (_n, stamp) => {
    const r = row("marketplace-my-submissions", stamp, MY_RAW);
    let c: HTMLElement | undefined;
    expect(() => {
      c = draw(marketplaceMySubmissionsSource, r, "mine");
    }).not.toThrow();
    expect(c!.textContent).toContain("Row title");
    expect(metaLine(c!)).toBe("promotion requested · needs a licence");
  });

  it("a valid stamp is drawn as before", () => {
    const c = draw(marketplaceMySubmissionsSource, row("marketplace-my-submissions", THREE_DAYS_AGO, MY_RAW), "mine");
    expect(metaLine(c)).toBe("submitted 3 days ago · promotion requested · needs a licence");
  });
});
