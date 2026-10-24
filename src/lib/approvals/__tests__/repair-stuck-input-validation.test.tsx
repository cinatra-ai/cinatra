// @vitest-environment jsdom
//
// The repair data of a vendor application arrive as unchecked JSON: the
// marketplace client only casts the response, and the local identity store
// casts its persisted row (cinatra#4296). These tests drive every road that
// reads them through its PUBLIC entry point (the row mappers, the row
// renderers, the feed view model, the Notifications card and the environment
// card) with missing, empty, invalid and wrongly typed values.
//
//   stuck    only for a valid `repair_stuck_at` timestamp string; missing, null,
//            empty, invalid or a non-string all mean NOT stuck.
//   attempts only for a non-negative safe integer of type number; a fraction, a
//            string, NaN, an infinity or an unsafe integer means no count (the
//            flag still stands).
//   self     the instance's own stuck application keeps the Failed pill on its
//            row, its Notifications card and its environment card, although
//            the status API carries no attempt count.
import React, { type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("@/app/notifications/feed-actions", () => ({ fetchFeedWindow: vi.fn() }));
vi.mock("@/app/notifications/approval-inline-actions", () => ({
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
vi.mock("@/app/configuration/environment/vendor-application-actions", () => ({
  cancelVendorApplicationAction: vi.fn(),
  refreshVendorApplicationStatusAction: vi.fn(),
}));

import type { InstanceIdentity } from "@/lib/instance-identity-store";
import type { ApprovalRow, ApprovalSource } from "@/lib/approvals/sources/types";
import type { UnifiedFeedItem } from "@/lib/approvals/unified-feed";
import * as vendorAppModeration from "@/lib/approvals/sources/marketplace-vendor-app-moderation";
import * as vendorAppStatus from "@/lib/approvals/sources/marketplace-vendor-app-status";
import { buildFeedRowVMs, paginateFeed, type FeedRowVM } from "@/app/notifications/feed-view-model";
import type { FeedWindowResult } from "@/app/notifications/feed-window";
import { NotificationsFeed } from "@/app/notifications/notifications-feed";
import { VendorApplicationStatusCard } from "@/app/configuration/environment/vendor-application-status-card";

afterEach(cleanup);

const CREATED = "2026-05-15T06:00:00.000Z";
const STUCK_AT = "2026-05-15T07:00:00.000Z";

// The stamps that must NOT mean stuck. `MISSING` deletes the key.
const MISSING = Symbol("missing");
const NOT_STUCK: Array<[string, unknown]> = [
  ["missing", MISSING],
  ["undefined", undefined],
  ["null", null],
  ["empty", ""],
  ["blank", "   "],
  ["not a date", "not a date"],
  ["an impossible date", "2026-13-45T00:00:00.000Z"],
  ["a number", 1747292400000],
  ["true", true],
  ["an object", {}],
];

// The counts that must draw NO count (the flag still stands).
const NO_COUNT: Array<[string, unknown]> = [
  ["missing", MISSING],
  ["null", null],
  ["a fraction above one", 2.7],
  ["a fraction below one", 0.5],
  ["a runtime string", "3"],
  ["NaN", Number.NaN],
  ["an infinity", Number.POSITIVE_INFINITY],
  ["a negative", -1],
  ["an unsafe integer", 2 ** 53],
  ["a boolean", true],
];

type ModerationMapper = (r: unknown, ownAppId: string | undefined, ownCreatedAt: string) => ApprovalRow;
type StatusMapper = (status: unknown, createdAt: string) => ApprovalRow | null;

function moderationMapper(): ModerationMapper {
  const fn = (vendorAppModeration as unknown as { toVendorApplicationModerationRow?: ModerationMapper })
    .toVendorApplicationModerationRow;
  expect(typeof fn, "the moderation source exports no row mapper").toBe("function");
  return fn!;
}

function statusMapper(): StatusMapper {
  const fn = (vendorAppStatus as unknown as { toVendorApplicationStatusRow?: StatusMapper })
    .toVendorApplicationStatusRow;
  expect(typeof fn, "the self-status source exports no row mapper").toBe("function");
  return fn!;
}

function remoteAdminRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    application_id: "app-1",
    display_name: "Acme Tools",
    scope: "acme",
    tier: "standard",
    status: "applied",
    applied_at: CREATED,
    repair_stuck_at: STUCK_AT,
    recovery_attempts: 3,
    eligibility: null,
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === MISSING) delete base[k];
    else base[k] = v;
  }
  return base;
}

function with_(key: string, value: unknown): Record<string, unknown> {
  return value === MISSING ? remoteAdminRow({ [key]: MISSING }) : remoteAdminRow({ [key]: value });
}

function pills(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-slot="status-pill"]'));
}

