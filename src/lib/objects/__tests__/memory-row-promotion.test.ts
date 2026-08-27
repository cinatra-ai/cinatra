// cinatra#1381 (epic #1373) — the memory row-promotion data layer.
//
// Proves the pieces the issue makes this flow responsible for: the three-move
// transition matrix, the CAS decide ladder (authorization -> existence/state ->
// version guard -> matrix -> target-scope authority -> fail-closed credential
// scan -> the ATOMIC apply), request creation with its indistinguishable
// `not_found`, and the advisory duplicate signal's privacy shape.
//
// Every heavy reader/writer is injected — no DB — so the ladder is exercised
// directly, over the SAME code path production uses.
import { describe, it, expect, vi } from "vitest";

import {
  createMemoryRowPromotionRequest,
  decideMemoryPromotion,
  deriveMemoryTitle,
  isAllowedMemoryPromotion,
  listMemoryPromotionInbox,
  listMemoryPromotionMine,
  memoryDuplicateHint,
  scanMemoryContentForSecrets,
  widenTargetFor,
  MEMORY_CONCEPT_TYPE_ID,
  type MemoryPromotionDeps,
  type PromotableMemoryObject,
} from "../memory-row-promotion";
import type { MemoryPromotionRequestRow } from "../memory-promotion-request-store";
import type { ApprovalViewer } from "@/lib/approvals/sources/types";

const admin: ApprovalViewer = { userId: "u-admin", orgId: "org-1", isAdmin: true };
const member: ApprovalViewer = { userId: "u-member", orgId: "org-1", isAdmin: false };

function requestRow(over: Partial<MemoryPromotionRequestRow> = {}): MemoryPromotionRequestRow {
  return {
    id: "req-1",
    orgId: "org-1",
    objectId: "mem-1",
    objectTitle: "Deployment runbook",
    requestedBy: "u-member",
    fromOwnerLevel: "user",
    fromOwnerId: "u-member",
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
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...over,
  };
}

function memObject(over: Partial<PromotableMemoryObject> = {}): PromotableMemoryObject {
  return {
    id: "mem-1",
    type: MEMORY_CONCEPT_TYPE_ID,
    data: {
      conceptId: "runbooks/deployment",
      okfType: "procedure",
      frontmatter: { type: "procedure", title: "Deployment runbook" },
      bodyMarkdown: "Run the deploy script. Nothing secret here.",
      links: [],
    },
    version: 3,
    visibility: "private",
    ownerLevel: "user",
    ownerId: "u-member",
    orgId: "org-1",
    projectId: null,
    ...over,
  };
}

/** An in-memory deps harness with spies. Every method is overridable. */
function harness(
  cfg: {
    request?: MemoryPromotionRequestRow | null;
    requests?: MemoryPromotionRequestRow[];
    /** The request as re-read AFTER a failed apply (the cas_miss classifier). */
    requestAfterApply?: MemoryPromotionRequestRow | null;
    object?: PromotableMemoryObject | null;
    scan?: { clean: boolean };
    scanThrows?: boolean;
    apply?:
      | { ok: true }
      | { ok: false; reason: "cas_miss" | "not_found" | "transient" | "not_authorized" };
    applyThrows?: boolean;
    teamMissing?: boolean;
    rejectWins?: boolean;
    duplicates?: number;
    duplicatesThrow?: boolean;
    createThrows?: Error;
  } = {},
) {
  const request = cfg.request === undefined ? requestRow() : cfg.request;
  const requests = cfg.requests ?? (request ? [request] : []);
  let applyCalls = 0;
  const spies = {
    readRequestById: vi.fn((id: string, orgId: string) => {
      if (applyCalls > 0 && cfg.requestAfterApply !== undefined) return cfg.requestAfterApply;
      return requests.find((r) => r.id === id && r.orgId === orgId) ?? null;
    }),
    listRequests: vi.fn(() => requests),
    countRequests: vi.fn(() => requests.length),
    casReject: vi.fn(() => cfg.rejectWins ?? true),
    markSuperseded: vi.fn(() => true),
    createRequest: vi.fn((input: Parameters<MemoryPromotionDeps["createRequest"]>[0]) => {
      if (cfg.createThrows) throw cfg.createThrows;
      return requestRow({ id: "req-new", ...input });
    }),
    readTeamInOrg: vi.fn((input: { teamId: string }) =>
      cfg.teamMissing ? null : { id: input.teamId, name: "Growth" },
    ),
    readObject: vi.fn(() => (cfg.object === undefined ? memObject() : cfg.object)),
    countAudienceDuplicates: vi.fn(() => {
      if (cfg.duplicatesThrow) throw new Error("duplicate query boom");
      return cfg.duplicates ?? 0;
    }),
    applyApproval: vi.fn(async () => {
      applyCalls += 1;
      if (cfg.applyThrows) throw new Error("apply boom");
      return cfg.apply ?? { ok: true };
    }),
    scanContent: vi.fn((content: unknown) => {
      if (cfg.scanThrows) throw new Error("scanner boom");
      return cfg.scan ?? scanMemoryContentForSecrets(content);
    }),
  };
  const deps = spies as unknown as MemoryPromotionDeps;
  return { deps, spies };
}

