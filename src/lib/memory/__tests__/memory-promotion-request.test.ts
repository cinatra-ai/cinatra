// cinatra#1381 — the ONE actor-gated request service both surfaces delegate to.
//
// What is proven here is the READ GATE, because that is the property that would
// silently rot if the MCP tool and the server action each rolled their own: a
// member must not be able to open a promotion request against a row they cannot
// see, and the refusal must not tell them whether the row exists.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getObjectById: vi.fn(),
  decideResourceAccessForActorContext: vi.fn(() => null as unknown),
  createMemoryRowPromotionRequest: vi.fn(async () => ({ ok: true, request: { id: "req-new" } })),
}));

vi.mock("@/lib/objects-store", () => ({ getObjectById: mocks.getObjectById }));
vi.mock("@/lib/authz/enforce-resource-access", () => ({
  decideResourceAccessForActorContext: mocks.decideResourceAccessForActorContext,
}));
vi.mock("@/lib/objects/memory-row-promotion", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, createMemoryRowPromotionRequest: mocks.createMemoryRowPromotionRequest };
});

import { requestMemoryPromotion } from "../memory-promotion-request";
import { MEMORY_CONCEPT_TYPE_ID } from "@/lib/objects/memory-row-promotion";
import type { ActorContext } from "@/lib/authz/actor-context";

const actor = {
  principalType: "HumanUser",
  principalId: "u-member",
  organizationId: "org-1",
  orgRole: "member",
} as unknown as ActorContext;

const ROW = {
  id: "mem-1",
  type: MEMORY_CONCEPT_TYPE_ID,
  ownerLevel: "user",
  ownerId: "u-member",
  visibility: "private",
  orgId: "org-1",
  projectId: null,
};

const NOT_FOUND = {
  ok: false,
  code: "not_found",
  message: "No memory row 'mem-1' in this organization.",
};

function call(over: Record<string, unknown> = {}) {
  return requestMemoryPromotion({
    orgId: "org-1",
    memoryId: "mem-1",
    requestedBy: "u-member",
    toVisibility: "organization",
    actor,
    ...over,
  } as Parameters<typeof requestMemoryPromotion>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getObjectById.mockReturnValue(ROW);
  mocks.decideResourceAccessForActorContext.mockReturnValue(null);
  mocks.createMemoryRowPromotionRequest.mockResolvedValue({ ok: true, request: { id: "req-new" } });
});

describe("the actor-gated read", () => {
  it("reads the row THROUGH the actor, so the SQL ownership filter applies", async () => {
    await call();
    expect(mocks.getObjectById).toHaveBeenCalledWith("mem-1", { orgId: "org-1" }, actor);
  });

  it("layers the canonical object.read kernel decision on top, with the row's real axes", async () => {
    await call();
    expect(mocks.decideResourceAccessForActorContext).toHaveBeenCalledWith(
      {
        resourceType: "object",
        resourceId: "mem-1",
        organizationId: "org-1",
        ownerLevel: "user",
        ownerId: "u-member",
        visibility: "private",
        projectId: null,
      },
      actor,
      "object.read",
    );
  });

  it("answers ONE indistinguishable not_found for absent, wrong-type and kernel-denied", async () => {
    mocks.getObjectById.mockReturnValueOnce(null);
    expect(await call()).toEqual(NOT_FOUND);

    mocks.getObjectById.mockReturnValueOnce({ ...ROW, type: "@cinatra-ai/blog:post" });
    expect(await call()).toEqual(NOT_FOUND);

    mocks.decideResourceAccessForActorContext.mockReturnValueOnce({ reason: "denied" });
    expect(await call()).toEqual(NOT_FOUND);
  });

  it("never opens a request when the read gate refuses", async () => {
    mocks.decideResourceAccessForActorContext.mockReturnValue({ reason: "denied" });
    await call();
    expect(mocks.createMemoryRowPromotionRequest).not.toHaveBeenCalled();
  });
});

describe("attribution", () => {
  it("refuses a request attributed to someone other than the acting principal", async () => {
    const res = await call({ requestedBy: "u-someone-else" });
    expect(res).toMatchObject({ ok: false, code: "not_authorized" });
    expect(mocks.getObjectById).not.toHaveBeenCalled();
  });

  it("refuses a MISSING actor rather than falling through to an unfiltered read", async () => {
    const res = await call({ actor: undefined });
    expect(res).toMatchObject({ ok: false, code: "not_authorized" });
    expect(mocks.getObjectById).not.toHaveBeenCalled();
  });
});

describe("delegation", () => {
  it("forwards the target and the team id to the CAS-anchored data layer", async () => {
    await call({ toVisibility: "team", targetTeamId: "team-9" });
    expect(mocks.createMemoryRowPromotionRequest).toHaveBeenCalledWith({
      orgId: "org-1",
      objectId: "mem-1",
      requestedBy: "u-member",
      toVisibility: "team",
      targetTeamId: "team-9",
    });
  });

  it("omits an absent team id rather than sending undefined through", async () => {
    await call();
    expect(mocks.createMemoryRowPromotionRequest).toHaveBeenCalledWith({
      orgId: "org-1",
      objectId: "mem-1",
      requestedBy: "u-member",
      toVisibility: "organization",
    });
  });

  it("passes the data layer's refusal through unchanged", async () => {
    mocks.createMemoryRowPromotionRequest.mockResolvedValue({ ok: false, code: "conflict", message: "already pending" });
    expect(await call()).toEqual({ ok: false, code: "conflict", message: "already pending" });
  });

  it("NEVER writes the memory row itself — the only write is the request", async () => {
    await call();
    expect(mocks.createMemoryRowPromotionRequest).toHaveBeenCalledTimes(1);
  });
});
