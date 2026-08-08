/**
 * Proof for the non-redirecting marketplace decision helpers (#1044 contract,
 * #1046 structured errors):
 *  - admin gate + input validation (reason required on reject) as VALUE refusals;
 *  - a missing credential is a clean refusal, not a throw;
 *  - a 409 separation-of-duties error is classified as a readable business
 *    refusal (not a transient failure);
 *  - a successful approve enqueues the shared catalog reconcile AND invalidates
 *    the marketplace count cache;
 *  - withdraw + vendor-application approve/reject route to the right client call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketplaceMcpError } from "@cinatra-ai/marketplace-mcp-client";

const h = vi.hoisted(() => ({
  adminToken: undefined as string | undefined,
  approve: vi.fn(),
  reject: vi.fn(),
  withdraw: vi.fn(),
  vendorApprove: vi.fn(),
  vendorReject: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("@/lib/instance-identity-store", () => ({ readInstanceIdentity: vi.fn(() => null) }));
vi.mock("@/lib/marketplace-credentials", () => ({
  resolveMarketplaceAdminToken: vi.fn(() => {
    if (!h.adminToken) throw new Error("MARKETPLACE_ADMIN_TOKEN_MISSING");
    return h.adminToken;
  }),
  hasConsumerOrVendorMarketplaceToken: vi.fn(() => false),
  resolveConsumerOrVendorMarketplaceToken: vi.fn(() => {
    throw new Error("VENDOR_CREDENTIALS_MISSING");
  }),
}));
vi.mock("@/app/configuration/marketplace/submissions/catalog-sync-enqueue", () => ({
  enqueueCatalogSyncForApprovedSubmission: h.enqueue,
}));
vi.mock("@cinatra-ai/marketplace-mcp-client/http-client", () => ({
  createHttpMarketplaceMcpClient: vi.fn(() => ({
    extensionSubmissionApprove: h.approve,
    extensionSubmissionReject: h.reject,
    extensionSubmissionWithdraw: h.withdraw,
    vendorApplicationApprove: h.vendorApprove,
    vendorApplicationReject: h.vendorReject,
  })),
}));

import {
  decideMarketplaceSubmission,
  withdrawMarketplaceSubmission,
  decideMarketplaceVendorApplication,
} from "../marketplace-decision-helpers";
import { cachedMarketplaceCount, invalidateMarketplaceApprovalCounts } from "../sources/marketplace-shared";
import type { ApprovalViewer } from "../sources/types";

const admin: ApprovalViewer = { userId: "a", orgId: "o", isAdmin: true };
const member: ApprovalViewer = { userId: "m", orgId: "o", isAdmin: false };

beforeEach(() => {
  delete process.env.MARKETPLACE_INSTANCE_TOKEN;
  h.adminToken = undefined;
  h.approve.mockReset().mockResolvedValue({ target_final_identity: "@x/y@1", status: "approved", promotion_state: "complete" });
  h.reject.mockReset().mockResolvedValue({ submission_id: "s1", status: "rejected" });
  h.withdraw.mockReset().mockResolvedValue({ submission_id: "s1", status: "withdrawn" });
  h.vendorApprove.mockReset().mockResolvedValue({ state: "approved" });
  h.vendorReject.mockReset().mockResolvedValue({ state: "rejected" });
  h.enqueue.mockReset().mockResolvedValue(undefined);
  invalidateMarketplaceApprovalCounts();
});
afterEach(() => {
  delete process.env.MARKETPLACE_INSTANCE_TOKEN;
});

describe("decideMarketplaceSubmission", () => {
  it("refuses a non-admin as a VALUE (no throw, no client call)", async () => {
    const r = await decideMarketplaceSubmission({ rowId: "s1", action: "approve" }, member);
    expect(r).toMatchObject({ ok: false, kind: "forbidden", code: "not_admin" });
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("rejects an unknown action and a reason-less reject", async () => {
    h.adminToken = "admin";
    expect(await decideMarketplaceSubmission({ rowId: "s1", action: "frob" }, admin)).toMatchObject({
      ok: false,
      code: "unknown_action",
    });
    expect(await decideMarketplaceSubmission({ rowId: "s1", action: "reject" }, admin)).toMatchObject({
      ok: false,
      code: "reason_required",
    });
  });

  it("refuses cleanly when the admin token is not configured (#1224)", async () => {
    const r = await decideMarketplaceSubmission({ rowId: "s1", action: "approve" }, admin);
    expect(r).toMatchObject({ ok: false, code: "not_configured" });
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("does NOT fall back to the instance token — instance present, admin absent → fail closed (#1224)", async () => {
    // The consumer/instance token is present but the admin token is not; the
    // PRINCIPAL_ADMIN-bound approve must NEVER reuse the consumer credential
    // (confused-deputy) — it fails closed instead.
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    const r = await decideMarketplaceSubmission({ rowId: "s1", action: "approve" }, admin);
    expect(r).toMatchObject({ ok: false, code: "not_configured" });
    expect(h.approve).not.toHaveBeenCalled();
  });

  it("approve → ok, enqueues the shared catalog reconcile, invalidates counts", async () => {
    h.adminToken = "admin";
    // Prime the count cache so we can prove the decision clears it.
    const loader = vi.fn().mockResolvedValue(4);
    await cachedMarketplaceCount("marketplace-submission-moderation:inbox", loader);

    const r = await decideMarketplaceSubmission({ rowId: "s1", action: "approve" }, admin);
    expect(r).toEqual({ ok: true });
    expect(h.approve).toHaveBeenCalledWith({ submission_id: "s1" });
    expect(h.enqueue).toHaveBeenCalledTimes(1);

    // Cache was invalidated → the loader runs again on the next read.
    await cachedMarketplaceCount("marketplace-submission-moderation:inbox", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("classifies a 409 separation-of-duties error as a readable business refusal", async () => {
    h.adminToken = "admin";
    h.approve.mockRejectedValueOnce(
      new MarketplaceMcpError("approver_separation_violation", 409, JSON.stringify({ code: "approver_separation_violation" })),
    );
    const r = await decideMarketplaceSubmission({ rowId: "s1", action: "approve" }, admin);
    expect(r).toMatchObject({ ok: false, kind: "refused", httpStatus: 409 });
    expect(r.ok === false && r.message.toLowerCase()).toContain("someone else must review");
    expect(h.enqueue).not.toHaveBeenCalled(); // no reconcile on a refused approve
  });

  it("invalidates the count cache even on a refusal (a 404/409 means remote state changed)", async () => {
    h.adminToken = "admin";
    const loader = vi.fn().mockResolvedValue(2);
    await cachedMarketplaceCount("marketplace-submission-moderation:inbox", loader);
    h.approve.mockRejectedValueOnce(new MarketplaceMcpError("gone", 404, ""));

    const r = await decideMarketplaceSubmission({ rowId: "s1", action: "approve" }, admin);
    expect(r.ok).toBe(false); // refused, but the attempt reached the marketplace

    await cachedMarketplaceCount("marketplace-submission-moderation:inbox", loader);
    expect(loader).toHaveBeenCalledTimes(2); // cache was cleared by the finally
  });

  it("reject with a reason → ok, calls reject with the reason", async () => {
    h.adminToken = "admin";
    const r = await decideMarketplaceSubmission({ rowId: "s1", action: "reject", reason: "bad tarball" }, admin);
    expect(r).toEqual({ ok: true });
    expect(h.reject).toHaveBeenCalledWith({ submission_id: "s1", reason: "bad tarball" });
  });
});

describe("withdrawMarketplaceSubmission", () => {
  it("withdraws the instance's own pending submission", async () => {
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    const r = await withdrawMarketplaceSubmission({ rowId: "s1", action: "withdraw" }, admin);
    expect(r).toEqual({ ok: true });
    expect(h.withdraw).toHaveBeenCalledWith({ submission_id: "s1" });
  });
  it("rejects a non-withdraw action", async () => {
    process.env.MARKETPLACE_INSTANCE_TOKEN = "tok";
    expect(await withdrawMarketplaceSubmission({ rowId: "s1", action: "approve" }, admin)).toMatchObject({
      ok: false,
      code: "unknown_action",
    });
  });
});

describe("decideMarketplaceVendorApplication", () => {
  it("refuses cleanly when the admin token is not configured", async () => {
    const r = await decideMarketplaceVendorApplication({ rowId: "va1", action: "approve" }, admin);
    expect(r).toMatchObject({ ok: false, code: "not_configured" });
    expect(h.vendorApprove).not.toHaveBeenCalled();
  });

  it("approve/reject route to the admin client calls with the admin token", async () => {
    h.adminToken = "admin-tok";
    expect(await decideMarketplaceVendorApplication({ rowId: "va1", action: "approve" }, admin)).toEqual({ ok: true });
    expect(h.vendorApprove).toHaveBeenCalledWith({ application_id: "va1" });

    expect(
      await decideMarketplaceVendorApplication({ rowId: "va1", action: "reject", reason: "no" }, admin),
    ).toEqual({ ok: true });
    expect(h.vendorReject).toHaveBeenCalledWith({ application_id: "va1", decision_reason: "no" });
  });

  it("propagates a 409 SoD as a readable refusal", async () => {
    h.adminToken = "admin-tok";
    h.vendorApprove.mockRejectedValueOnce(new MarketplaceMcpError("separation", 409, ""));
    const r = await decideMarketplaceVendorApplication({ rowId: "va1", action: "approve" }, admin);
    expect(r).toMatchObject({ ok: false, kind: "refused", httpStatus: 409 });
  });
});