// ---------------------------------------------------------------------------
// AC5 — the transition matrix.
// ---------------------------------------------------------------------------

describe("the transition matrix", () => {
  it("admits EXACTLY the three moves the issue names", () => {
    expect(isAllowedMemoryPromotion({ ownerLevel: "user", visibility: "private" }, { ownerLevel: "team", visibility: "team" })).toBe(true);
    expect(isAllowedMemoryPromotion({ ownerLevel: "user", visibility: "private" }, { ownerLevel: "organization", visibility: "organization" })).toBe(true);
    expect(isAllowedMemoryPromotion({ ownerLevel: "team", visibility: "team" }, { ownerLevel: "organization", visibility: "organization" })).toBe(true);
  });

  it("refuses every other pair — narrowings, no-ops, public, and unmodelled source tuples", () => {
    const refused: Array<[{ ownerLevel: string; visibility: string }, { ownerLevel: string; visibility: string }]> = [
      // narrowing
      [{ ownerLevel: "organization", visibility: "organization" }, { ownerLevel: "team", visibility: "team" }],
      [{ ownerLevel: "team", visibility: "team" }, { ownerLevel: "user", visibility: "private" }],
      // no-op
      [{ ownerLevel: "user", visibility: "private" }, { ownerLevel: "user", visibility: "private" }],
      [{ ownerLevel: "team", visibility: "team" }, { ownerLevel: "team", visibility: "team" }],
      // public is not a promotion target at all
      [{ ownerLevel: "user", visibility: "private" }, { ownerLevel: "organization", visibility: "public" }],
      // a user-owned team-VISIBLE row is not team-readable — an unmodelled source
      [{ ownerLevel: "user", visibility: "team" }, { ownerLevel: "organization", visibility: "organization" }],
      // owner level and visibility must move together
      [{ ownerLevel: "user", visibility: "private" }, { ownerLevel: "user", visibility: "organization" }],
      [{ ownerLevel: "user", visibility: "private" }, { ownerLevel: "organization", visibility: "team" }],
      // workspace is not in the matrix
      [{ ownerLevel: "workspace", visibility: "organization" }, { ownerLevel: "organization", visibility: "organization" }],
    ];
    for (const [from, to] of refused) {
      expect(isAllowedMemoryPromotion(from, to), `${from.ownerLevel}/${from.visibility} -> ${to.ownerLevel}/${to.visibility}`).toBe(false);
    }
  });

  it("a team target needs a target team id; an organization target resolves to the org", () => {
    expect(widenTargetFor("organization", "org-1", undefined)).toEqual({ ok: true, ownerLevel: "organization", ownerId: "org-1" });
    expect(widenTargetFor("team", "org-1", undefined)).toMatchObject({ ok: false, code: "invalid_state" });
    expect(widenTargetFor("team", "org-1", "team-9")).toEqual({ ok: true, ownerLevel: "team", ownerId: "team-9" });
  });
});

// ---------------------------------------------------------------------------
// AC3 — the fail-closed credential scan (the #1378 detector, reused).
// ---------------------------------------------------------------------------

