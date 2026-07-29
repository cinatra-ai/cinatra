// cinatra#1437 — the artifact row-scope promotion data layer: the CAS decide
// ladder (authorization → existence/state → version guard → never-narrow →
// fail-closed secret/PII scan → claim → atomic widen/re-projection/audit), the
// never-narrow lattice, the fail-closed scanner, and request creation. Every
// heavy reader/writer is injected — no DB — so the ladder is proven directly.
import { describe, it, expect, vi } from "vitest";

import {
  createArtifactRowPromotionRequest,
  decideArtifactPromotion,
  isWiden,
  promotionScopeRank,
  scanArtifactContentForSecrets,
  type ArtifactPromotionDeps,
  type ArtifactPromotionReviewRow,
  type PromotableObject,
} from "../artifact-row-promotion";
import type { ArtifactPromotionRequestRow } from "../artifact-promotion-request-store";
import type { ApprovalViewer } from "@/app/configuration/approvals/sources/types";

const admin: ApprovalViewer = { userId: "u-admin", orgId: "org-1", isAdmin: true };
const member: ApprovalViewer = { userId: "u-member", orgId: "org-1", isAdmin: false };

function requestRow(over: Partial<ArtifactPromotionRequestRow> = {}): ArtifactPromotionRequestRow {
  return {
    id: "req-1",
    orgId: "org-1",
    objectId: "obj-1",
    objectTitle: "Quarterly insight",
    requestedBy: "u-member",
    fromVisibility: "private",
    toVisibility: "organization",
    toOwnerLevel: "organization",
    toOwnerId: "org-1",
    toOwnerLabel: null,
    rowVersion: 3,
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...over,
  };
}

function promObject(over: Partial<PromotableObject> = {}): PromotableObject {
  return {
    id: "obj-1",
    type: "@cinatra-ai/blog:post",
    data: { title: "Quarterly insight", body: "nothing secret here" },
    version: 3,
    visibility: "private",
    ownerLevel: "user",
    ownerId: "u-member",
    orgId: "org-1",
    ...over,
  };
}

/** An in-memory deps harness with spies. Every method is overridable. */
function harness(cfg: {
  request?: ArtifactPromotionRequestRow | null;
  requests?: ArtifactPromotionRequestRow[];
  object?: PromotableObject | null;
  scan?: { clean: boolean };
  scanThrows?: boolean;
  widen?:
    | { ok: true }
    | { ok: false; reason: "version_conflict" | "not_found" | "transient" | "not_authorized" };
  widenThrows?: boolean;
  /** readTeamInOrg returns null (unknown/foreign team or non-member). */
  teamMissing?: boolean;
  casWins?: boolean;
  supersedeWins?: boolean;
  compensateWins?: boolean;
} = {}) {
  const request = cfg.request === undefined ? requestRow() : cfg.request;
  const requests = cfg.requests ?? (request ? [request] : []);
  const spies = {
    readRequestById: vi.fn((id: string, orgId: string) =>
      requests.find((r) => r.id === id && r.orgId === orgId) ?? null,
    ),
    listRequests: vi.fn(() => requests),
    countRequests: vi.fn(() => requests.length),
    casDecideRequest: vi.fn(() => cfg.casWins ?? true),
    markSuperseded: vi.fn(() => cfg.supersedeWins ?? true),
    compensateApproved: vi.fn(() => cfg.compensateWins ?? true),
    createRequest: vi.fn((input: Parameters<ArtifactPromotionDeps["createRequest"]>[0]) =>
      requestRow({ id: "req-new", ...input }),
    ),
    readObject: vi.fn(() => (cfg.object === undefined ? promObject() : cfg.object)),
    readTeamInOrg: vi.fn((input: { teamId: string }) =>
      cfg.teamMissing ? null : { id: input.teamId, name: "Growth" },
    ),
    widenAndReproject: vi.fn(() => {
      if (cfg.widenThrows) throw new Error("historyAwareUpsert boom");
      return cfg.widen ?? { ok: true };
    }),
    scanContent: vi.fn((content: unknown) => {
      if (cfg.scanThrows) throw new Error("scanner boom");
      return cfg.scan ?? scanArtifactContentForSecrets(content);
    }),
  };
  const deps = spies as unknown as ArtifactPromotionDeps;
  return { deps, spies };
}

// ---------------------------------------------------------------------------