function drawRow(source: ApprovalSource, row: ApprovalRow, direction: "inbox" | "mine"): HTMLElement {
  return render(source.rowRenderer(row, { direction }) as ReactElement).container;
}

function item(row: ApprovalRow, direction: "inbox" | "mine"): UnifiedFeedItem {
  return { kind: "approval", createdAt: row.createdAt, sourceKey: row.sourceId, id: row.id, approval: { row, direction } };
}

function drawFeedCard(row: ApprovalRow, direction: "inbox" | "mine"): HTMLElement {
  const vms: FeedRowVM[] = buildFeedRowVMs([item(row, direction)]);
  const window: FeedWindowResult = {
    ...paginateFeed(vms, "all", 1, 25),
    degraded: false,
    capped: false,
    newestNotification: null,
  };
  const { container } = render(React.createElement(NotificationsFeed, { initialWindow: window }));
  const card = container.querySelector<HTMLElement>('[data-conformance-id="approval-row"]');
  expect(card, "the feed draws no approval card").not.toBeNull();
  return card!;
}

function metaLine(root: HTMLElement): string {
  return root.querySelector("p")?.textContent ?? "";
}

// ── the moderation row: the stuck stamp ─────────────────────────────────────
describe("vendor-application moderation: only a valid repair_stuck_at means stuck", () => {
  it.each(NOT_STUCK)("a %s repair_stuck_at is NOT stuck: no public flag, no Failed pill", (_name, stamp) => {
    const row = moderationMapper()(with_("repair_stuck_at", stamp), undefined, CREATED);
    expect(row.repairStuck).toBeUndefined();
    expect("repairStuck" in row).toBe(false);
    const c = drawRow(vendorAppModeration.marketplaceVendorAppModerationSource, row, "inbox");
    expect(pills(c).map((p) => p.getAttribute("data-status"))).not.toContain("failed");
    expect(metaLine(c)).not.toContain("repair attempt");
  });

  it("a valid timestamp is stuck, with its count", () => {
    const row = moderationMapper()(remoteAdminRow(), undefined, CREATED);
    expect(row.repairStuck).toEqual({ attempts: 3 });
    const c = drawRow(vendorAppModeration.marketplaceVendorAppModerationSource, row, "inbox");
    expect(pills(c).map((p) => p.getAttribute("data-status"))).toContain("failed");
    expect(metaLine(c)).toContain("3 repair attempts");
  });

  it("a timestamp without a time part is a timestamp too", () => {
    const row = moderationMapper()(remoteAdminRow({ repair_stuck_at: "2026-05-15" }), undefined, CREATED);
    expect(row.repairStuck).toEqual({ attempts: 3 });
  });
});

// ── the moderation row: the attempt count ───────────────────────────────────
describe("vendor-application moderation: only a non-negative safe integer is a count", () => {
  it.each(NO_COUNT)("a %s recovery_attempts keeps the flag but draws no count", (_name, attempts) => {
    const row = moderationMapper()(with_("recovery_attempts", attempts), undefined, CREATED);
    // Strict: the public field carries no `attempts` key at all.
    expect(row.repairStuck).toStrictEqual({});
    const c = drawRow(vendorAppModeration.marketplaceVendorAppModerationSource, row, "inbox");
    expect(pills(c).map((p) => p.getAttribute("data-status"))).toContain("failed");
    expect(metaLine(c)).not.toContain("repair attempt");
    expect(metaLine(c)).not.toMatch(/NaN|Infinity|undefined|null/);
  });

  it("zero attempts is a valid count, and draws no count text", () => {
    const row = moderationMapper()(remoteAdminRow({ recovery_attempts: 0 }), undefined, CREATED);
    expect(row.repairStuck).toEqual({ attempts: 0 });
    const c = drawRow(vendorAppModeration.marketplaceVendorAppModerationSource, row, "inbox");
    expect(pills(c).map((p) => p.getAttribute("data-status"))).toContain("failed");
    expect(metaLine(c)).not.toContain("repair attempt");
  });

  it("the largest safe integer is still a count", () => {
    const row = moderationMapper()(
      remoteAdminRow({ recovery_attempts: Number.MAX_SAFE_INTEGER }),
      undefined,
      CREATED,
    );
    expect(row.repairStuck).toEqual({ attempts: Number.MAX_SAFE_INTEGER });
  });
});

