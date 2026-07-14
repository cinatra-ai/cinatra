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
  // Settable instance-identity row driving the #1551 strict-registration gate.
  identity: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: vi.fn(() => h.identity) }));
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
import type { ApprovalRow, ApprovalViewer } from "../types";

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
  h.identity = null;
  invalidateMarketplaceApprovalCounts();
  mockClient.mockClear();
});

// A genuinely registered-vendor identity row (owner ruling: only this state
// renders vendor-app rows). A consumer-only row resolves a vendor token but is
// NOT a registered vendor — the #1551 gate must distinguish the two.
const VENDOR_IDENTITY: Record<string, unknown> = { instanceNamespace: "acme", vendorState: "approved" };
const CONSUMER_IDENTITY: Record<string, unknown> = {
  instanceNamespace: "acme",
  consumerAttachment: { marketplaceTokenCiphertext: "cipher" },
};

function vendorAppRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    application_id: "va1",
    display_name: "Acme Inc",
    scope: "@acme",
    status: "applied",
    applied_at: new Date().toISOString(),
    tier: "commercial",
    repair_stuck_at: null,
    recovery_attempts: 0,
    ...over,
  };
}
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

  it("sectionConfigured tracks each adapter's OWN credential; vendor-app sources ALSO require registration (#1551)", () => {
    // extension-submission MODERATION → admin token (#1224). NOT registration-
    // gated — only its vendor-identifying copy is swept, never its section gate.
    expect(marketplaceSubmissionModerationSource.sectionConfigured?.(admin, "inbox")).toBe(false);
    h.adminToken = "admin";
    expect(marketplaceSubmissionModerationSource.sectionConfigured?.(admin, "inbox")).toBe(true);
    // my submissions (self) → instance token
    expect(marketplaceMySubmissionsSource.sectionConfigured?.(admin, "mine")).toBe(false);
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    expect(marketplaceMySubmissionsSource.sectionConfigured?.(admin, "mine")).toBe(true);
    // vendor-app moderation → admin token ALONE is NO LONGER sufficient (#1551):
    // the instance must ALSO be a registered vendor. (This assertion flipped.)
    expect(marketplaceVendorAppModerationSource.sectionConfigured?.(admin, "inbox")).toBe(false);
    h.identity = VENDOR_IDENTITY;
    expect(marketplaceVendorAppModerationSource.sectionConfigured?.(admin, "inbox")).toBe(true);
    // vendor-app status → a consumer token that is NOT a registered vendor is
    // insufficient; BOTH the vendor token AND registration must hold.
    h.hasVendor = true;
    h.identity = CONSUMER_IDENTITY;
    expect(marketplaceVendorAppStatusSource.sectionConfigured?.(admin, "mine")).toBe(false);
    h.identity = VENDOR_IDENTITY;
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
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok"; // marketplace connected, but no ADMIN token (#1224)
    const env = await marketplaceSubmissionModerationSource.fetchInbox(admin);
    expect(env.availability).toBe("not_configured");
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("credential present → ready with mapped rows + eligibility passthrough", async () => {
    h.adminToken = "admin";
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
    h.adminToken = "admin";
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
    h.adminToken = "admin";
    expect(await marketplaceSubmissionModerationSource.counts(member)).toEqual({ inbox: 0, mine: 0 });
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("submission moderation: connected → capped inbox count", async () => {
    h.adminToken = "admin";
    h.adminSubs = Array.from({ length: 25 }, (_, i) => adminSub({ submission_id: `s${i}` }));
    const c = await marketplaceSubmissionModerationSource.counts(admin);
    expect(c.inbox).toBe(9); // REMOTE_COUNT_CAP
    expect(c.mine).toBe(0);
  });
});

describe("vendor-application moderation (admin token, inbox)", () => {
  it("ready → maps rows; requires the admin token AND vendor registration (#1551)", async () => {
    h.identity = VENDOR_IDENTITY;
    // instance token present but NOT admin token → this section is not_configured
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    expect((await marketplaceVendorAppModerationSource.fetchInbox(admin)).availability).toBe("not_configured");

    h.adminToken = "admin";
    // admin token present but NOT a registered vendor → STILL not_configured (the
    // #1551 row-production gate short-circuits before the remote call).
    h.identity = null;
    expect((await marketplaceVendorAppModerationSource.fetchInbox(admin)).availability).toBe("not_configured");
    expect(mockClient).not.toHaveBeenCalled();

    h.identity = VENDOR_IDENTITY;
    h.vendorRows = [vendorAppRow()];
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
    h.identity = VENDOR_IDENTITY; // registered — otherwise the #1551 gate hides it
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

describe("strict vendor-registration gate (#1551) — 4-state matrix; only a registered vendor renders vendor-app rows", () => {
  it("state 1 — no credential: both vendor-app sources hidden, {0,0} counts, zero rows, no remote call", async () => {
    for (const s of [marketplaceVendorAppModerationSource, marketplaceVendorAppStatusSource]) {
      const dir = s === marketplaceVendorAppModerationSource ? "inbox" : "mine";
      expect(s.sectionConfigured?.(admin, dir as never)).toBe(false);
    }
    expect(await marketplaceVendorAppModerationSource.counts(admin)).toEqual({ inbox: 0, mine: 0 });
    expect(await marketplaceVendorAppStatusSource.counts(admin)).toEqual({ inbox: 0, mine: 0 });
    expect((await marketplaceVendorAppModerationSource.fetchInbox(admin)).rows).toHaveLength(0);
    expect((await marketplaceVendorAppStatusSource.fetchMine(admin)).rows).toHaveLength(0);
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("state 2 — consumer-only (vendor token resolves, NOT registered): status source hidden, 0 count, zero rows, gated BEFORE the remote call", async () => {
    h.hasVendor = true;
    h.vendorToken = "vtok";
    h.identity = CONSUMER_IDENTITY;
    // Even a live 'applied' status is never fetched — the gate short-circuits.
    h.vendorStatus = { state: "applied", scope: "@acme", tier: "commercial", application_id: "va9" };
    expect(marketplaceVendorAppStatusSource.sectionConfigured?.(admin, "mine")).toBe(false);
    expect((await marketplaceVendorAppStatusSource.counts(admin)).mine).toBe(0);
    const env = await marketplaceVendorAppStatusSource.fetchMine(admin);
    expect(env.availability).toBe("not_configured");
    expect(env.rows).toHaveLength(0);
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("state 3 — admin-token-only (no vendor attachment): moderation source hidden, 0 count, zero rows, gated BEFORE the remote call", async () => {
    h.adminToken = "admin";
    h.identity = null; // admin/moderator token, but this instance is not a vendor
    h.vendorRows = [vendorAppRow()];
    expect(marketplaceVendorAppModerationSource.sectionConfigured?.(admin, "inbox")).toBe(false);
    expect((await marketplaceVendorAppModerationSource.counts(admin)).inbox).toBe(0);
    const env = await marketplaceVendorAppModerationSource.fetchInbox(admin);
    expect(env.availability).toBe("not_configured");
    expect(env.rows).toHaveLength(0);
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("state 3 (leak-shape regression) — admin token + an identity carrying ONLY a top-level tokenCiphertext (a bare registry publish token, vendorState never recorded) still discloses NOTHING", async () => {
    // This is the exact shape that a non-marketplace-vendor instance holds after
    // ANY setup mode when its vendorState was never reconciled (e.g.
    // MARKETPLACE_INSTANCE_TOKEN set → boot reconcile skipped). It must NOT be
    // treated as a registered vendor: gate short-circuits before the admin client.
    h.adminToken = "admin";
    h.identity = { instanceNamespace: "acme", tokenCiphertext: "registry-cipher" };
    h.vendorRows = [vendorAppRow()];
    expect(marketplaceVendorAppModerationSource.sectionConfigured?.(admin, "inbox")).toBe(false);
    expect((await marketplaceVendorAppModerationSource.counts(admin)).inbox).toBe(0);
    const env = await marketplaceVendorAppModerationSource.fetchInbox(admin);
    expect(env.availability).toBe("not_configured");
    expect(env.rows).toHaveLength(0);
    expect(mockClient).not.toHaveBeenCalled();
  });

  it("state 4 — vendor-registered: BOTH sources render rows + non-zero counts (unchanged happy path)", async () => {
    h.adminToken = "admin";
    h.hasVendor = true;
    h.vendorToken = "vtok";
    h.identity = VENDOR_IDENTITY;
    h.vendorRows = [vendorAppRow()];
    h.vendorStatus = { state: "applied", scope: "@acme", tier: "commercial", application_id: "va9" };

    expect(marketplaceVendorAppModerationSource.sectionConfigured?.(admin, "inbox")).toBe(true);
    expect(marketplaceVendorAppStatusSource.sectionConfigured?.(admin, "mine")).toBe(true);

    const modEnv = await marketplaceVendorAppModerationSource.fetchInbox(admin);
    expect(modEnv.availability).toBe("ready");
    expect(modEnv.rows).toHaveLength(1);
    expect((await marketplaceVendorAppModerationSource.counts(admin)).inbox).toBe(1);

    const statEnv = await marketplaceVendorAppStatusSource.fetchMine(admin);
    expect(statEnv.availability).toBe("ready");
    expect(statEnv.rows).toHaveLength(1);
    expect((await marketplaceVendorAppStatusSource.counts(admin)).mine).toBe(1);
  });
});

describe("submission-moderation vendor-copy sweep (#1551 AC10)", () => {
  const metaOf = (row: ApprovalRow): string => {
    const el = marketplaceSubmissionModerationSource.rowRenderer(row, { direction: "inbox" }) as unknown as {
      props: { meta: string };
    };
    return el.props.meta;
  };

  it("redacts the `vendor #N` subtitle/meta unless the instance is a registered vendor; the row itself still renders", async () => {
    h.adminToken = "admin";
    h.adminSubs = [adminSub({ vendor_id: 7 })];

    // NOT registered → row produced, but the vendor-identifying subtitle (which
    // flows to the approvals_* MCP tools via toPublicRow) is dropped, and the
    // rendered meta carries no `vendor #` prefix.
    h.identity = null;
    const hidden = await marketplaceSubmissionModerationSource.fetchInbox(admin);
    expect(hidden.rows).toHaveLength(1);
    expect(hidden.rows[0].subtitle).toBeUndefined();
    expect(metaOf(hidden.rows[0])).not.toContain("vendor #");
    expect(metaOf(hidden.rows[0])).toContain("submitted");

    // Registered → the vendor copy is present again.
    h.identity = VENDOR_IDENTITY;
    const shown = await marketplaceSubmissionModerationSource.fetchInbox(admin);
    expect(shown.rows[0].subtitle).toBe("vendor #7");
    expect(metaOf(shown.rows[0])).toContain("vendor #7");
  });
});
