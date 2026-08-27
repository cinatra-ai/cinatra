// cinatra#1381 — the PRODUCTION apply wiring: what `decideMemoryPromotion`
// actually does when nobody injects deps.
//
// The DI suite (memory-row-promotion.test.ts) proves the ladder; the co-commit
// suite (object-history/__tests__/co-commit-statements.test.ts) proves the seam.
// This is the join: that the real apply hands the request's CAS claim to the
// canonical writer AS a co-commit statement, mints membership-grounded org-write
// authority for the decider, pins the widen to the captured version, and writes
// the target tuple — in ONE call, with the approver's project frame neutralized
// so an approval can never move the row into the approver's project room.
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  historyAwareUpsert: vi.fn(),
  verifySessionAuthority: vi.fn(async () => ({ orgId: "org-1", can: () => true })),
  getStore: vi.fn<() => unknown>(() => undefined),
  run: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
  // store
  readMemoryPromotionRequestById: vi.fn(),
  buildMemoryPromotionApproveClaim: vi.fn(() => ({ text: "CLAIM SQL", values: ["req-1"] })),
  buildMemoryPromotionTeamContainmentAssert: vi.fn(() => ({ text: "TEAM ASSERT SQL", values: ["team-9", "org-1"] })),
  markMemoryPromotionRequestSuperseded: vi.fn(() => true),
  casRejectMemoryPromotionRequest: vi.fn(() => true),
  listMemoryPromotionRequests: vi.fn(() => []),
  countMemoryPromotionRequests: vi.fn(() => 0),
  createMemoryPromotionRequest: vi.fn(),
  readTeamInOrgSync: vi.fn(() => ({ id: "team-9", name: "Growth" })),
  countAudienceVisibleMemoryDuplicates: vi.fn(() => 0),
  getObjectById: vi.fn(),
}));

vi.mock("@/lib/objects/memory-promotion-request-store", () => ({
  readMemoryPromotionRequestById: mocks.readMemoryPromotionRequestById,
  buildMemoryPromotionApproveClaim: mocks.buildMemoryPromotionApproveClaim,
  buildMemoryPromotionTeamContainmentAssert: mocks.buildMemoryPromotionTeamContainmentAssert,
  markMemoryPromotionRequestSuperseded: mocks.markMemoryPromotionRequestSuperseded,
  casRejectMemoryPromotionRequest: mocks.casRejectMemoryPromotionRequest,
  listMemoryPromotionRequests: mocks.listMemoryPromotionRequests,
  countMemoryPromotionRequests: mocks.countMemoryPromotionRequests,
  createMemoryPromotionRequest: mocks.createMemoryPromotionRequest,
  readTeamInOrgSync: mocks.readTeamInOrgSync,
  countAudienceVisibleMemoryDuplicates: mocks.countAudienceVisibleMemoryDuplicates,
}));
vi.mock("@/lib/objects-store", () => ({ getObjectById: mocks.getObjectById }));
vi.mock("@/lib/object-history/canonical-writer", () => ({
  historyAwareUpsert: mocks.historyAwareUpsert,
}));
vi.mock("@/lib/mcp-request-context", () => ({
  mcpRequestContextStorage: { getStore: mocks.getStore, run: mocks.run },
}));

import { VersionConflictError } from "@/lib/object-history/errors";
import { OrgWriteAuthorityError } from "@/lib/org-write/authority";

vi.mock("@/lib/org-write/authority", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, verifySessionAuthority: mocks.verifySessionAuthority };
});

import { decideMemoryPromotion, MEMORY_CONCEPT_TYPE_ID } from "../memory-row-promotion";
import type { ApprovalViewer } from "@/lib/approvals/sources/types";

const admin: ApprovalViewer = { userId: "u-admin", orgId: "org-1", isAdmin: true };