describe("never-narrow lattice", () => {
  it("ranks the visibility lattice private < team < organization < public", () => {
    expect(promotionScopeRank("private")).toBeLessThan(promotionScopeRank("team"));
    expect(promotionScopeRank("team")).toBeLessThan(promotionScopeRank("organization"));
    expect(promotionScopeRank("organization")).toBeLessThan(promotionScopeRank("public"));
    expect(promotionScopeRank("bogus")).toBe(-1);
  });

  it("isWiden is strictly widening (never narrow, never a no-op, never unknown)", () => {
    expect(isWiden("private", "organization")).toBe(true);
    expect(isWiden("private", "team")).toBe(true);
    expect(isWiden("team", "organization")).toBe(true);
    expect(isWiden("organization", "team")).toBe(false); // narrow
    expect(isWiden("organization", "organization")).toBe(false); // no-op
    expect(isWiden("private", "private")).toBe(false);
    expect(isWiden("bogus", "organization")).toBe(false);
  });
});

describe("fail-closed secret/PII scan", () => {
  it("passes clean content", () => {
    expect(scanArtifactContentForSecrets({ title: "hello", body: "plain text" }).clean).toBe(true);
  });

  it("flags a seeded secret (fail-closed)", () => {
    expect(
      scanArtifactContentForSecrets({ note: "token sk-ABCDEFGH1234567890abcd here" }).clean,
    ).toBe(false);
    expect(scanArtifactContentForSecrets("email me at alice@example.com").clean).toBe(false);
  });

  it("reports NOT clean when serialization throws (fail-closed)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(scanArtifactContentForSecrets(circular).clean).toBe(false);
  });
});

describe("decideArtifactPromotion — authorization + existence + state", () => {
  it("refuses a non-admin as not_authorized WITHOUT touching the store", async () => {
    const { deps, spies } = harness();
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: member },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "not_authorized" });
    expect(spies.readRequestById).not.toHaveBeenCalled();
  });

  it("refuses an unknown request as not_found", async () => {
    const { deps } = harness({ request: null });
    const res = await decideArtifactPromotion(
      { requestId: "nope", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "not_found" });
  });

  it("refuses a non-pending request as invalid_state", async () => {
    const { deps } = harness({ request: requestRow({ status: "approved" }) });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "invalid_state" });
  });
});

describe("decideArtifactPromotion — reject leaves the row untouched", () => {
  it("rejects via CAS and NEVER widens the object", async () => {
    const { deps, spies } = harness();
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "reject", reason: "contains a draft", viewer: admin },
      deps,
    );
    expect(res).toEqual({ ok: true });
    expect(spies.casDecideRequest).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "reject", note: "contains a draft" }),
    );
    expect(spies.widenAndReproject).not.toHaveBeenCalled();
    expect(spies.readObject).not.toHaveBeenCalled();
  });

  it("maps a lost reject CAS to conflict", async () => {
    const { deps } = harness({ casWins: false });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "reject", reason: "x", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("decideArtifactPromotion — approve gates (each short-circuits)", () => {
  it("requires the reviewed version (version_required)", async () => {
    const { deps, spies } = harness();
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "version_required" });
    expect(spies.readObject).not.toHaveBeenCalled();
  });

  it("refuses when the row vanished (not_found)", async () => {
    const { deps } = harness({ object: null });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "not_found" });
  });

  it("CAS: a stale reviewer snapshot supersedes the request (stale_snapshot)", async () => {
    const { deps, spies } = harness();
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "2", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "stale_snapshot" });
    expect(spies.markSuperseded).toHaveBeenCalledWith({ id: "req-1", orgId: "org-1" });
    expect(spies.widenAndReproject).not.toHaveBeenCalled();
  });

  it("CAS: an edit-after-request (live row moved past the captured version) supersedes", async () => {
    // Reviewer echoes the captured version (3), but the live row is now v4.
    const { deps, spies } = harness({ object: promObject({ version: 4 }) });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "stale_snapshot" });
    expect(spies.markSuperseded).toHaveBeenCalled();
    expect(spies.widenAndReproject).not.toHaveBeenCalled();
  });

  it("never-narrow: refuses when the target is not wider than the CURRENT visibility", async () => {
    // Row is already org-visible; a request to widen to org is a no-op → narrowing.
    const { deps, spies } = harness({
      request: requestRow({ fromVisibility: "organization", toVisibility: "organization" }),
      object: promObject({ visibility: "organization", version: 3 }),
    });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "narrowing" });
    expect(spies.widenAndReproject).not.toHaveBeenCalled();
  });

  it("secret-scan fail-closed: a non-clean scan refuses BEFORE claiming or widening", async () => {
    const { deps, spies } = harness({ scan: { clean: false } });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "secret_scan" });
    expect(spies.casDecideRequest).not.toHaveBeenCalled();
    expect(spies.widenAndReproject).not.toHaveBeenCalled();
  });

  it("secret-scan fail-closed: a seeded secret in the real scanner refuses", async () => {
    const { deps } = harness({
      object: promObject({ data: { title: "leak", body: "sk-ABCDEFGH1234567890abcd" } }),
      scan: undefined, // use the real scanner
    });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "secret_scan" });
  });

  it("secret-scan fail-closed: a THROWING scanner still refuses", async () => {
    const { deps } = harness({ scanThrows: true });
    // The dep itself throws; production's scanContent never throws (it catches),
    // but a throwing dep must not slip an approve through — decide surfaces it.
    await expect(
      decideArtifactPromotion(
        { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
        deps,
      ),
    ).rejects.toThrow("scanner boom");
  });
});

