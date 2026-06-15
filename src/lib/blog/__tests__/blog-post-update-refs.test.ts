/**
 * blog_post_update refs-only path.
 * Asserts the full chain (handler → use-case → port → adapter → store):
 *   - refs-only input swaps refs via store.updateBlogPostDraftRefs (no re-materialize)
 *   - raw-content input re-materializes + store.updateBlogPostDraftContent
 *   - a MIXED input is rejected with blog_post_update_mixed_input
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import * as updateSchemas from "../mcp/schemas";

vi.mock("../store", () => ({
  readBlogPostsProjects: vi.fn(),
  readBlogPostsProjectById: vi.fn(),
  readBlogPostDraftById: vi.fn(),
  readSavedMedia: vi.fn(),
  listAvailableTranscriptOptions: vi.fn(),
  saveBlogPostImageToMediaLibrary: vi.fn(),
  saveBlogPostPersonalSkillReference: vi.fn(),
  updateBlogPostDraftContent: vi.fn(),
  updateBlogPostDraftRefs: vi.fn(),
  updateLinkedInDraftReference: vi.fn(),
}));
vi.mock("../generation", () => ({
  startBlogPostIdeaGeneration: vi.fn(),
  stopBlogPostIdeaGeneration: vi.fn(),
  startBlogPostDraftGeneration: vi.fn(),
  stopBlogPostDraftGeneration: vi.fn(),
  startBlogPostImageRegeneration: vi.fn(),
  stopBlogPostImageRegeneration: vi.fn(),
  startWordPressDraftCreation: vi.fn(),
  stopWordPressDraftCreation: vi.fn(),
  deleteWordPressDraft: vi.fn(),
  refreshWordPressDraftStatus: vi.fn(),
  startLinkedInDraftCreation: vi.fn(),
  stopLinkedInDraftGeneration: vi.fn(),
  publishLinkedInDraft: vi.fn(),
}));
vi.mock("@/lib/blog-post-artifact-materializer", () => ({
  materializeBlogPostBodyArtifact: vi.fn(async () => ({ artifactId: "art-new", representationRevisionId: "rev-new" })),
}));

import { createBlogDraftGenerationPort } from "../integration/blog-content-adapters";
import { createBlogContentPrimitiveHandlers } from "../mcp/handlers";
import * as store from "../store";
import { materializeBlogPostBodyArtifact } from "@/lib/blog-post-artifact-materializer";

const handlers = createBlogContentPrimitiveHandlers();
const call = (input: unknown) => handlers["blog_post_update"]({ input } as never);

describe("blog_post_update refs-only", () => {
  it("adapter.updateDraftRefs swaps refs via store.updateBlogPostDraftRefs", async () => {
    const port = createBlogDraftGenerationPort();
    await port.updateDraftRefs({ projectId: "p", postId: "po", postArtifactId: "a1", postRepresentationRevisionId: "r1" });
    expect(store.updateBlogPostDraftRefs).toHaveBeenCalledWith({
      projectId: "p",
      postId: "po",
      postArtifactId: "a1",
      postRepresentationRevisionId: "r1",
    });
  });

  it("handler: refs-only input → updateBlogPostDraftRefs (no re-materialize)", async () => {
    vi.mocked(store.updateBlogPostDraftRefs).mockClear();
    vi.mocked(store.updateBlogPostDraftContent).mockClear();
    vi.mocked(materializeBlogPostBodyArtifact).mockClear();
    const res = await call({ projectId: "p", postId: "po", postArtifactId: "a2", postRepresentationRevisionId: "r2" });
    expect(res).toEqual({ ok: true });
    expect(store.updateBlogPostDraftRefs).toHaveBeenCalledTimes(1);
    expect(store.updateBlogPostDraftContent).not.toHaveBeenCalled();
    expect(materializeBlogPostBodyArtifact).not.toHaveBeenCalled();
  });

  it("handler: raw-content input → re-materialize + updateBlogPostDraftContent", async () => {
    vi.mocked(store.updateBlogPostDraftRefs).mockClear();
    vi.mocked(store.updateBlogPostDraftContent).mockClear();
    vi.mocked(materializeBlogPostBodyArtifact).mockClear();
    const res = await call({ projectId: "p", postId: "po", title: "T", excerpt: "E", content: "C" });
    expect(res).toEqual({ ok: true });
    expect(materializeBlogPostBodyArtifact).toHaveBeenCalledTimes(1);
    expect(store.updateBlogPostDraftContent).toHaveBeenCalledTimes(1);
    expect(store.updateBlogPostDraftRefs).not.toHaveBeenCalled();
  });

  it("handler: MIXED input → blog_post_update_mixed_input, neither writer called", async () => {
    vi.mocked(store.updateBlogPostDraftRefs).mockClear();
    vi.mocked(store.updateBlogPostDraftContent).mockClear();
    const res = (await call({ projectId: "p", postId: "po", content: "C", postArtifactId: "a3", postRepresentationRevisionId: "r3" })) as Record<string, unknown>;
    expect(res.code).toBe("blog_post_update_mixed_input");
    expect(store.updateBlogPostDraftRefs).not.toHaveBeenCalled();
    expect(store.updateBlogPostDraftContent).not.toHaveBeenCalled();
  });

  // cinatra#246 hardening: the advertised flat schema (no top-level anyOf) widened
  // the accepted input, so the handler must discriminate by ANY field in either
  // family — a mix that OMITS postArtifactId must still be rejected, never silently
  // routed to the content branch (which would strip the ref). These fail under the
  // old postArtifactId-only guard.
  it("handler: MIXED via content + imageArtifactId (no postArtifactId) → mixed_input, neither writer called", async () => {
    vi.mocked(store.updateBlogPostDraftRefs).mockClear();
    vi.mocked(store.updateBlogPostDraftContent).mockClear();
    const res = (await call({ projectId: "p", postId: "po", content: "C", imageArtifactId: "img1" })) as Record<string, unknown>;
    expect(res.code).toBe("blog_post_update_mixed_input");
    expect(store.updateBlogPostDraftRefs).not.toHaveBeenCalled();
    expect(store.updateBlogPostDraftContent).not.toHaveBeenCalled();
  });

  it("handler: MIXED via title + postRepresentationRevisionId (no postArtifactId) → mixed_input, neither writer called", async () => {
    vi.mocked(store.updateBlogPostDraftRefs).mockClear();
    vi.mocked(store.updateBlogPostDraftContent).mockClear();
    const res = (await call({ projectId: "p", postId: "po", title: "T", postRepresentationRevisionId: "r9" })) as Record<string, unknown>;
    expect(res.code).toBe("blog_post_update_mixed_input");
    expect(store.updateBlogPostDraftRefs).not.toHaveBeenCalled();
    expect(store.updateBlogPostDraftContent).not.toHaveBeenCalled();
  });
});

describe("blog_post_update advertised tool schema (cinatra#246 regression)", () => {
  it("is a flat ZodObject, not a top-level union (z.union → top-level anyOf, which OpenAI's Responses API rejects)", () => {
    expect(updateSchemas.blogPostUpdateToolSchema).toBeInstanceOf(z.ZodObject);
    expect(updateSchemas.blogPostUpdateToolSchema).not.toBeInstanceOf(z.ZodUnion);
  });

  it("covers both shapes' fields so neither client shape is unrepresentable", () => {
    const shape = (updateSchemas.blogPostUpdateToolSchema as z.ZodObject<z.ZodRawShape>).shape;
    for (const f of ["projectId", "postId", "title", "excerpt", "content", "postArtifactId", "postRepresentationRevisionId", "imageArtifactId", "imageRepresentationRevisionId"]) {
      expect(Object.keys(shape)).toContain(f);
    }
  });
});