const REQUEST = {
  id: "req-1",
  orgId: "org-1",
  objectId: "mem-1",
  objectTitle: "Deployment runbook",
  requestedBy: "u-member",
  fromOwnerLevel: "user",
  fromOwnerId: "u-member",
  fromVisibility: "private",
  toVisibility: "organization" as const,
  toOwnerLevel: "organization",
  toOwnerId: "org-1",
  toOwnerLabel: null,
  rowVersion: 3,
  status: "pending" as const,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const ROW = {
  id: "mem-1",
  type: MEMORY_CONCEPT_TYPE_ID,
  data: { conceptId: "runbooks/deployment", okfType: "procedure", frontmatter: { type: "procedure" }, bodyMarkdown: "clean" },
  version: 3,
  visibility: "private",
  ownerLevel: "user",
  ownerId: "u-member",
  orgId: "org-1",
  projectId: "proj-owned-by-the-row",
};

async function approve() {
  return decideMemoryPromotion({
    requestId: "req-1",
    action: "approve",
    expectedVersion: "3",
    reason: "useful",
    viewer: admin,
  });
}

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === "function" && "mockClear" in m) m.mockClear();
  mocks.readMemoryPromotionRequestById.mockReturnValue(REQUEST);
  mocks.getObjectById.mockReturnValue(ROW);
  mocks.buildMemoryPromotionApproveClaim.mockReturnValue({ text: "CLAIM SQL", values: ["req-1"] });
  mocks.buildMemoryPromotionTeamContainmentAssert.mockReturnValue({ text: "TEAM ASSERT SQL", values: ["team-9", "org-1"] });
  mocks.verifySessionAuthority.mockResolvedValue({ orgId: "org-1", can: () => true });
  mocks.historyAwareUpsert.mockReturnValue({ objectId: "mem-1", resultVersion: 4 });
  mocks.getStore.mockReturnValue(undefined);
  mocks.run.mockImplementation((_ctx: unknown, fn: () => unknown) => fn());
});

