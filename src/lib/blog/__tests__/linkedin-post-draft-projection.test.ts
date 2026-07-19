// The typed `@cinatra-ai/linkedin:post-draft` projection at the LinkedIn
// publish-prep call-site (cinatra#1457): member-only gating, org-required skip,
// deterministic (colon-free) identity, best-effort/never-throw degradation when
// the linkedin-connector writer is absent, and request forwarding.

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  projectLinkedinMemberPostDraft,
  blogLinkedinDraftRunScopeId,
  type ProjectLinkedinMemberPostDraftInput,
} from "@/lib/blog/member-post-draft-projection";
import type {
  LinkedinPostDraftWriteRequest,
  LinkedinPostDraftWriteResult,
} from "@/lib/member-post-draft-writer-provider";

const RESULT: LinkedinPostDraftWriteResult = {
  objectId: "obj-1",
  type: "@cinatra-ai/linkedin:post-draft",
  isNew: true,
  wasMerged: false,
  confidence: 1,
  changeSetId: "cs-1",
};

function baseInput(
  over: Partial<ProjectLinkedinMemberPostDraftInput> = {},
): ProjectLinkedinMemberPostDraftInput {
  return {
    projectId: "proj-1",
    postId: "post-1",
    draftId: "draft-1",
    orgId: "org-1",
    userId: "user-1",
    destinationType: "member",
    accountId: "acct-1",
    destinationId: "urn:li:person:abc",
    content: "hello from a member draft",
    ...over,
  };
}

describe("blogLinkedinDraftRunScopeId", () => {
  it("is deterministic and colon-free (composes unambiguously with destinationId)", () => {
    const id = blogLinkedinDraftRunScopeId({ projectId: "p", postId: "o", draftId: "d" });
    expect(id).toBe("blog-linkedin-p-o-d");
    expect(id).not.toContain(":");
    // Stable across calls — a retry re-derives the same identity.
    expect(blogLinkedinDraftRunScopeId({ projectId: "p", postId: "o", draftId: "d" })).toBe(id);
  });
});

describe("projectLinkedinMemberPostDraft", () => {
  it("materializes a member draft and forwards a deterministic runId + member destination", async () => {
    const seen: LinkedinPostDraftWriteRequest[] = [];
    const create = vi.fn(
      async (req: LinkedinPostDraftWriteRequest, _opts?: { require?: boolean }) => {
        seen.push(req);
        return RESULT;
      },
    );

    const outcome = await projectLinkedinMemberPostDraft(baseInput(), { create });

    expect(outcome).toEqual({ status: "materialized", objectId: "obj-1", isNew: true });
    expect(create).toHaveBeenCalledTimes(1);
    // require:true — the call-site must not silently no-op when the writer is absent.
    expect(create.mock.calls[0][1]).toEqual({ require: true });
    const req = seen[0];
    expect(req.runId).toBe("blog-linkedin-proj-1-post-1-draft-1");
    expect(req.destination).toEqual({
      accountId: "acct-1",
      destinationType: "member",
      destinationId: "urn:li:person:abc",
    });
    expect(req.orgId).toBe("org-1");
    expect(req.userId).toBe("user-1");
    expect(req.content).toBe("hello from a member draft");
  });

  it("passes visibility and media asset refs through only when present", async () => {
    const create = vi.fn(
      async (_req: LinkedinPostDraftWriteRequest, _opts?: { require?: boolean }) => RESULT,
    );
    await projectLinkedinMemberPostDraft(
      baseInput({ visibility: "CONNECTIONS", mediaAssetRefs: ["urn:li:image:1"] }),
      { create },
    );
    const req = create.mock.calls[0][0];
    expect(req.visibility).toBe("CONNECTIONS");
    expect(req.mediaAssetRefs).toEqual(["urn:li:image:1"]);

    const create2 = vi.fn(
      async (_req: LinkedinPostDraftWriteRequest, _opts?: { require?: boolean }) => RESULT,
    );
    await projectLinkedinMemberPostDraft(baseInput(), { create: create2 });
    const req2 = create2.mock.calls[0][0];
    expect("visibility" in req2).toBe(false);
    expect("mediaAssetRefs" in req2).toBe(false);
  });

  it("SKIPS an organization-page draft without calling the writer (criterion d — org-page is #1767)", async () => {
    const create = vi.fn(async () => RESULT);
    const outcome = await projectLinkedinMemberPostDraft(
      baseInput({ destinationType: "organization" }),
      { create },
    );
    expect(outcome.status).toBe("skipped");
    expect(create).not.toHaveBeenCalled();
  });

  it("SKIPS when there is no org in the actor frame (never a null-org write)", async () => {
    const create = vi.fn(async () => RESULT);
    const outcome = await projectLinkedinMemberPostDraft(baseInput({ orgId: null }), { create });
    expect(outcome.status).toBe("skipped");
    expect(create).not.toHaveBeenCalled();
  });

  it("SKIPS when the draft is missing a resolved account or destination", async () => {
    const create = vi.fn(async () => RESULT);
    expect((await projectLinkedinMemberPostDraft(baseInput({ accountId: "" }), { create })).status).toBe("skipped");
    expect((await projectLinkedinMemberPostDraft(baseInput({ destinationId: "  " }), { create })).status).toBe("skipped");
    expect(create).not.toHaveBeenCalled();
  });

  it("degrades (never throws) and carries the actionable message when the writer is absent", async () => {
    const create = vi.fn(async () => {
      throw new Error(
        "LinkedIn post-draft writer unavailable — the linkedin-connector extension is not installed/active.",
      );
    });
    const outcome = await projectLinkedinMemberPostDraft(baseInput(), { create });
    expect(outcome.status).toBe("degraded");
    if (outcome.status === "degraded") {
      expect(outcome.message).toContain("linkedin-connector");
    }
  });

  it("degrades rather than throwing when the writer defensively returns null", async () => {
    const create = vi.fn(async () => null);
    const outcome = await projectLinkedinMemberPostDraft(baseInput(), { create });
    expect(outcome.status).toBe("degraded");
  });
});
