/**
 * Behaviour + connectivity proof for the four marketplace ApprovalSource
 * adapters. Verifies the 4-state model at the adapter boundary and the
 * load-bearing "ZERO remote marketplace calls when disconnected" guarantee
 * (the marketplace client is never even constructed unless a real credential is
 * present), plus the capped counts and the optional eligibility passthrough.
 *
 * All credential / identity / client dependencies are mocked — no DB, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  adminToken: undefined as string | undefined,
  hasVendor: false,
  vendorToken: undefined as string | undefined,
  adminSubs: [] as Record<string, unknown>[],
  vendorRows: [] as Record<string, unknown>[],
  selfSubs: [] as Record<string, unknown>[],
  vendorStatus: { state: "none" } as Record<string, unknown>,
}));

vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: vi.fn(() => null) }));
vi.mock("@/lib/marketplace-credentials", () => ({
  resolveMarketplaceAdminToken: vi.fn(() => {
    if (!h.adminToken) throw new Error("MARKETPLACE_ADMIN_TOKEN_MISSING");
    return h.adminToken;
  }),
  hasConsumerOrVendorMarketplaceToken: vi.fn(() => h.hasVendor),
  resolveConsumerOrVendorMarketplaceToken: vi.fn(() => {
    if (!h.vendorToken) throw new Error("VENDOR_CREDENTIALS_MISSING");
    return h.vendorToken;
  }),
}));
vi.mock("../../marketplace-decision-actions", () => ({ MarketplaceDecisionActions: () => null }));
vi.mock("../../marketplace-decision-helpers", () => ({
  decideMarketplaceSubmission: vi.fn(),
  withdrawMarketplaceSubmission: vi.fn(),
  decideMarketplaceVendorApplication: vi.fn(),
}));
vi.mock("@cinatra-ai/marketplace-mcp-client/http-client", () => ({
  createHttpMarketplaceMcpClient: vi.fn(() => ({
    extensionSubmissionListAdmin: vi.fn(async () => ({ submissions: h.adminSubs })),
    vendorApplicationListAdmin: vi.fn(async () => ({ rows: h.vendorRows, next_cursor: null })),
    extensionSubmissionListSelf: vi.fn(async () => ({ submissions: h.selfSubs })),
    vendorApplicationStatus: vi.fn(async () => h.vendorStatus),
  })),
}));

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import { marketplaceSubmissionModerationSource } from "../marketplace-submission-moderation";
import { marketplaceVendorAppModerationSource } from "../marketplace-vendor-app-moderation";
import { marketplaceMySubmissionsSource } from "../marketplace-my-submissions";
import { marketplaceVendorAppStatusSource } from "../marketplace-vendor-app-status";
import { invalidateMarketplaceApprovalCounts } from "../marketplace-shared";
import type { ApprovalViewer } from "../types";

const admin: ApprovalViewer = { userId: "a", orgId: "o", isAdmin: true };
const member: ApprovalViewer = { userId: "m", orgId: "o", isAdmin: false };
const mockClient = vi.mocked(createHttpMarketplaceMcpClient);

let savedEnv: Record<string, string | undefined>;
const ENV = ["MARKETPLACE_INSTANCE_TOKEN", "MARKETPLACE_ADMIN_TOKEN"] as const;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  h.adminToken = undefined;
  h.hasVendor = false;
  h.vendorToken = undefined;
  h.adminSubs = [];
  h.vendorRows = [];
  h.selfSubs = [];
  h.vendorStatus = { state: "none" };
  invalidateMarketplaceApprovalCounts();
  mockClient.mockClear();
});
afterEach(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function adminSub(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    submission_id: "s1",
    target_final_identity: "@acme/widget@1.0.0",
    vendor_id: 7,
    status: "pending",
    submitted_at: new Date().toISOString(),
    promotion_state: "none",
    ...over,
  };
}

describe("availability + appliesTo + sectionConfigured", () => {
  it("all four are `not_connected` with no credential, `ready` once any resolves", () => {
    const all = [
      marketplaceSubmissionModerationSource,
      marketplaceVendorAppModerationSource,
      marketplaceMySubmissionsSource,
      marketplaceVendorAppStatusSource,
    ];
    for (const s of all) expect(s.availability(admin)).toBe("not_connected");
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    for (const s of all) expect(s.availability(admin)).toBe("ready");
  });

  it("moderation sources are admin+inbox; self sources are admin+mine", () => {
    expect(marketplaceSubmissionModerationSource.appliesTo(admin, "inbox")).toBe(true);
    expect(marketplaceSubmissionModerationSource.appliesTo(admin, "mine")).toBe(false);
    expect(marketplaceSubmissionModerationSource.appliesTo(member, "inbox")).toBe(false);

    expect(marketplaceVendorAppModerationSource.appliesTo(admin, "inbox")).toBe(true);
    expect(marketplaceMySubmissionsSource.appliesTo(admin, "mine")).toBe(true);
    expect(marketplaceMySubmissionsSource.appliesTo(admin, "inbox")).toBe(false);
    expect(marketplaceVendorAppStatusSource.appliesTo(admin, "mine")).toBe(true);
    expect(marketplaceVendorAppStatusSource.appliesTo(member, "mine")).toBe(false);
  });

  it("sectionConfigured tracks each adapter's OWN credential", () => {
    // submission surfaces → instance token
    expect(marketplaceSubmissionModerationSource.sectionConfigured?.(admin, "inbox")).toBe(false);
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    expect(marketplaceSubmissionModerationSource.sectionConfigured?.(admin, "inbox")).toBe(true);
    expect(marketplaceMySubmissionsSource.sectionConfigured?.(admin, "mine")).toBe(true);
    // vendor-app moderation → admin token
    expect(marketplaceVendorAppModerationSource.sectionConfigured?.(admin, "inbox")).toBe(false);
    h.adminToken = "admin";
    expect(marketplaceVendorAppModerationSource.sectionConfigured?.(admin, "inbox")).toBe(true);
    // vendor-app status → vendor token
    expect(marketplaceVendorAppStatusSource.sectionConfigured?.(admin, "mine")).toBe(false);
    h.hasVendor = true;
    expect(marketplaceVendorAppStatusSource.sectionConfigured?.(admin, "mine")).toBe(true);
  });
});

describe("submission moderation fetch — 4 states + zero remote when doomed", () => {
  it("non-admin → ready+empty, no client constructed (no leak, no call)", async () => {
    const env = await marketplaceSubmissionModerationSource.fetchInbox(member);
    expect(env).toMatchObject({ availability: "ready", rows: [] });
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("NO marketplace credential → not_connected, ZERO remote calls", async () => {
    const env = await marketplaceSubmissionModerationSource.fetchInbox(admin);
    expect(env.availability).toBe("not_connected");
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("some marketplace credential but THIS section's absent → not_configured, no call", async () => {
    h.adminToken = "admin"; // marketplace is connected, but no INSTANCE token
    const env = await marketplaceSubmissionModerationSource.fetchInbox(admin);
    expect(env.availability).toBe("not_configured");
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("credential present → ready with mapped rows + eligibility passthrough", async () => {
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    h.adminSubs = [adminSub({ eligibility: { can_approve: false, reason: "SoD" } }), adminSub({ submission_id: "s2" })];
    const env = await marketplaceSubmissionModerationSource.fetchInbox(admin);
    expect(env.availability).toBe("ready");
    expect(env.rows.map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(env.rows[0].title).toBe("@acme/widget@1.0.0");
    expect(env.rows[0].eligibility).toEqual({ can_approve: false, reason: "SoD" });
    expect(env.rows[1].eligibility).toBeUndefined(); // graceful without the hint
    expect(env.actions.map((a) => a.id)).toEqual(["approve", "reject"]);
  });

  it("a remote failure PROPAGATES (SourceSection renders the inline error)", async () => {
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    mockClient.mockReturnValueOnce({
      extensionSubmissionListAdmin: vi.fn(async () => {
        throw new Error("marketplace 500");
      }),
    } as never);
    await expect(marketplaceSubmissionModerationSource.fetchInbox(admin)).rejects.toThrow("marketplace 500");
  });
});

describe("capped counts + zero-remote-when-disconnected", () => {
  it("submission moderation: disconnected → {0,0} with NO remote call", async () => {
    expect(await marketplaceSubmissionModerationSource.counts(admin)).toEqual({ inbox: 0, mine: 0 });
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("submission moderation: non-admin → {0,0} with NO remote call", async () => {
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    expect(await marketplaceSubmissionModerationSource.counts(member)).toEqual({ inbox: 0, mine: 0 });
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("submission moderation: connected → capped inbox count", async () => {
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    h.adminSubs = Array.from({ length: 25 }, (_, i) => adminSub({ submission_id: `s${i}` }));
    const c = await marketplaceSubmissionModerationSource.counts(admin);
    expect(c.inbox).toBe(9); // REMOTE_COUNT_CAP
    expect(c.mine).toBe(0);
  });
});

describe("vendor-application moderation (admin token, inbox)", () => {
  it("ready → maps rows; requires the admin token specifically", async () => {
    // instance token present but NOT admin token → this section is not_configured
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    expect((await marketplaceVendorAppModerationSource.fetchInbox(admin)).availability).toBe("not_configured");

    h.adminToken = "admin";
    h.vendorRows = [
      {
        application_id: "va1",
        display_name: "Acme Inc",
        scope: "@acme",
        status: "applied",
        applied_at: new Date().toISOString(),
        tier: "commercial",
        repair_stuck_at: null,
        recovery_attempts: 0,
      },
    ];
    const env = await marketplaceVendorAppModerationSource.fetchInbox(admin);
    expect(env.availability).toBe("ready");
    expect(env.rows[0]).toMatchObject({ id: "va1", title: "Acme Inc", subtitle: "@acme", status: "applied" });
  });
});

describe("my submissions (instance token, mine, withdraw) ", () => {
  it("counts only in-flight (pending) rows, capped", async () => {
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    h.selfSubs = [
      { submission_id: "a", target_final_identity: "@x/a@1", status: "pending", submitted_at: new Date().toISOString(), promotion_state: "none", promotion_error: null, decision_reason: null },
      { submission_id: "b", target_final_identity: "@x/b@1", status: "approved", submitted_at: new Date().toISOString(), promotion_state: "complete", promotion_error: null, decision_reason: null },
    ];
    const c = await marketplaceMySubmissionsSource.counts(admin);
    expect(c).toEqual({ inbox: 0, mine: 1 });
    const env = await marketplaceMySubmissionsSource.fetchMine(admin);
    expect(env.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(env.actions.map((a) => a.id)).toEqual(["withdraw"]);
  });
});

describe("vendor-application status (vendor token, mine, read-only)", () => {
  it("state=none → empty section; state=applied → one row + mine count 1", async () => {
    h.vendorToken = "vtok";
    h.hasVendor = true;
    h.vendorStatus = { state: "none" };
    expect((await marketplaceVendorAppStatusSource.fetchMine(admin)).rows).toHaveLength(0);
    expect((await marketplaceVendorAppStatusSource.counts(admin)).mine).toBe(0);

    invalidateMarketplaceApprovalCounts();
    h.vendorStatus = { state: "applied", scope: "@acme", tier: "commercial", application_id: "va9" };
    const env = await marketplaceVendorAppStatusSource.fetchMine(admin);
    expect(env.rows).toHaveLength(1);
    expect(env.rows[0]).toMatchObject({ id: "va9", title: "@acme", status: "applied" });
    expect((await marketplaceVendorAppStatusSource.counts(admin)).mine).toBe(1);
  });

  it("decide is a benign refusal (managed from Environment)", async () => {
    const r = await marketplaceVendorAppStatusSource.actions.decide(
      { rowId: "va9", action: "approve" },
      admin,
    );
    expect(r).toMatchObject({ ok: false, kind: "refused", code: "not_supported" });
  });
});