describe("the fail-closed credential scan", () => {
  it("clears an envelope with no credential-shaped literal", () => {
    expect(scanMemoryContentForSecrets(memObject().data).clean).toBe(true);
  });

  it("refuses a credential in the BODY", () => {
    const data = { ...(memObject().data as Record<string, unknown>), bodyMarkdown: "token: sk-ant-abcdefghijklmnopqrstuvwxyz012345" };
    expect(scanMemoryContentForSecrets(data).clean).toBe(false);
  });

  it("refuses a credential in a FRONTMATTER value", () => {
    const data = {
      ...(memObject().data as Record<string, unknown>),
      frontmatter: { type: "procedure", title: "x", deployKey: "ghp_abcdefghijklmnopqrstuvwxyz0123" },
    };
    expect(scanMemoryContentForSecrets(data).clean).toBe(false);
  });

  it("refuses a credential hidden in a frontmatter KEY", () => {
    const data = {
      ...(memObject().data as Record<string, unknown>),
      frontmatter: { type: "procedure", "AKIAIOSFODNN7EXAMPLE": "a note" },
    };
    expect(scanMemoryContentForSecrets(data).clean).toBe(false);
  });

  it("is NOT clean when the scan cannot complete — a cyclic payload", () => {
    const data: Record<string, unknown> = { conceptId: "a", okfType: "t" };
    data.self = data;
    expect(scanMemoryContentForSecrets(data).clean).toBe(false);
  });

  it("is NOT clean for a shape it cannot vouch for (null / a bare string / an array)", () => {
    expect(scanMemoryContentForSecrets(null).clean).toBe(false);
    expect(scanMemoryContentForSecrets("sk-ant-not-an-envelope").clean).toBe(false);
    expect(scanMemoryContentForSecrets([{ a: 1 }]).clean).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC5 / request surface — createMemoryRowPromotionRequest.
// ---------------------------------------------------------------------------

describe("createMemoryRowPromotionRequest", () => {
  it("captures the row version and BOTH source axes, and preserves the target label", async () => {
    const { deps, spies } = harness();
    const res = await createMemoryRowPromotionRequest(
      { orgId: "org-1", objectId: "mem-1", requestedBy: "u-member", toVisibility: "organization" },
      deps,
    );
    expect(res.ok).toBe(true);
    expect(spies.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        objectId: "mem-1",
        objectTitle: "Deployment runbook",
        fromOwnerLevel: "user",
        fromOwnerId: "u-member",
        fromVisibility: "private",
        toVisibility: "organization",
        toOwnerLevel: "organization",
        toOwnerId: "org-1",
        rowVersion: 3,
      }),
    );
  });

  it("answers an INDISTINGUISHABLE not_found for an absent row, a non-memory row and a foreign-org row", async () => {
    for (const object of [
      null,
      memObject({ type: "@cinatra-ai/blog:post" }),
      memObject({ orgId: "org-2" }),
    ]) {
      const { deps } = harness({ object });
      const res = await createMemoryRowPromotionRequest(
        { orgId: "org-1", objectId: "mem-1", requestedBy: "u-member", toVisibility: "organization" },
        deps,
      );
      expect(res).toEqual({ ok: false, code: "not_found", message: "No memory row 'mem-1' in this organization." });
    }
  });

  it("refuses a narrowing as `narrowing` and an unmodelled widen as `invalid_state`", async () => {
    const narrowing = harness({ object: memObject({ ownerLevel: "organization", visibility: "organization" }) });
    await expect(
      createMemoryRowPromotionRequest(
        { orgId: "org-1", objectId: "mem-1", requestedBy: "u-member", toVisibility: "team", targetTeamId: "team-9" },
        narrowing.deps,
      ),
    ).resolves.toMatchObject({ ok: false, code: "narrowing" });

    // A user-owned team-VISIBLE row widens by rank but is not a modelled source.
    const unmodelled = harness({ object: memObject({ ownerLevel: "user", visibility: "team" }) });
    await expect(
      createMemoryRowPromotionRequest(
        { orgId: "org-1", objectId: "mem-1", requestedBy: "u-member", toVisibility: "organization" },
        unmodelled.deps,
      ),
    ).resolves.toMatchObject({ ok: false, code: "invalid_state" });
  });

  it("refuses a NO-OP request", async () => {
    const { deps } = harness({ object: memObject({ ownerLevel: "team", visibility: "team", ownerId: "team-9" }) });
    await expect(
      createMemoryRowPromotionRequest(
        { orgId: "org-1", objectId: "mem-1", requestedBy: "u-member", toVisibility: "team", targetTeamId: "team-9" },
        deps,
      ),
    ).resolves.toMatchObject({ ok: false, code: "narrowing" });
  });

  it("validates the target team in the ACTIVE org WITH requester membership, in one indistinguishable refusal", async () => {
    const ok = harness();
    await createMemoryRowPromotionRequest(
      { orgId: "org-1", objectId: "mem-1", requestedBy: "u-member", toVisibility: "team", targetTeamId: "team-9" },
      ok.deps,
    );
    expect(ok.spies.readTeamInOrg).toHaveBeenCalledWith({ teamId: "team-9", orgId: "org-1", memberUserId: "u-member" });

    const foreign = harness({ teamMissing: true });
    await expect(
      createMemoryRowPromotionRequest(
        { orgId: "org-1", objectId: "mem-1", requestedBy: "u-member", toVisibility: "team", targetTeamId: "team-in-another-org" },
        foreign.deps,
      ),
    ).resolves.toEqual({
      ok: false,
      code: "invalid_state",
      message: "The target team was not found in this organization (or you are not a member of it).",
    });
  });

  it("surfaces a second in-flight request as `conflict`", async () => {
    const { deps } = harness({
      createThrows: new Error("memory_promotion_request: a pending promotion already exists for object mem-1"),
    });
    await expect(
      createMemoryRowPromotionRequest(
        { orgId: "org-1", objectId: "mem-1", requestedBy: "u-member", toVisibility: "organization" },
        deps,
      ),
    ).resolves.toMatchObject({ ok: false, code: "conflict" });
  });
});

// ---------------------------------------------------------------------------
// AC2 / the decide ladder.
// ---------------------------------------------------------------------------

describe("decide — authorization", () => {
  it("refuses a NON-ADMIN, even one that could otherwise write objects, before ANY read", async () => {
    const { deps, spies } = harness();
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: member }, deps),
    ).resolves.toMatchObject({ ok: false, code: "not_authorized" });
    expect(spies.readRequestById).not.toHaveBeenCalled();
    expect(spies.applyApproval).not.toHaveBeenCalled();
  });

  it("reads the request ORG-SCOPED, so another org's request id is not_found", async () => {
    const { deps, spies } = harness({ request: requestRow({ orgId: "org-2" }) });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "not_found" });
    expect(spies.readRequestById).toHaveBeenCalledWith("req-1", "org-1");
  });

  it("refuses a request that is no longer pending", async () => {
    const { deps } = harness({ request: requestRow({ status: "approved" }) });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "invalid_state" });
  });

  it("refuses an ORGANIZATION target naming another org — the row's new owner id is written verbatim", async () => {
    const { deps, spies } = harness({ request: requestRow({ toOwnerId: "org-EVIL" }) });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "not_authorized" });
    expect(spies.applyApproval).not.toHaveBeenCalled();
  });

  it("re-validates a TEAM target's containment at approve time and never applies a dead team", async () => {
    const { deps, spies } = harness({
      request: requestRow({ toVisibility: "team", toOwnerLevel: "team", toOwnerId: "team-gone", toOwnerLabel: "Growth" }),
      teamMissing: true,
    });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "invalid_state" });
    expect(spies.readTeamInOrg).toHaveBeenCalledWith({ teamId: "team-gone", orgId: "org-1" });
    expect(spies.applyApproval).not.toHaveBeenCalled();
  });

  it("maps the decider's missing org-write authority to a PERMANENT not_authorized, leaving the request pending", async () => {
    const { deps, spies } = harness({ apply: { ok: false, reason: "not_authorized" } });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "not_authorized" });
    expect(spies.markSuperseded).not.toHaveBeenCalled();
  });
});