// ── the moderation row: the other fields it reads from the same JSON ─────────
describe("vendor-application moderation: the other fields are validated the same way", () => {
  it("draws no scope chip, no tier and no applied time when they are malformed, and still renders", () => {
    const row = moderationMapper()(
      remoteAdminRow({ scope: 7, tier: null, applied_at: "garbage", display_name: "" }),
      undefined,
      CREATED,
    );
    expect(row.title).toBe("Vendor application");
    expect(row.subtitle).toBeUndefined();
    const c = drawRow(vendorAppModeration.marketplaceVendorAppModerationSource, row, "inbox");
    expect(c.querySelector('[data-slot="badge"]')).toBeNull();
    const meta = metaLine(c);
    expect(meta).not.toMatch(/null|undefined|tier|applied/);
    expect(meta).toContain("3 repair attempts");
  });

  it("keeps the meta line as before for well-formed fields", () => {
    const appliedAt = new Date(Date.now() - 60_000).toISOString();
    const row = moderationMapper()(remoteAdminRow({ applied_at: appliedAt }), undefined, CREATED);
    expect(row.createdAt).toBe(appliedAt);
    const c = drawRow(vendorAppModeration.marketplaceVendorAppModerationSource, row, "inbox");
    expect(metaLine(c)).toMatch(/^standard tier · applied .+ ago · 3 repair attempts$/);
    expect(c.querySelector('[data-slot="badge"]')?.textContent).toBe("acme");
  });
});

// ── the full Notifications card, from the remote row ────────────────────────
describe("the Notifications card draws only validated repair data", () => {
  it.each(NO_COUNT)("a %s count: the card draws the Failed pill and no count", (_name, attempts) => {
    const row = moderationMapper()(with_("recovery_attempts", attempts), undefined, CREATED);
    const card = drawFeedCard(row, "inbox");
    expect(pills(card).map((p) => p.getAttribute("data-status"))).toContain("failed");
    expect(metaLine(card)).not.toContain("repair attempt");
    expect(metaLine(card)).not.toMatch(/NaN|Infinity/);
  });

  it.each(NOT_STUCK)("a %s stamp: the card draws no Failed pill", (_name, stamp) => {
    const row = moderationMapper()(with_("repair_stuck_at", stamp), undefined, CREATED);
    const card = drawFeedCard(row, "inbox");
    expect(pills(card).map((p) => p.getAttribute("data-status"))).not.toContain("failed");
  });

  it("a valid stamp and count: the Failed pill and the count", () => {
    const card = drawFeedCard(moderationMapper()(remoteAdminRow(), undefined, CREATED), "inbox");
    expect(pills(card).map((p) => p.getAttribute("data-status"))).toContain("failed");
    expect(metaLine(card)).toContain("3 repair attempts");
  });
});

// ── the view model re-reads any source's public field ───────────────────────
describe("the feed view model copies only a validated count", () => {
  const base: ApprovalRow = {
    id: "app-9",
    sourceId: "marketplace-vendor-app-moderation",
    title: "Zeta",
    status: "applied",
    createdAt: CREATED,
  };

  it.each([
    ["a runtime string", "3"],
    ["a fraction", 2.5],
    ["an unsafe integer", 2 ** 53],
    ["NaN", Number.NaN],
  ])("a %s count becomes the flag without a count", (_name, attempts) => {
    const row = { ...base, repairStuck: { attempts, extra: "x" } } as unknown as ApprovalRow;
    const [vm] = buildFeedRowVMs([item(row, "inbox")]);
    if (vm.kind !== "approval") throw new Error("not an approval");
    expect(vm.approval.repairStuck).toStrictEqual({});
    expect(JSON.stringify(vm)).not.toContain("extra");
  });

  it("a repair field that is not an object is not stuck", () => {
    const row = { ...base, repairStuck: true } as unknown as ApprovalRow;
    const [vm] = buildFeedRowVMs([item(row, "inbox")]);
    if (vm.kind !== "approval") throw new Error("not an approval");
    expect("repairStuck" in vm.approval).toBe(false);
  });

  it("a flag without a count (the self-status road) reaches the card as the Failed pill", () => {
    const row: ApprovalRow = { ...base, repairStuck: {} };
    const [vm] = buildFeedRowVMs([item(row, "mine")]);
    if (vm.kind !== "approval") throw new Error("not an approval");
    expect(vm.approval.repairStuck).toEqual({});
  });
});

