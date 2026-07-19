// Host-side resolution of the `linkedin-post-draft-writer` capability
// (cinatra#1457): degraded mode (connector absent), a registered writer, the
// structural guard rejecting a malformed impl, and the `createLinkedinPostDraft`
// trigger forwarding the request.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  registerCapabilityProvider,
  __resetCapabilityRegistry,
} from "@/lib/extension-capabilities-registry";
import {
  LINKEDIN_POST_DRAFT_WRITER_CAPABILITY,
  resolveLinkedinPostDraftWriter,
  requireLinkedinPostDraftWriter,
  createLinkedinPostDraft,
  type LinkedinPostDraftWriteRequest,
  type LinkedinPostDraftWriteResult,
} from "@/lib/member-post-draft-writer-provider";

const REQUEST: LinkedinPostDraftWriteRequest = {
  content: "hello from a member draft",
  destination: { accountId: "acct-1", destinationType: "member", destinationId: "urn:li:person:abc" },
  orgId: "org-1",
  userId: "user-1",
};

const RESULT: LinkedinPostDraftWriteResult = {
  objectId: "obj-1",
  type: "@cinatra-ai/linkedin:post-draft",
  isNew: true,
  wasMerged: false,
  confidence: 1,
  changeSetId: "cs-1",
};

beforeEach(() => {
  __resetCapabilityRegistry();
});

describe("linkedin-post-draft-writer host resolver", () => {
  it("degraded mode: no provider → resolve returns null, require throws", () => {
    expect(resolveLinkedinPostDraftWriter()).toBeNull();
    expect(() => requireLinkedinPostDraftWriter()).toThrow(/not\s+installed\/active/i);
  });

  it("degraded mode: createLinkedinPostDraft returns null (best-effort) but throws when require:true", async () => {
    await expect(createLinkedinPostDraft(REQUEST)).resolves.toBeNull();
    await expect(createLinkedinPostDraft(REQUEST, { require: true })).rejects.toThrow(
      /not\s+installed\/active/i,
    );
  });

  it("resolves a registered writer and forwards the request through createLinkedinPostDraft", async () => {
    const writeDraft = vi.fn(async () => RESULT);
    registerCapabilityProvider(LINKEDIN_POST_DRAFT_WRITER_CAPABILITY, {
      packageName: "@cinatra-ai/linkedin-connector",
      impl: { writeDraft },
    });

    expect(resolveLinkedinPostDraftWriter()).not.toBeNull();
    await expect(createLinkedinPostDraft(REQUEST)).resolves.toEqual(RESULT);
    expect(writeDraft).toHaveBeenCalledTimes(1);
    expect(writeDraft).toHaveBeenCalledWith(REQUEST);
  });

  it("structural guard: an impl without writeDraft is not resolved (fail to null)", () => {
    registerCapabilityProvider(LINKEDIN_POST_DRAFT_WRITER_CAPABILITY, {
      packageName: "@cinatra-ai/linkedin-connector",
      impl: { notAWriter: true },
    });
    expect(resolveLinkedinPostDraftWriter()).toBeNull();
    expect(() => requireLinkedinPostDraftWriter()).toThrow();
  });
});
