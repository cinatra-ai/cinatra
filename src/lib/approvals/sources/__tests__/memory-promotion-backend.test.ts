// cinatra#1381 — the memory PromotionBackend adapter: the cheap review/request
// gates, the subject-native -> seam row mapping (human scope labels, the CAS
// version token, the ADVISORY duplicate subtitle), the direction-scoped
// list/count wiring, and decide forwarding. The data layer is mocked — its own
// ladder is proven in memory-row-promotion.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const listMemoryPromotionInbox = vi.fn();
const listMemoryPromotionMine = vi.fn();
const countMemoryPromotionInbox = vi.fn(async () => 0);
const countMemoryPromotionMine = vi.fn(async () => 0);
const decideMemoryPromotion = vi.fn();

vi.mock("@/lib/objects/memory-row-promotion", () => ({
  listMemoryPromotionInbox: (...a: unknown[]) => listMemoryPromotionInbox(...(a as [])),
  listMemoryPromotionMine: (...a: unknown[]) => listMemoryPromotionMine(...(a as [])),
  countMemoryPromotionInbox: (...a: unknown[]) => countMemoryPromotionInbox(...(a as [])),
  countMemoryPromotionMine: (...a: unknown[]) => countMemoryPromotionMine(...(a as [])),
  decideMemoryPromotion: (...a: unknown[]) => decideMemoryPromotion(...(a as [])),
}));

import { memoryPromotionBackend } from "../memory-promotion";
import type { ApprovalViewer } from "../types";

const admin: ApprovalViewer = { userId: "u-admin", orgId: "org-1", isAdmin: true };
const member: ApprovalViewer = { userId: "u-member", orgId: "org-1", isAdmin: false };

function reviewRow(over: Record<string, unknown> = {}) {
  return {
    requestId: "req-1",
    objectId: "mem-1",
    title: "Deployment runbook",
    status: "pending",
    createdAt: "2026-08-20T00:00:00.000Z",
    version: "3",
    fromScope: "private",
    toScope: "organization",
    toOwnerLabel: null,
    toOwnerId: "org-1",
    requestedBy: "u-member",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cheap gates", () => {
  it("canReview is admin-only; canRequest is any member", () => {
    expect(memoryPromotionBackend.canReview(admin)).toBe(true);
    expect(memoryPromotionBackend.canReview(member)).toBe(false);
    expect(memoryPromotionBackend.canRequest(admin)).toBe(true);
    expect(memoryPromotionBackend.canRequest(member)).toBe(true);
  });
});