describe("decideArtifactPromotion — team-target revalidation (5d2)", () => {
  const teamRequest = () =>
    requestRow({ toVisibility: "team", toOwnerLevel: "team", toOwnerId: "team-9" });

  it("approve refuses when the destination team no longer exists in the org (no state change)", async () => {
    const { deps, spies } = harness({
      request: teamRequest(),
      object: promObject(),
      teamMissing: true,
    });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "invalid_state" });
    expect(spies.readTeamInOrg).toHaveBeenCalledWith({ teamId: "team-9", orgId: "org-1" });
    expect(spies.casDecideRequest).not.toHaveBeenCalled();
    expect(spies.widenAndReproject).not.toHaveBeenCalled();
    expect(spies.markSuperseded).not.toHaveBeenCalled();
  });

  it("approve proceeds when the destination team still exists", async () => {
    const { deps, spies } = harness({ request: teamRequest(), object: promObject() });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toEqual({ ok: true });
    expect(spies.widenAndReproject).toHaveBeenCalledWith(
      expect.objectContaining({ toOwnerLevel: "team", toOwnerId: "team-9" }),
    );
  });
});

describe("decideArtifactPromotion — atomic apply", () => {
  it("happy path: CLAIMS the request first (fail-closed), then widens/reprojects/audits", async () => {
    const { deps, spies } = harness();
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", reason: "useful", viewer: admin },
      deps,
    );
    expect(res).toEqual({ ok: true });
    expect(spies.casDecideRequest).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "approve", decidedBy: "u-admin" }),
    );
    expect(spies.widenAndReproject).toHaveBeenCalledWith(
      expect.objectContaining({
        toVisibility: "organization",
        toOwnerLevel: "organization",
        toOwnerId: "org-1",
        expectedBaseVersion: 3,
        actor: admin,
      }),
    );
    // Fail-closed ordering: the claim commits BEFORE the widen, so the row is
    // never widened unless the whole apply succeeds; no compensation on success.
    expect(spies.casDecideRequest.mock.invocationCallOrder[0]).toBeLessThan(
      spies.widenAndReproject.mock.invocationCallOrder[0],
    );
    expect(spies.compensateApproved).not.toHaveBeenCalled();
  });

  it("a lost claim CAS is a conflict and NEVER widens (at most one apply)", async () => {
    const { deps, spies } = harness({ casWins: false });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "conflict" });
    expect(spies.widenAndReproject).not.toHaveBeenCalled();
  });

  it("a widen CAS miss COMPENSATES the claimed request to superseded (fail-closed; row untouched)", async () => {
    const { deps, spies } = harness({ widen: { ok: false, reason: "version_conflict" } });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "stale_snapshot" });
    // Claimed first, then the widen failed → the approval is reversed, never stranded.
    expect(spies.casDecideRequest).toHaveBeenCalledWith(expect.objectContaining({ decision: "approve" }));
    expect(spies.compensateApproved).toHaveBeenCalledWith({ id: "req-1", orgId: "org-1", to: "superseded" });
  });

  it("a widen not_found COMPENSATES to superseded and returns not_found", async () => {
    const { deps, spies } = harness({ widen: { ok: false, reason: "not_found" } });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "not_found" });
    expect(spies.compensateApproved).toHaveBeenCalledWith({ id: "req-1", orgId: "org-1", to: "superseded" });
  });

  it("a widen not_authorized (decider holds no org-write authority — #1939 Stage D) COMPENSATES to pending and returns not_authorized, never transient", async () => {
    // The platform-admin-who-is-not-a-member case: the org-write authority
    // mint is membership-grounded, so this decider can NEVER apply the widen.
    // Mapping it to "transient" would invite an endless retry of the same
    // refusal (adversarial-review finding); the request instead goes back to
    // pending for a member admin, with a permanent not_authorized outcome.
    const { deps, spies } = harness({ widen: { ok: false, reason: "not_authorized" } });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "not_authorized" });
    expect(spies.compensateApproved).toHaveBeenCalledWith({ id: "req-1", orgId: "org-1", to: "pending" });
  });

  it("a transient widen failure COMPENSATES to pending (retryable) and returns transient", async () => {
    const { deps, spies } = harness({ widen: { ok: false, reason: "transient" } });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "transient" });
    expect(spies.compensateApproved).toHaveBeenCalledWith({ id: "req-1", orgId: "org-1", to: "pending" });
  });

  it("a THROWING widen dep never strands the claim: compensates to pending, returns transient (no throw escapes)", async () => {
    const { deps, spies } = harness({ widenThrows: true });
    const res = await decideArtifactPromotion(
      { requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "transient" });
    // Claimed first, the widen threw → the claim is reversed to pending (retryable).
    expect(spies.casDecideRequest).toHaveBeenCalledWith(expect.objectContaining({ decision: "approve" }));
    expect(spies.compensateApproved).toHaveBeenCalledWith({ id: "req-1", orgId: "org-1", to: "pending" });
  });
});