describe("the production atomic apply", () => {
  it("co-commits the request claim WITH the widen, in ONE writer call", async () => {
    await expect(approve()).resolves.toEqual({ ok: true });
    expect(mocks.buildMemoryPromotionApproveClaim).toHaveBeenCalledWith({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "u-admin",
      note: "useful",
      expectedRowVersion: 3,
    });
    expect(mocks.historyAwareUpsert).toHaveBeenCalledTimes(1);
    const [, options] = mocks.historyAwareUpsert.mock.calls[0];
    expect(options.coCommitStatements).toEqual([{ text: "CLAIM SQL", values: ["req-1"] }]);
  });

  it("an ORGANIZATION target co-commits the claim ALONE — there is no team to contain", async () => {
    await approve();
    const [, options] = mocks.historyAwareUpsert.mock.calls[0];
    expect(options.coCommitStatements).toEqual([{ text: "CLAIM SQL", values: ["req-1"] }]);
    expect(mocks.buildMemoryPromotionTeamContainmentAssert).not.toHaveBeenCalled();
  });

  it("a TEAM target co-commits the CONTAINMENT ASSERT too, ahead of the claim (codex round 1, finding 1)", async () => {
    const teamRequest = {
      ...REQUEST,
      toVisibility: "team" as const,
      toOwnerLevel: "team",
      toOwnerId: "team-9",
      toOwnerLabel: "Growth",
    };
    mocks.readMemoryPromotionRequestById.mockReturnValue(teamRequest);
    await expect(approve()).resolves.toEqual({ ok: true });
    expect(mocks.buildMemoryPromotionTeamContainmentAssert).toHaveBeenCalledWith({
      teamId: "team-9",
      orgId: "org-1",
    });
    const [, options] = mocks.historyAwareUpsert.mock.calls[0];
    // Containment first: a team that is not in this organization AT COMMIT TIME
    // aborts the claim, the widen, the history event and the outbox row.
    expect(options.coCommitStatements).toEqual([
      { text: "TEAM ASSERT SQL", values: ["team-9", "org-1"] },
      { text: "CLAIM SQL", values: ["req-1"] },
    ]);
  });

  it("pins the widen to the CAPTURED row version and writes the target tuple", async () => {
    await approve();
    const [input, options] = mocks.historyAwareUpsert.mock.calls[0];
    expect(options.expectedBaseVersion).toBe(3);
    expect(input).toMatchObject({
      id: "mem-1",
      type: MEMORY_CONCEPT_TYPE_ID,
      orgId: "org-1",
      ownerLevel: "organization",
      ownerId: "org-1",
      visibility: "organization",
    });
    // The DATA is carried through untouched — a promotion widens scope, it does
    // not rewrite content.
    expect(input.data).toBe(ROW.data);
  });

  it("PRESERVES the row's project: it never passes a projectId of its own", async () => {
    await approve();
    const [input] = mocks.historyAwareUpsert.mock.calls[0];
    expect(input).not.toHaveProperty("projectId");
  });

  it("NEUTRALIZES the approver's project frame, so an approval cannot move the row into their room", async () => {
    mocks.getStore.mockReturnValue({ userId: "u-admin", orgId: "org-1", projectContext: { projectId: "proj-approver" } });
    await approve();
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const [neutralized] = mocks.run.mock.calls[0];
    expect((neutralized as { projectContext?: unknown }).projectContext).toBeUndefined();
    // The rest of the frame survives — this strips the project axis only.
    expect(neutralized).toMatchObject({ userId: "u-admin", orgId: "org-1" });
  });

  it("mints MEMBERSHIP-grounded authority for the DECIDER, in the decider's org", async () => {
    await approve();
    expect(mocks.verifySessionAuthority).toHaveBeenCalledWith("u-admin", "org-1");
    const [, options] = mocks.historyAwareUpsert.mock.calls[0];
    expect(options.authority).toMatchObject({ orgId: "org-1" });
    expect(options.historyEffect).toBe("reversible-internal");
    expect(options.actor).toEqual({ actorId: "u-admin", actorKind: "user", orgId: "org-1" });
  });

  it("classifies a CAS miss by re-reading the request — a concurrent decider is a conflict", async () => {
    mocks.historyAwareUpsert.mockImplementation(() => {
      throw new VersionConflictError({
        objectId: "mem-1",
        currentVersion: 3,
        expectedBaseVersion: 3,
        latestSnapshot: null,
        conflictingFields: [],
        reason: "stale-write",
      });
    });
    mocks.readMemoryPromotionRequestById
      .mockReturnValueOnce(REQUEST)
      .mockReturnValueOnce({ ...REQUEST, status: "approved", decidedBy: "u-other" });
    await expect(approve()).resolves.toMatchObject({ ok: false, code: "conflict" });
    expect(mocks.markMemoryPromotionRequestSuperseded).not.toHaveBeenCalled();
  });

  it("classifies a CAS miss with a still-pending request as a stale snapshot, and supersedes it", async () => {
    mocks.historyAwareUpsert.mockImplementation(() => {
      throw new VersionConflictError({
        objectId: "mem-1",
        currentVersion: 4,
        expectedBaseVersion: 3,
        latestSnapshot: null,
        conflictingFields: [],
        reason: "stale-write",
      });
    });
    await expect(approve()).resolves.toMatchObject({ ok: false, code: "stale_snapshot" });
    expect(mocks.markMemoryPromotionRequestSuperseded).toHaveBeenCalledWith({ id: "req-1", orgId: "org-1" });
  });

  it("maps a missing org-write authority to a PERMANENT not_authorized and never writes", async () => {
    mocks.verifySessionAuthority.mockRejectedValue(new OrgWriteAuthorityError("not a member"));
    await expect(approve()).resolves.toMatchObject({ ok: false, code: "not_authorized" });
    expect(mocks.historyAwareUpsert).not.toHaveBeenCalled();
    expect(mocks.markMemoryPromotionRequestSuperseded).not.toHaveBeenCalled();
  });

  it("maps any other writer failure to `transient` — a VALUE, never an escaped throw", async () => {
    mocks.historyAwareUpsert.mockImplementation(() => {
      throw new Error("connection reset");
    });
    await expect(approve()).resolves.toMatchObject({ ok: false, code: "transient" });
  });

  it("reads the memory row ORG-SCOPED and deliberately actor-UNfiltered on the decide path", async () => {
    await approve();
    expect(mocks.getObjectById).toHaveBeenCalledWith("mem-1", { orgId: "org-1" });
  });
});