describe("decide — the CAS version guard", () => {
  it("requires the reviewed version back", async () => {
    const { deps, spies } = harness();
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "version_required" });
    expect(spies.applyApproval).not.toHaveBeenCalled();
  });

  it("refuses a FORGED expectedVersion that differs from the request's captured version", async () => {
    for (const forged of ["4", "2", "999", "not-a-number", "3.5"]) {
      const { deps, spies } = harness();
      await expect(
        decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: forged, viewer: admin }, deps),
      ).resolves.toMatchObject({ ok: false, code: "stale_snapshot" });
      expect(spies.applyApproval).not.toHaveBeenCalled();
    }
  });

  it("SUPERSEDES the request when the row was edited after the request (approve-after-edit)", async () => {
    const { deps, spies } = harness({ object: memObject({ version: 4 }) });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "stale_snapshot" });
    expect(spies.markSuperseded).toHaveBeenCalledWith({ id: "req-1", orgId: "org-1" });
    expect(spies.applyApproval).not.toHaveBeenCalled();
  });

  it("SUPERSEDES when the row moves DURING the apply, and never reports success", async () => {
    const { deps, spies } = harness({ apply: { ok: false, reason: "cas_miss" }, requestAfterApply: requestRow() });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "stale_snapshot" });
    expect(spies.markSuperseded).toHaveBeenCalledWith({ id: "req-1", orgId: "org-1" });
  });

  it("reports a CONCURRENT DECIDER as `conflict`, not as a stale snapshot", async () => {
    const { deps, spies } = harness({
      apply: { ok: false, reason: "cas_miss" },
      requestAfterApply: requestRow({ status: "approved", decidedBy: "u-other-admin" }),
    });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "conflict" });
    expect(spies.markSuperseded).not.toHaveBeenCalled();
  });
});