describe("list/count map subject-native rows", () => {
  it("lists inbox rows mapped to review rows with the captured version as the CAS token", async () => {
    const { deps, spies } = harness({ requests: [requestRow()] });
    const { listArtifactPromotionInbox } = await import("../artifact-row-promotion");
    const rows: ArtifactPromotionReviewRow[] = await listArtifactPromotionInbox(
      { orgId: "org-1", reviewerId: "u-admin" },
      deps,
    );
    expect(spies.listRequests).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", status: "pending", excludeRequester: "u-admin" }),
    );
    expect(rows[0]).toMatchObject({
      requestId: "req-1",
      objectId: "obj-1",
      title: "Quarterly insight",
      version: "3",
      fromScope: "private",
      toScope: "organization",
    });
  });
});

describe("createArtifactRowPromotionRequest", () => {
  it("creates a pending request capturing the row version + widen target (org)", async () => {
    const { deps, spies } = harness();
    const res = await createArtifactRowPromotionRequest(
      { orgId: "org-1", objectId: "obj-1", requestedBy: "u-member", toVisibility: "organization" },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(spies.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        objectId: "obj-1",
        fromVisibility: "private",
        toVisibility: "organization",
        toOwnerLevel: "organization",
        toOwnerId: "org-1",
        rowVersion: 3,
      }),
    );
  });

  it("refuses a non-widening request (narrowing)", async () => {
    const { deps, spies } = harness({ object: promObject({ visibility: "organization" }) });
    const res = await createArtifactRowPromotionRequest(
      { orgId: "org-1", objectId: "obj-1", requestedBy: "u-member", toVisibility: "organization" },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "narrowing" });
    expect(spies.createRequest).not.toHaveBeenCalled();
  });

  it("requires a team id for a team target", async () => {
    const { deps } = harness();
    const res = await createArtifactRowPromotionRequest(
      { orgId: "org-1", objectId: "obj-1", requestedBy: "u-member", toVisibility: "team" },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "invalid_state" });
  });

  it("team target: validates team-in-org + requester membership and snapshots the display label", async () => {
    const { deps, spies } = harness();
    const res = await createArtifactRowPromotionRequest(
      {
        orgId: "org-1",
        objectId: "obj-1",
        requestedBy: "u-member",
        toVisibility: "team",
        targetTeamId: "team-9",
      },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(spies.readTeamInOrg).toHaveBeenCalledWith({
      teamId: "team-9",
      orgId: "org-1",
      memberUserId: "u-member",
    });
    expect(spies.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        toOwnerLevel: "team",
        toOwnerId: "team-9",
        toOwnerLabel: "Growth",
      }),
    );
  });

  it("team target: an unknown/foreign team (or non-membership) refuses with ONE indistinguishable message and never creates", async () => {
    const { deps, spies } = harness({ teamMissing: true });
    const res = await createArtifactRowPromotionRequest(
      {
        orgId: "org-1",
        objectId: "obj-1",
        requestedBy: "u-member",
        toVisibility: "team",
        targetTeamId: "team-foreign",
      },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "invalid_state" });
    expect(spies.createRequest).not.toHaveBeenCalled();
  });

  it("maps a one-pending duplicate-key store error to conflict", async () => {
    const { deps } = harness();
    (deps.createRequest as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("artifact_promotion_request: a pending promotion already exists for object obj-1");
    });
    const res = await createArtifactRowPromotionRequest(
      { orgId: "org-1", objectId: "obj-1", requestedBy: "u-member", toVisibility: "organization" },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "conflict" });
  });
});
