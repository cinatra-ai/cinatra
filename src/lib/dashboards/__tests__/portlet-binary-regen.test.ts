/**
 * Guards for the artifact-edit-binary-prompt portlet surfaces (issue #86).
 *
 * Proves, mirroring portlet-actions-scope.test.ts:
 *  - gate-before-effect: a denied object.update prevents every primitive call;
 *  - projectId/postId derive from the GATED object (canonical `data.id`
 *    fallback AND explicit `data.postId`), never from the client;
 *  - the config primitive names pass a server-side allow-list (start→cancel
 *    pairing map; refSwap allow-list);
 *  - the project-SINGLETON pipeline guards: start refuses while another post's
 *    job is actively running (stale rows self-heal), cancel only ever stops a
 *    run that belongs to THIS post;
 *  - manual-mode swap re-validates the client-supplied pair (session-gated
 *    artifact read, image/* mime, revision↔artifact resolution) and reads the
 *    post-body refs from the gated object;
 *  - the status loader returns a MINIMAL post-scoped DTO (canned messages
 *    only; no jobId/postTitle/raw pipeline text; foreign runs surface only as
 *    busyWithOtherPost);
 *  - the baseline loader mints previewHref only for preview-inline MIMEs and
 *    prefers the object's PAIRED revision ref over the artifact's latest.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const RAW_PIPELINE_MESSAGE = "provider exploded: secret-internal-details";

const h = vi.hoisted(() => {
  const canonicalRow = () => ({
    id: "obj1",
    type: "@cinatra-ai/assets:blog-post",
    // Canonical decomposed blog-post row: `id` + `projectId`, NO `postId`.
    data: {
      id: "post-1",
      projectId: "proj-1",
      title: "Post",
      postArtifactId: "post-art",
      postRepresentationRevisionId: "post-rev",
      imageArtifactId: "img-old",
      imageRepresentationRevisionId: "img-rev-old",
    },
    orgId: "sess-org",
    ownerLevel: "organization",
    ownerId: "sess-org",
    visibility: "organization",
  });
  const project = (imageGeneration: Record<string, unknown>) => ({
    id: "proj-1",
    posts: [{ id: "post-1" }, { id: "post-2" }],
    imageGeneration,
  });
  return {
    canonicalRow,
    project,
    enforceSpy: vi.fn(async () => undefined),
    getByIdSpy: vi.fn(canonicalRow),
    readProjectSpy: vi.fn(async () => project({ status: "idle", message: "", updatedAt: "t0" })),
    jobActiveSpy: vi.fn(async () => true),
    getArtifactSpy: vi.fn(() => ({
      artifactId: "img-old",
      title: "Old image",
      mime: "image/png",
      size: 10,
      latestRepresentationRevisionId: "img-rev-latest",
      primaryExtension: "@cinatra-ai/blog-image-artifact",
      eligibleExtensions: [],
    })),
    resolveServeSpy: vi.fn(() => ({ storageKey: "k", mime: "image/png", sizeBytes: 1, originKind: "upload" })),
    isPreviewInlineMimeSpy: vi.fn((mime: string) => mime === "image/png"),
    startSpy: vi.fn(async () => ({ status: "running" })),
    cancelSpy: vi.fn(async () => ({ status: "stopped" })),
    postUpdateSpy: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("@/lib/dashboards/portlet-authz", () => ({
  resolvePortletAuthz: vi.fn(async () => ({
    orgId: "sess-org",
    primitiveActor: { actorType: "human", source: "ui", userId: "u", orgId: "sess-org" },
    roleHints: { orgRole: "org_admin" },
    actorContext: { principalType: "HumanUser", principalId: "u", organizationId: "sess-org" },
  })),
  resolvePortletPrimitiveActor: vi.fn(async () => ({ actorType: "human", source: "ui", userId: "u", orgId: "sess-org" })),
  objectResourceCheck: (row: { id: string }) => ({ resourceType: "object", resourceId: row.id }),
  canReadObject: vi.fn(async () => true),
}));
vi.mock("@/lib/objects-store", () => ({ getObjectById: h.getByIdSpy, listObjectsByFilter: vi.fn(() => []) }));
vi.mock("@/lib/authz/enforce-resource-access", () => ({ enforceResourceAccess: h.enforceSpy }));
vi.mock("@/lib/artifacts/artifact-service", () => ({ getArtifact: h.getArtifactSpy, listArtifacts: vi.fn(() => []) }));
vi.mock("@/lib/artifacts/artifact-read", () => ({
  resolveArtifactVersionForServe: h.resolveServeSpy,
  isPreviewInlineMime: h.isPreviewInlineMimeSpy,
}));
vi.mock("@/lib/artifacts/artifact-authoring", () => ({ authorArtifact: vi.fn() }));
vi.mock("@/lib/blog/store", () => ({ readBlogPostsProjectById: h.readProjectSpy }));
vi.mock("@/lib/background-jobs", () => ({ isBackgroundJobActive: h.jobActiveSpy }));
vi.mock("@/lib/object-history/eligibility", () => ({ listEventsForObject: vi.fn(() => []) }));
vi.mock("@cinatra-ai/workflows/store", () => ({ readWorkflow: vi.fn(), listWorkflows: vi.fn(() => []) }));
vi.mock("@/lib/blog/mcp/client/deterministic-client", () => ({
  createDeterministicBlogContentClient: () => ({
    image: { startRegeneration: h.startSpy, cancelRegeneration: h.cancelSpy },
    post: { update: h.postUpdateSpy },
  }),
}));
vi.mock("@cinatra-ai/agents/mcp-client", () => ({ createDeterministicAgentsClient: () => ({}) }));
vi.mock("@cinatra-ai/workflows/mcp-client", () => ({ createDeterministicWorkflowsClient: () => ({}) }));
vi.mock("@/lib/workflow-host-deps", () => ({ buildWorkflowHandlerDeps: () => ({}) }));

import {
  startBinaryRegenerationAction,
  cancelBinaryRegenerationAction,
  applyBinaryRefSwapAction,
} from "../portlet-actions";
import { loadArtifactBaselinePortlet, loadBinaryGenerationStatusPortlet } from "../portlet-loaders";

beforeEach(() => {
  h.enforceSpy.mockClear().mockImplementation(async () => undefined);
  h.getByIdSpy.mockClear().mockImplementation(h.canonicalRow);
  h.readProjectSpy
    .mockClear()
    .mockImplementation(async () => h.project({ status: "idle", message: "", updatedAt: "t0" }));
  h.jobActiveSpy.mockClear().mockImplementation(async () => true);
  h.getArtifactSpy.mockClear();
  h.resolveServeSpy.mockClear();
  h.isPreviewInlineMimeSpy.mockClear();
  h.startSpy.mockClear();
  h.cancelSpy.mockClear();
  h.postUpdateSpy.mockClear();
});

describe("startBinaryRegenerationAction", () => {
  it("derives projectId/postId from the GATED object via the canonical data.id fallback", async () => {
    const res = await startBinaryRegenerationAction({
      parentObjectId: "obj1",
      generationPrimitive: "blog_image_generate_start",
      prompt: "  make it blue  ",
    });
    expect(res.ok).toBe(true);
    expect(h.startSpy).toHaveBeenCalledWith({ projectId: "proj-1", postId: "post-1", prompt: "make it blue" });
  });

  it("prefers an explicit data.postId over data.id when present", async () => {
    h.getByIdSpy.mockImplementationOnce(() => {
      const row = h.canonicalRow();
      return { ...row, data: { ...row.data, postId: "post-2" } };
    });
    await startBinaryRegenerationAction({ parentObjectId: "obj1", generationPrimitive: "blog_image_generate_start" });
    expect(h.startSpy).toHaveBeenCalledWith(expect.objectContaining({ postId: "post-2" }));
  });

  it("denied object.update gate prevents the start invocation", async () => {
    h.enforceSpy.mockImplementationOnce(async () => {
      throw new Error("denied");
    });
    const res = await startBinaryRegenerationAction({
      parentObjectId: "obj1",
      generationPrimitive: "blog_image_generate_start",
    });
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    expect(h.startSpy).not.toHaveBeenCalled();
  });

  it("rejects a generationPrimitive outside the allow-list before any read", async () => {
    const res = await startBinaryRegenerationAction({ parentObjectId: "obj1", generationPrimitive: "rm_rf_everything" });
    expect(res).toMatchObject({ ok: false, code: "port_edit_binary_unsupported_primitive" });
    expect(h.getByIdSpy).not.toHaveBeenCalled();
    expect(h.startSpy).not.toHaveBeenCalled();
  });

  it("caps the prompt length server-side", async () => {
    const res = await startBinaryRegenerationAction({
      parentObjectId: "obj1",
      generationPrimitive: "blog_image_generate_start",
      prompt: "x".repeat(2001),
    });
    expect(res).toMatchObject({ ok: false, code: "port_edit_binary_prompt_too_long" });
    expect(h.startSpy).not.toHaveBeenCalled();
  });

  it("refuses while ANOTHER post's job is actively running (project singleton)", async () => {
    h.readProjectSpy.mockImplementation(async () =>
      h.project({ status: "running", postId: "post-2", jobId: "job-9", message: "", updatedAt: "t1" }),
    );
    const res = await startBinaryRegenerationAction({
      parentObjectId: "obj1",
      generationPrimitive: "blog_image_generate_start",
    });
    expect(res).toMatchObject({ ok: false, code: "port_edit_binary_busy" });
    expect(h.startSpy).not.toHaveBeenCalled();
  });

  it("proceeds past a STALE foreign running row (job no longer active — primitive self-heals)", async () => {
    h.readProjectSpy.mockImplementation(async () =>
      h.project({ status: "running", postId: "post-2", jobId: "job-9", message: "", updatedAt: "t1" }),
    );
    h.jobActiveSpy.mockImplementation(async () => false);
    const res = await startBinaryRegenerationAction({
      parentObjectId: "obj1",
      generationPrimitive: "blog_image_generate_start",
    });
    expect(res.ok).toBe(true);
    expect(h.startSpy).toHaveBeenCalledTimes(1);
  });

  it("rejects when the derived post is not a member of the derived project", async () => {
    h.readProjectSpy.mockImplementation(async () => ({ id: "proj-1", posts: [{ id: "someone-else" }], imageGeneration: { status: "idle" } }));
    const res = await startBinaryRegenerationAction({
      parentObjectId: "obj1",
      generationPrimitive: "blog_image_generate_start",
    });
    expect(res).toMatchObject({ ok: false, code: "not_found" });
    expect(h.startSpy).not.toHaveBeenCalled();
  });
});

describe("cancelBinaryRegenerationAction — singleton ownership guard", () => {
  it("cancels only a run that belongs to THIS post", async () => {
    h.readProjectSpy.mockImplementation(async () =>
      h.project({ status: "running", postId: "post-1", jobId: "job-1", message: "", updatedAt: "t1" }),
    );
    const res = await cancelBinaryRegenerationAction({
      parentObjectId: "obj1",
      generationPrimitive: "blog_image_generate_start",
    });
    expect(res.ok).toBe(true);
    expect(h.cancelSpy).toHaveBeenCalledWith("proj-1");
  });

  it("refuses to cancel another post's run", async () => {
    h.readProjectSpy.mockImplementation(async () =>
      h.project({ status: "running", postId: "post-2", jobId: "job-1", message: "", updatedAt: "t1" }),
    );
    const res = await cancelBinaryRegenerationAction({
      parentObjectId: "obj1",
      generationPrimitive: "blog_image_generate_start",
    });
    expect(res).toMatchObject({ ok: false, code: "port_edit_binary_not_cancelable" });
    expect(h.cancelSpy).not.toHaveBeenCalled();
  });

  it("refuses when nothing is running", async () => {
    const res = await cancelBinaryRegenerationAction({
      parentObjectId: "obj1",
      generationPrimitive: "blog_image_generate_start",
    });
    expect(res).toMatchObject({ ok: false, code: "port_edit_binary_not_cancelable" });
    expect(h.cancelSpy).not.toHaveBeenCalled();
  });
});

describe("applyBinaryRefSwapAction — manual-mode revert validation", () => {
  const args = {
    parentObjectId: "obj1",
    refSwapPrimitive: "blog_post_update",
    imageArtifactId: "img-old",
    imageRepresentationRevisionId: "img-rev-old",
  };

  it("swaps with object-derived post refs + the validated client pair", async () => {
    const res = await applyBinaryRefSwapAction(args);
    expect(res.ok).toBe(true);
    expect(h.resolveServeSpy).toHaveBeenCalledWith({
      orgId: "sess-org",
      artifactId: "img-old",
      representationRevisionId: "img-rev-old",
      liveOnly: true,
    });
    expect(h.postUpdateSpy).toHaveBeenCalledWith({
      projectId: "proj-1",
      postId: "post-1",
      postArtifactId: "post-art",
      postRepresentationRevisionId: "post-rev",
      imageArtifactId: "img-old",
      imageRepresentationRevisionId: "img-rev-old",
    });
  });

  it("rejects a refSwapPrimitive outside the allow-list", async () => {
    const res = await applyBinaryRefSwapAction({ ...args, refSwapPrimitive: "objects_delete" });
    expect(res).toMatchObject({ ok: false, code: "port_edit_binary_unsupported_refswap" });
    expect(h.postUpdateSpy).not.toHaveBeenCalled();
  });

  it("rejects an artifact the session cannot read", async () => {
    h.getArtifactSpy.mockImplementationOnce(() => null as never);
    const res = await applyBinaryRefSwapAction(args);
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    expect(h.postUpdateSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-image artifact", async () => {
    h.getArtifactSpy.mockImplementationOnce(() => ({ ...h.getArtifactSpy(), mime: "application/pdf" }) as never);
    const res = await applyBinaryRefSwapAction(args);
    expect(res).toMatchObject({ ok: false, code: "port_edit_binary_not_image" });
    expect(h.postUpdateSpy).not.toHaveBeenCalled();
  });

  it("rejects a revision that does not resolve for the artifact in this org", async () => {
    h.resolveServeSpy.mockImplementationOnce(() => null as never);
    const res = await applyBinaryRefSwapAction(args);
    expect(res).toMatchObject({ ok: false, code: "port_edit_binary_bad_revision" });
    expect(h.postUpdateSpy).not.toHaveBeenCalled();
  });

  it("rejects when the gated object is missing its post body refs (required by the refs-shape update)", async () => {
    h.getByIdSpy.mockImplementationOnce(() => {
      const row = h.canonicalRow();
      const data: Record<string, unknown> = { ...row.data };
      delete data.postArtifactId;
      delete data.postRepresentationRevisionId;
      return { ...row, data } as never;
    });
    const res = await applyBinaryRefSwapAction(args);
    expect(res).toMatchObject({ ok: false, code: "port_edit_binary_object_missing_refs" });
    expect(h.postUpdateSpy).not.toHaveBeenCalled();
  });
});

describe("loadBinaryGenerationStatusPortlet — minimal post-scoped DTO", () => {
  it("returns null when the read gate denies", async () => {
    h.enforceSpy.mockImplementationOnce(async () => {
      throw new Error("denied");
    });
    const res = await loadBinaryGenerationStatusPortlet({ objectId: "obj1", generationPrimitive: "blog_image_generate_start" });
    expect(res).toBeNull();
  });

  it("returns null for a generationPrimitive outside the allow-list (no store read)", async () => {
    const res = await loadBinaryGenerationStatusPortlet({ objectId: "obj1", generationPrimitive: "nope" });
    expect(res).toBeNull();
    expect(h.readProjectSpy).not.toHaveBeenCalled();
  });

  it("replaces raw pipeline text with canned messages and strips jobId/postTitle", async () => {
    h.readProjectSpy.mockImplementation(async () =>
      h.project({ status: "failed", postId: "post-1", postTitle: "Post", jobId: "job-1", message: RAW_PIPELINE_MESSAGE, updatedAt: "t2" }),
    );
    const res = await loadBinaryGenerationStatusPortlet({ objectId: "obj1", generationPrimitive: "blog_image_generate_start" });
    expect(res).toEqual({ status: "failed", message: "Image generation failed.", updatedAt: "t2", busyWithOtherPost: false });
    expect(JSON.stringify(res)).not.toContain("secret-internal-details");
    expect(JSON.stringify(res)).not.toContain("job-1");
  });

  it("surfaces a foreign post's RUNNING state only as busyWithOtherPost", async () => {
    h.readProjectSpy.mockImplementation(async () =>
      h.project({ status: "running", postId: "post-2", postTitle: "Other", jobId: "job-9", message: RAW_PIPELINE_MESSAGE, updatedAt: "t3" }),
    );
    const res = await loadBinaryGenerationStatusPortlet({ objectId: "obj1", generationPrimitive: "blog_image_generate_start" });
    expect(res).toEqual({ status: "idle", message: "", updatedAt: null, busyWithOtherPost: true });
  });

  it("does NOT report busy for a STALE foreign running row (job gone — start self-heals)", async () => {
    h.readProjectSpy.mockImplementation(async () =>
      h.project({ status: "running", postId: "post-2", jobId: "job-9", message: "", updatedAt: "t3" }),
    );
    h.jobActiveSpy.mockImplementation(async () => false);
    const res = await loadBinaryGenerationStatusPortlet({ objectId: "obj1", generationPrimitive: "blog_image_generate_start" });
    expect(res).toEqual({ status: "idle", message: "", updatedAt: null, busyWithOtherPost: false });
  });

  it("suppresses a foreign post's terminal state entirely", async () => {
    h.readProjectSpy.mockImplementation(async () =>
      h.project({ status: "failed", postId: "post-2", message: RAW_PIPELINE_MESSAGE, updatedAt: "t4" }),
    );
    const res = await loadBinaryGenerationStatusPortlet({ objectId: "obj1", generationPrimitive: "blog_image_generate_start" });
    expect(res).toEqual({ status: "idle", message: "", updatedAt: null, busyWithOtherPost: false });
  });
});

describe("loadArtifactBaselinePortlet — preview-safe href minting", () => {
  it("mints previewHref from the object's PAIRED revision ref for allowlisted MIMEs", async () => {
    const res = await loadArtifactBaselinePortlet({ objectId: "obj1", parentObjectField: "imageArtifactId" });
    expect(res).toMatchObject({
      artifactId: "img-old",
      mime: "image/png",
      representationRevisionId: "img-rev-old",
      previewHref: "/api/artifacts/img-old/versions/img-rev-old/preview",
    });
  });

  it("falls back to the artifact's latest revision when the object has no paired ref", async () => {
    h.getByIdSpy.mockImplementationOnce(() => {
      const row = h.canonicalRow();
      const data: Record<string, unknown> = { ...row.data };
      delete data.imageRepresentationRevisionId;
      return { ...row, data } as never;
    });
    const res = await loadArtifactBaselinePortlet({ objectId: "obj1", parentObjectField: "imageArtifactId" });
    expect(res?.previewHref).toBe("/api/artifacts/img-old/versions/img-rev-latest/preview");
  });

  it("withholds previewHref for non-allowlisted MIMEs", async () => {
    h.getArtifactSpy.mockImplementationOnce(() => ({ ...h.getArtifactSpy(), mime: "image/bmp" }) as never);
    const res = await loadArtifactBaselinePortlet({ objectId: "obj1", parentObjectField: "imageArtifactId" });
    expect(res?.previewHref).toBeNull();
    expect(res?.mime).toBe("image/bmp");
  });
});