describe("decide — reject", () => {
  it("CAS-updates ONLY the request and never touches the row", async () => {
    const { deps, spies } = harness();
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "reject", reason: "duplicate", viewer: admin }, deps),
    ).resolves.toEqual({ ok: true });
    expect(spies.casReject).toHaveBeenCalledWith({
      id: "req-1",
      orgId: "org-1",
      decidedBy: "u-admin",
      note: "duplicate",
    });
    expect(spies.applyApproval).not.toHaveBeenCalled();
    expect(spies.markSuperseded).not.toHaveBeenCalled();
    // No read of the object at all on the reject path.
    expect(spies.readObject).not.toHaveBeenCalled();
  });

  it("reports a lost reject CAS as a conflict", async () => {
    const { deps } = harness({ rejectWins: false });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "reject", reason: "no", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "conflict" });
  });

  it("fails closed on an unknown action", async () => {
    const { deps, spies } = harness();
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "escalate", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "invalid_state" });
    expect(spies.applyApproval).not.toHaveBeenCalled();
  });
});

describe("decide — the secret scan on the CAS-BOUND content", () => {
  it("refuses `secret_scan` for a credential planted BETWEEN the request and the approve", async () => {
    // The request was captured at version 3 over clean content; the live row is
    // still version 3 (so the CAS passes) but now carries a credential.
    const planted = memObject({
      data: {
        conceptId: "runbooks/deployment",
        okfType: "procedure",
        frontmatter: { type: "procedure", title: "Deployment runbook" },
        bodyMarkdown: "export ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz012345",
        links: [],
      },
    });
    const { deps, spies } = harness({ object: planted });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "secret_scan" });
    expect(spies.scanContent).toHaveBeenCalledWith(planted.data);
    expect(spies.applyApproval).not.toHaveBeenCalled();
  });

  it("refuses when the scanner itself fails — fail-CLOSED, never a pass-through", async () => {
    const { deps, spies } = harness({ scan: { clean: false } });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "secret_scan" });
    expect(spies.applyApproval).not.toHaveBeenCalled();
  });

  it("the REJECTION path never scans and never touches the row", async () => {
    const { deps, spies } = harness({ scan: { clean: false } });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "reject", reason: "leaks a key", viewer: admin }, deps),
    ).resolves.toEqual({ ok: true });
    expect(spies.scanContent).not.toHaveBeenCalled();
    expect(spies.applyApproval).not.toHaveBeenCalled();
  });
});