describe("listInbox / listMine mapping", () => {
  it("maps to a seam row: subjectId = requestId, the CAS token, human scope labels", async () => {
    listMemoryPromotionInbox.mockResolvedValueOnce([reviewRow()]);
    const rows = await memoryPromotionBackend.listInbox(admin);
    expect(listMemoryPromotionInbox).toHaveBeenCalledWith({ orgId: "org-1", reviewerId: "u-admin" });
    expect(rows).toEqual([
      {
        subjectId: "req-1",
        title: "Deployment runbook",
        status: "pending",
        createdAt: "2026-08-20T00:00:00.000Z",
        version: "3",
        detail: { fromScope: "Private", toScope: "Organization", requestedBy: "u-member" },
      },
    ]);
  });

  it("shows a TEAM destination as the name snapshot AND the immutable team id", async () => {
    listMemoryPromotionInbox.mockResolvedValueOnce([
      reviewRow({ toScope: "team", toOwnerLabel: "Growth", toOwnerId: "team-9" }),
    ]);
    const rows = await memoryPromotionBackend.listInbox(admin);
    expect(rows[0].detail?.toScope).toBe("Team: Growth [team-9]");
  });

  it("names an unnamed team target rather than hiding the destination", async () => {
    listMemoryPromotionInbox.mockResolvedValueOnce([
      reviewRow({ toScope: "team", toOwnerLabel: null, toOwnerId: "team-9" }),
    ]);
    expect((await memoryPromotionBackend.listInbox(admin))[0].detail?.toScope).toBe("Team: (unnamed) [team-9]");
  });

  it("carries the ADVISORY duplicate hint as the subtitle, and only in the inbox", async () => {
    listMemoryPromotionInbox.mockResolvedValueOnce([
      reviewRow({ duplicateHint: "Advisory: 2 concepts with the same identity are already visible to the target audience." }),
    ]);
    const inbox = await memoryPromotionBackend.listInbox(admin);
    expect(inbox[0].subtitle).toBe(
      "Advisory: 2 concepts with the same identity are already visible to the target audience.",
    );

    listMemoryPromotionMine.mockResolvedValueOnce([reviewRow()]);
    const mine = await memoryPromotionBackend.listMine(member);
    expect(mine[0]).not.toHaveProperty("subtitle");
  });

  it("omits the subtitle entirely when there is no hint — never an empty line", async () => {
    listMemoryPromotionInbox.mockResolvedValueOnce([reviewRow({ duplicateHint: null })]);
    expect((await memoryPromotionBackend.listInbox(admin))[0]).not.toHaveProperty("subtitle");
  });

  it("AC4 — the approver-facing payload carries no cross-user content or identity beyond the requester", async () => {
    listMemoryPromotionInbox.mockResolvedValueOnce([
      reviewRow({ duplicateHint: "Advisory: 3 concepts with the same identity are already visible to the target audience." }),
    ]);
    const row = (await memoryPromotionBackend.listInbox(admin))[0];
    const serialized = JSON.stringify(row);
    // The subject's own title and requester are the point of a review row. What
    // must NOT be there is anything about the rows the hint counted.
    for (const leak of ["conceptId", "bodyMarkdown", "frontmatter", "ownerId", "duplicateIds", "mem-"]) {
      expect(serialized).not.toContain(leak);
    }
    expect(Object.keys(row).sort()).toEqual(["createdAt", "detail", "status", "subjectId", "subtitle", "title", "version"]);
  });

  it("listMine forwards the history status filter and omits it when unset", async () => {
    listMemoryPromotionMine.mockResolvedValueOnce([reviewRow({ status: "approved" })]);
    await memoryPromotionBackend.listMine(member, { status: "approved" });
    expect(listMemoryPromotionMine).toHaveBeenCalledWith({
      orgId: "org-1",
      requesterId: "u-member",
      status: "approved",
    });
    listMemoryPromotionMine.mockResolvedValueOnce([]);
    await memoryPromotionBackend.listMine(member);
    expect(listMemoryPromotionMine).toHaveBeenLastCalledWith({ orgId: "org-1", requesterId: "u-member" });
  });
});

describe("counts", () => {
  it("forward the viewer axes", async () => {
    countMemoryPromotionInbox.mockResolvedValueOnce(2);
    countMemoryPromotionMine.mockResolvedValueOnce(1);
    expect(await memoryPromotionBackend.countInbox(admin)).toBe(2);
    expect(await memoryPromotionBackend.countMine(member)).toBe(1);
    expect(countMemoryPromotionInbox).toHaveBeenCalledWith({ orgId: "org-1", reviewerId: "u-admin" });
    expect(countMemoryPromotionMine).toHaveBeenCalledWith({ orgId: "org-1", requesterId: "u-member" });
  });
});

describe("decide forwarding", () => {
  it("routes subjectId -> requestId and forwards reason + expectedVersion + viewer", async () => {
    decideMemoryPromotion.mockResolvedValueOnce({ ok: true });
    const res = await memoryPromotionBackend.decide({
      subjectId: "req-9",
      action: "approve",
      expectedVersion: "7",
      viewer: admin,
    });
    expect(res).toEqual({ ok: true });
    expect(decideMemoryPromotion).toHaveBeenCalledWith({
      requestId: "req-9",
      action: "approve",
      expectedVersion: "7",
      viewer: admin,
    });
  });

  it("forwards a reject reason, and passes refusal codes through 1:1", async () => {
    decideMemoryPromotion.mockResolvedValueOnce({ ok: false, code: "secret_scan", message: "nope" });
    const res = await memoryPromotionBackend.decide({
      subjectId: "req-9",
      action: "reject",
      reason: "leaks a key",
      viewer: admin,
    });
    expect(res).toEqual({ ok: false, code: "secret_scan", message: "nope" });
    expect(decideMemoryPromotion).toHaveBeenCalledWith({
      requestId: "req-9",
      action: "reject",
      reason: "leaks a key",
      viewer: admin,
    });
  });

  it("omits an absent expectedVersion rather than sending an empty string", async () => {
    decideMemoryPromotion.mockResolvedValueOnce({ ok: false, code: "version_required", message: "x" });
    await memoryPromotionBackend.decide({ subjectId: "req-9", action: "approve", viewer: admin });
    expect(decideMemoryPromotion).toHaveBeenCalledWith({
      requestId: "req-9",
      action: "approve",
      viewer: admin,
    });
  });
});
