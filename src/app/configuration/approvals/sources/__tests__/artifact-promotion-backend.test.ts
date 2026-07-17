// cinatra#1437 — the artifact PromotionBackend adapter: the cheap review/request
// gates, the subject-native → seam row mapping (human scope labels, the CAS
// version token), the direction-scoped list/count wiring, and the decide
// forwarding (subjectId → requestId; outcome mapped 1:1). The data layer is
// mocked (its own ladder is proven in artifact-row-promotion.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";

const listArtifactPromotionInbox = vi.fn();
const listArtifactPromotionMine = vi.fn();
const countArtifactPromotionInbox = vi.fn(async () => 0);
const countArtifactPromotionMine = vi.fn(async () => 0);
const decideArtifactPromotion = vi.fn();

vi.mock("@/lib/objects/artifact-row-promotion", () => ({
  listArtifactPromotionInbox: (...a: unknown[]) => listArtifactPromotionInbox(...(a as [])),
  listArtifactPromotionMine: (...a: unknown[]) => listArtifactPromotionMine(...(a as [])),
  countArtifactPromotionInbox: (...a: unknown[]) => countArtifactPromotionInbox(...(a as [])),
  countArtifactPromotionMine: (...a: unknown[]) => countArtifactPromotionMine(...(a as [])),
  decideArtifactPromotion: (...a: unknown[]) => decideArtifactPromotion(...(a as [])),
}));

import { artifactPromotionBackend } from "../artifact-promotion";
import type { ApprovalViewer } from "../types";

const admin: ApprovalViewer = { userId: "u-admin", orgId: "org-1", isAdmin: true };
const member: ApprovalViewer = { userId: "u-member", orgId: "org-1", isAdmin: false };

function reviewRow(over: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    objectId: "obj-1",
    title: "Quarterly insight",
    status: "pending",
    createdAt: "2026-07-15T00:00:00.000Z",
    version: "3",
    fromScope: "private",
    toScope: "organization",
    requestedBy: "u-member",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cheap gates", () => {
  it("canReview is admin-only; canRequest is any member", () => {
    expect(artifactPromotionBackend.canReview(admin)).toBe(true);
    expect(artifactPromotionBackend.canReview(member)).toBe(false);
    expect(artifactPromotionBackend.canRequest(admin)).toBe(true);
    expect(artifactPromotionBackend.canRequest(member)).toBe(true);
  });
});

describe("listInbox / listMine mapping", () => {
  it("maps a review row to a seam row: subjectId=requestId, CAS version, human scope labels", async () => {
    listArtifactPromotionInbox.mockResolvedValueOnce([reviewRow()]);
    const rows = await artifactPromotionBackend.listInbox(admin);
    expect(listArtifactPromotionInbox).toHaveBeenCalledWith({ orgId: "org-1", reviewerId: "u-admin" });
    expect(rows).toEqual([
      {
        subjectId: "req-1",
        title: "Quarterly insight",
        status: "pending",
        createdAt: "2026-07-15T00:00:00.000Z",
        version: "3",
        detail: { fromScope: "Private", toScope: "Organization", requestedBy: "u-member" },
      },
    ]);
  });

  it("listMine forwards the history status filter", async () => {
    listArtifactPromotionMine.mockResolvedValueOnce([reviewRow({ status: "approved" })]);
    const rows = await artifactPromotionBackend.listMine(member, { status: "approved" });
    expect(listArtifactPromotionMine).toHaveBeenCalledWith({
      orgId: "org-1",
      requesterId: "u-member",
      status: "approved",
    });
    expect(rows[0]).toMatchObject({ subjectId: "req-1", status: "approved" });
  });

  it("listMine omits the status filter when unset", async () => {
    listArtifactPromotionMine.mockResolvedValueOnce([]);
    await artifactPromotionBackend.listMine(member);
    expect(listArtifactPromotionMine).toHaveBeenCalledWith({ orgId: "org-1", requesterId: "u-member" });
  });
});

describe("counts", () => {
  it("countInbox / countMine forward the viewer axes", async () => {
    countArtifactPromotionInbox.mockResolvedValueOnce(2);
    countArtifactPromotionMine.mockResolvedValueOnce(1);
    expect(await artifactPromotionBackend.countInbox(admin)).toBe(2);
    expect(await artifactPromotionBackend.countMine(member)).toBe(1);
    expect(countArtifactPromotionInbox).toHaveBeenCalledWith({ orgId: "org-1", reviewerId: "u-admin" });
    expect(countArtifactPromotionMine).toHaveBeenCalledWith({ orgId: "org-1", requesterId: "u-member" });
  });
});

describe("decide forwarding", () => {
  it("routes subjectId → requestId and forwards reason + expectedVersion + viewer", async () => {
    decideArtifactPromotion.mockResolvedValueOnce({ ok: true });
    const res = await artifactPromotionBackend.decide({
      subjectId: "req-9",
      action: "approve",
      expectedVersion: "7",
      viewer: admin,
    });
    expect(res).toEqual({ ok: true });
    expect(decideArtifactPromotion).toHaveBeenCalledWith({
      requestId: "req-9",
      action: "approve",
      expectedVersion: "7",
      viewer: admin,
    });
  });

  it("forwards a reject reason", async () => {
    decideArtifactPromotion.mockResolvedValueOnce({ ok: true });
    await artifactPromotionBackend.decide({
      subjectId: "req-1",
      action: "reject",
      reason: "draft content",
      viewer: admin,
    });
    expect(decideArtifactPromotion).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req-1", action: "reject", reason: "draft content" }),
    );
  });

  it("passes a refusal outcome straight through (codes are 1:1 with the seam)", async () => {
    decideArtifactPromotion.mockResolvedValueOnce({ ok: false, code: "secret_scan", message: "nope" });
    const res = await artifactPromotionBackend.decide({
      subjectId: "req-1",
      action: "approve",
      expectedVersion: "3",
      viewer: admin,
    });
    expect(res).toEqual({ ok: false, code: "secret_scan", message: "nope" });
  });
});