describe("decide — the atomic apply", () => {
  it("hands the apply the request, the CAS-bound row and the decider, and reports ok", async () => {
    const { deps, spies } = harness();
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", reason: "useful", viewer: admin }, deps),
    ).resolves.toEqual({ ok: true });
    expect(spies.applyApproval).toHaveBeenCalledWith({
      request: requestRow(),
      object: memObject(),
      actor: admin,
      note: "useful",
    });
  });

  it("a transient apply failure leaves the request PENDING — there is nothing to compensate", async () => {
    const { deps, spies } = harness({ apply: { ok: false, reason: "transient" } });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "transient" });
    expect(spies.markSuperseded).not.toHaveBeenCalled();
    expect(spies.casReject).not.toHaveBeenCalled();
  });

  it("a THROWING apply is still a transient VALUE, never an escaped exception", async () => {
    const { deps } = harness({ applyThrows: true });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "transient" });
  });

  it("refuses when the row vanished, is no longer a memory row, or turned foreign", async () => {
    for (const object of [null, memObject({ type: "@cinatra-ai/blog:post" }), memObject({ orgId: "org-2" })]) {
      const { deps, spies } = harness({ object });
      await expect(
        decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
      ).resolves.toMatchObject({ ok: false, code: "not_found" });
      expect(spies.applyApproval).not.toHaveBeenCalled();
    }
  });

  it("refuses a NARROWING measured against the LIVE tuple, even when the request was legal when opened", async () => {
    // The row was already widened to organization by an earlier approval; the
    // stale request still says "-> team".
    const { deps, spies } = harness({
      request: requestRow({ toVisibility: "team", toOwnerLevel: "team", toOwnerId: "team-9" }),
      object: memObject({ ownerLevel: "organization", visibility: "organization", ownerId: "org-1" }),
    });
    await expect(
      decideMemoryPromotion({ requestId: "req-1", action: "approve", expectedVersion: "3", viewer: admin }, deps),
    ).resolves.toMatchObject({ ok: false, code: "narrowing" });
    expect(spies.applyApproval).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC4 — the advisory duplicate signal.
// ---------------------------------------------------------------------------

describe("the advisory duplicate signal", () => {
  it("asks ONLY about the requested target audience and the memory type", async () => {
    const { deps, spies } = harness({ duplicates: 2 });
    const hint = await memoryDuplicateHint(requestRow({ toVisibility: "team", toOwnerLevel: "team", toOwnerId: "team-9" }), deps);
    expect(spies.countAudienceDuplicates).toHaveBeenCalledWith({
      orgId: "org-1",
      objectId: "mem-1",
      objectType: MEMORY_CONCEPT_TYPE_ID,
      toVisibility: "team",
      toOwnerId: "team-9",
    });
    expect(hint).toBe("Advisory: 2 concepts with the same identity are already visible to the target audience.");
  });

  it("says NOTHING when there is nothing to say", async () => {
    const { deps } = harness({ duplicates: 0 });
    expect(await memoryDuplicateHint(requestRow(), deps)).toBeNull();
  });

  it("carries a COUNT only — no title, id, owner, requester or excerpt", async () => {
    const { deps } = harness({ duplicates: 3 });
    const hint = (await memoryDuplicateHint(requestRow(), deps))!;
    for (const leak of ["mem-1", "u-member", "u-admin", "runbooks/deployment", "Deployment runbook", "org-1", "req-1"]) {
      expect(hint).not.toContain(leak);
    }
  });

  it("is ADVISORY: a failure to compute it degrades to silence, never to an undecidable request", async () => {
    const { deps } = harness({ duplicatesThrow: true });
    expect(await memoryDuplicateHint(requestRow(), deps)).toBeNull();
  });

  it("rides the reviewer INBOX read and is absent from the requester's own list", async () => {
    const { deps } = harness({ duplicates: 1 });
    const inbox = await listMemoryPromotionInbox({ orgId: "org-1", reviewerId: "u-admin" }, deps);
    expect(inbox[0].duplicateHint).toBe(
      "Advisory: 1 concept with the same identity is already visible to the target audience.",
    );
    const mine = await listMemoryPromotionMine({ orgId: "org-1", requesterId: "u-member" }, deps);
    expect(mine[0].duplicateHint).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// list / count wiring + the title projection.
// ---------------------------------------------------------------------------

describe("list / count", () => {
  it("the inbox EXCLUDES the reviewer's own requests; `mine` is keyed by the requester", async () => {
    const { deps, spies } = harness();
    await listMemoryPromotionInbox({ orgId: "org-1", reviewerId: "u-admin" }, deps);
    expect(spies.listRequests).toHaveBeenCalledWith({ orgId: "org-1", status: "pending", excludeRequester: "u-admin" });
    await listMemoryPromotionMine({ orgId: "org-1", requesterId: "u-member", status: "approved" }, deps);
    expect(spies.listRequests).toHaveBeenCalledWith({ orgId: "org-1", requestedBy: "u-member", status: "approved" });
  });

  it("normalizes an unknown history filter to `all` rather than trusting it", async () => {
    const { deps, spies } = harness();
    await listMemoryPromotionMine({ orgId: "org-1", requesterId: "u-member", status: "'; DROP TABLE" }, deps);
    expect(spies.listRequests).toHaveBeenCalledWith({ orgId: "org-1", requestedBy: "u-member", status: "all" });
  });
});

describe("the reviewer-facing title", () => {
  it("prefers the frontmatter title, then the concept id, then the type — never the body", () => {
    expect(deriveMemoryTitle(memObject())).toBe("Deployment runbook");
    expect(deriveMemoryTitle(memObject({ data: { conceptId: "runbooks/deployment", frontmatter: {} } }))).toBe("runbooks/deployment");
    expect(deriveMemoryTitle(memObject({ data: {} }))).toBe(MEMORY_CONCEPT_TYPE_ID);
    expect(deriveMemoryTitle(memObject({ data: { bodyMarkdown: "secret body" } }))).toBe(MEMORY_CONCEPT_TYPE_ID);
  });
});
