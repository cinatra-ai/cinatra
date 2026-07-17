// requestArtifactPromotion — the shared request-surface service (cinatra#1437):
// the actor-gated read MUST run before the data-layer create, an invisible row
// is indistinguishable from an absent one, a missing actor fails CLOSED, and
// the data-layer result (ok or business refusal) is forwarded untouched.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getArtifactMock, createRequestMock } = vi.hoisted(() => ({
  getArtifactMock: vi.fn(),
  createRequestMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../artifact-service", () => ({
  getArtifact: getArtifactMock,
}));
vi.mock("@/lib/objects/artifact-row-promotion", () => ({
  createArtifactRowPromotionRequest: createRequestMock,
}));

import { requestArtifactPromotion } from "../artifact-promotion-request";
import type { ActorContext } from "@/lib/authz/actor-context";

const actor: ActorContext = {
  principalType: "HumanUser",
  principalId: "u-requester",
  organizationId: "org-1",
  authSource: "mcp",
  policyVersion: "v2",
};

const baseInput = {
  orgId: "org-1",
  artifactId: "obj-1",
  requestedBy: "u-requester",
  toVisibility: "organization" as const,
  actor,
};

beforeEach(() => {
  getArtifactMock.mockReset();
  createRequestMock.mockReset();
});

describe("requestArtifactPromotion", () => {
  it("refuses fail-closed when the actor is missing at runtime (the underlying read would be unfiltered)", async () => {
    const result = await requestArtifactPromotion({
      ...baseInput,
      actor: undefined as unknown as ActorContext,
    });
    expect(result).toEqual({
      ok: false,
      code: "not_authorized",
      message: expect.stringContaining("actor context"),
    });
    expect(getArtifactMock).not.toHaveBeenCalled();
    expect(createRequestMock).not.toHaveBeenCalled();
  });

  it("returns not_found (no probe oracle) when the actor cannot see the row — and never reaches the create", async () => {
    getArtifactMock.mockReturnValue(null);
    const result = await requestArtifactPromotion(baseInput);
    expect(result).toEqual({
      ok: false,
      code: "not_found",
      message: expect.stringContaining("obj-1"),
    });
    expect(getArtifactMock).toHaveBeenCalledWith({
      artifactId: "obj-1",
      orgId: "org-1",
      actor,
    });
    expect(createRequestMock).not.toHaveBeenCalled();
  });

  it("forwards a visible row to the CAS-anchored create and returns its ok result", async () => {
    getArtifactMock.mockReturnValue({ id: "obj-1" });
    const request = { id: "req-1", objectId: "obj-1", status: "pending" };
    createRequestMock.mockResolvedValue({ ok: true, request });
    const result = await requestArtifactPromotion({
      ...baseInput,
      toVisibility: "team",
      targetTeamId: "team-9",
    });
    expect(result).toEqual({ ok: true, request });
    expect(createRequestMock).toHaveBeenCalledWith({
      orgId: "org-1",
      objectId: "obj-1",
      requestedBy: "u-requester",
      toVisibility: "team",
      targetTeamId: "team-9",
    });
  });

  it("omits targetTeamId from the create input when not provided (org target)", async () => {
    getArtifactMock.mockReturnValue({ id: "obj-1" });
    createRequestMock.mockResolvedValue({ ok: true, request: { id: "req-2" } });
    await requestArtifactPromotion(baseInput);
    expect(createRequestMock).toHaveBeenCalledWith({
      orgId: "org-1",
      objectId: "obj-1",
      requestedBy: "u-requester",
      toVisibility: "organization",
    });
  });

  it("forwards a data-layer business refusal (VALUE) untouched", async () => {
    getArtifactMock.mockReturnValue({ id: "obj-1" });
    const refusal = {
      ok: false,
      code: "conflict",
      message: "A pending promotion request already exists for artifact 'obj-1'.",
    };
    createRequestMock.mockResolvedValue(refusal);
    const result = await requestArtifactPromotion(baseInput);
    expect(result).toEqual(refusal);
  });
});
