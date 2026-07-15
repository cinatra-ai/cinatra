/**
 * Scope-leakage + gate-ordering guard for the MUTATING portlet actions
 * (edit-text, agent-launcher). Proves: the
 * actor is session-derived; the object.update gate runs BEFORE any effect and a
 * denied gate prevents the ref-swap; projectId/postId are derived from the
 * GATED parent object (server), never from the client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  enforceSpy: vi.fn(async () => undefined),
  getByIdSpy: vi.fn(() => ({
    id: "obj1",
    type: "blog-post",
    data: { projectId: "proj-from-obj", postId: "post-from-obj", body: "art-current" },
    orgId: "sess-org",
    ownerLevel: "organization",
    ownerId: "sess-org",
    visibility: "organization",
  })),
  getArtifactSpy: vi.fn(() => ({
    artifactId: "art-current",
    title: "Current",
    mime: "text/markdown",
    primaryExtension: "@cinatra-ai/blog-post-artifact",
    eligibleExtensions: [],
  })),
  authorSpy: vi.fn(async () => ({ ok: true, artifactId: "art-new", representationRevisionId: "rev-new", depth: 0, authoringStepId: "s1" })),
  blogUpdateSpy: vi.fn(async () => ({ ok: true })),
  agentRunSpy: vi.fn(async () => ({ runId: "run-1", status: "queued" })),
}));

vi.mock("@/lib/dashboards/portlet-authz", () => ({
  resolvePortletAuthz: vi.fn(async () => ({
    orgId: "sess-org",
    primitiveActor: { actorType: "human", source: "ui", userId: "u", orgId: "sess-org" },
    roleHints: { orgRole: "org_admin" },
    actorContext: { principalType: "HumanUser", principalId: "u", organizationId: "sess-org" },
  })),
  resolvePortletPrimitiveActor: vi.fn(async () => ({ actorType: "human", source: "ui", userId: "u", orgId: "sess-org" })),
  objectResourceCheck: (row: { id: string }) => ({ resourceType: "object", resourceId: row.id }),
}));
vi.mock("@/lib/objects-store", () => ({ getObjectById: h.getByIdSpy }));
vi.mock("@/lib/authz/enforce-resource-access", () => ({ enforceResourceAccess: h.enforceSpy }));
vi.mock("@/lib/artifacts/artifact-authoring", () => ({ authorArtifact: h.authorSpy }));
vi.mock("@/lib/artifacts/artifact-service", () => ({ getArtifact: h.getArtifactSpy }));
vi.mock("@/lib/blog/mcp/client/deterministic-client", () => ({
  createDeterministicBlogContentClient: () => ({ post: { update: h.blogUpdateSpy } }),
}));
vi.mock("@cinatra-ai/agents/mcp-client", () => ({
  createDeterministicAgentsClient: () => ({ agent: { run: h.agentRunSpy } }),
}));

import { editArtifactTextAction, launchAgentAction } from "../portlet-actions";

beforeEach(() => {
  for (const v of Object.values(h)) v.mockClear();
});

describe("editArtifactTextAction — gate before effect + server-derived refs", () => {
  it("authors then ref-swaps using projectId/postId DERIVED FROM THE OBJECT (not the client)", async () => {
    const res = await editArtifactTextAction({
      parentObjectId: "obj1",
      parentObjectField: "body",
      refSwapPrimitive: "blog_post_update",
      title: "T",
      content: "hello",
    });
    expect(res.ok).toBe(true);
    // object.update gate ran before authoring + swap
    expect(h.enforceSpy).toHaveBeenCalledWith(expect.anything(), expect.anything(), "object.update", expect.anything());
    // extension + mime derived from the CURRENT artifact (server), content from client
    expect(h.authorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "sess-org", extension: "@cinatra-ai/blog-post-artifact", declaredMime: "text/markdown", content: "hello" }),
    );
    // swap uses the object's projectId/postId, never a client value
    expect(h.blogUpdateSpy).toHaveBeenCalledWith({
      projectId: "proj-from-obj",
      postId: "post-from-obj",
      postArtifactId: "art-new",
      postRepresentationRevisionId: "rev-new",
    });
  });

  it("a DENIED object.update gate prevents authoring AND the ref-swap", async () => {
    h.enforceSpy.mockRejectedValueOnce(new Error("denied"));
    const res = await editArtifactTextAction({
      parentObjectId: "obj1",
      parentObjectField: "body",
      refSwapPrimitive: "blog_post_update",
      title: "T",
      content: "hello",
    });
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    expect(h.authorSpy).not.toHaveBeenCalled();
    expect(h.blogUpdateSpy).not.toHaveBeenCalled();
  });

  it("an unsupported refSwapPrimitive is rejected AFTER the gate, before any effect", async () => {
    const res = await editArtifactTextAction({
      parentObjectId: "obj1",
      parentObjectField: "body",
      refSwapPrimitive: "evil_primitive",
      title: "T",
      content: "hello",
    });
    expect(res).toMatchObject({ ok: false, code: "port_edit_text_unsupported_refswap" });
    expect(h.authorSpy).not.toHaveBeenCalled();
    expect(h.blogUpdateSpy).not.toHaveBeenCalled();
  });
});

describe("launchAgentAction — session actor", () => {
  it("runs the configured agent and returns the runId", async () => {
    const res = await launchAgentAction({ agentRef: "@cinatra-ai/blog-draft-writer-agent", inputParams: "{}" });
    expect(res).toMatchObject({ ok: true, runId: "run-1" });
    expect(h.agentRunSpy).toHaveBeenCalledWith({ packageName: "@cinatra-ai/blog-draft-writer-agent", inputParams: "{}" });
  });
});