// ── the instance's own application (the self-status road) ───────────────────
describe("the instance's own stuck application keeps the Failed state", () => {
  const stuckStatus = { state: "applied", scope: "acme", application_id: "app-1", tier: "standard", repair_stuck_at: STUCK_AT };

  it("the status row publishes the flag without a count", () => {
    const row = statusMapper()(stuckStatus, CREATED);
    expect(row).not.toBeNull();
    expect(row!.repairStuck).toEqual({});
  });

  it("its own row draws Awaiting others and the Failed pill beside it, with no count", () => {
    const row = statusMapper()(stuckStatus, CREATED)!;
    const c = drawRow(vendorAppStatus.marketplaceVendorAppStatusSource, row, "mine");
    const drawn = pills(c);
    expect(drawn.map((p) => p.textContent)).toEqual(["Awaiting others", "Failed"]);
    expect(drawn[1].getAttribute("data-status")).toBe("failed");
    expect(metaLine(c)).not.toContain("repair attempt");
  });

  it("its Notifications card draws the Failed pill beside Awaiting others", () => {
    const row = statusMapper()(stuckStatus, CREATED)!;
    const card = drawFeedCard(row, "mine");
    expect(pills(card).map((p) => p.textContent)).toEqual(["Awaiting others", "Failed"]);
    expect(metaLine(card)).not.toContain("repair attempt");
  });

  it.each(NOT_STUCK)("a %s stamp on its own application is not stuck", (_name, stamp) => {
    const status: Record<string, unknown> = { ...stuckStatus };
    if (stamp === MISSING) delete status.repair_stuck_at;
    else status.repair_stuck_at = stamp;
    const row = statusMapper()(status, CREATED)!;
    expect(row.repairStuck).toBeUndefined();
    const c = drawRow(vendorAppStatus.marketplaceVendorAppStatusSource, row, "mine");
    expect(pills(c).map((p) => p.textContent)).toEqual(["Awaiting others"]);
  });

  it("an application that is not pending leaves the list", () => {
    expect(statusMapper()({ ...stuckStatus, state: "approved" }, CREATED)).toBeNull();
  });

  it("draws no tier, reason or title from malformed fields", () => {
    const row = statusMapper()(
      { state: "applied", scope: 9, application_id: null, tier: {}, decision_reason: 5, repair_stuck_at: null },
      CREATED,
    )!;
    expect(row.title).toBe("Vendor application");
    expect(row.id).toBe("vendor-application");
    const c = drawRow(vendorAppStatus.marketplaceVendorAppStatusSource, row, "mine");
    expect(metaLine(c)).toBe("awaiting marketplace review");
  });
});

// ── the environment card reads the persisted stamp ──────────────────────────
describe("the environment card draws the persisted stuck flag", () => {
  function identity(stamp: unknown): InstanceIdentity {
    const id: Record<string, unknown> = { vendorState: "applied", vendorApplicationId: "app-1", vendorScope: "acme" };
    if (stamp !== MISSING) id.vendorApplicationRepairStuckAt = stamp;
    return id as unknown as InstanceIdentity;
  }

  it("a valid stamp draws the Failed pill beside Awaiting others", () => {
    const { container } = render(<VendorApplicationStatusCard identity={identity(STUCK_AT)} />);
    const drawn = pills(container);
    expect(drawn.map((p) => p.textContent)).toEqual(["Awaiting others", "Failed"]);
    expect(drawn[1].getAttribute("data-status")).toBe("failed");
  });

  it.each(NOT_STUCK)("a %s stamp draws Awaiting others only", (_name, stamp) => {
    const { container } = render(<VendorApplicationStatusCard identity={identity(stamp)} />);
    expect(pills(container).map((p) => p.textContent)).toEqual(["Awaiting others"]);
  });
});
