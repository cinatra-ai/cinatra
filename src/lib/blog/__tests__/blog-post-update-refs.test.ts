/**
 * blog_post_update refs-only path.
 * Asserts the full chain (handler → use-case → port → adapter → store):
 *   - refs-only input swaps refs via store.updateBlogPostDraftRefs (no re-materialize)
 *   - raw-content input re-materializes + store.updateBlogPostDraftContent
 *   - a MIXED input is rejected with blog_post_update_mixed_input
 */
import { describe, it, expect, vi } from "vitest";

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

describe("PORT-05 — blog_post_update refs-only", () => {
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
});
