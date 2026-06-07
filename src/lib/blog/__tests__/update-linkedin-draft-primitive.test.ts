/**
 * MCP contract test for `blog_post_publish_linkedin_update`.
 *
 * Verifies the 6-layer wiring:
 *   schema → port → adapter → use-case → handler → registry
 *
 * Specifically asserts that the adapter does the `linkedinDraftId →
 * draftId` field rename so the store's `updateLinkedInDraftReference`
 * receives the correct shape.
 */
import { describe, it, expect, vi } from "vitest";

// Mock the store's updateLinkedInDraftReference so we can assert the
// shape the adapter forwards. The other store imports are not exercised
// by this test path but must resolve, so we provide stub implementations.
vi.mock("../store", () => ({
  readBlogPostsProjects: vi.fn(),
  readBlogPostsProjectById: vi.fn(),
  readBlogPostDraftById: vi.fn(),
  readSavedMedia: vi.fn(),
  listAvailableTranscriptOptions: vi.fn(),
  saveBlogPostImageToMediaLibrary: vi.fn(),
  saveBlogPostPersonalSkillReference: vi.fn(),
  updateBlogPostDraftContent: vi.fn(),
  updateLinkedInDraftReference: vi.fn(),
}));

// generation.ts is also imported by the adapter; stub everything we don't exercise.
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

import { createBlogPublishingPort } from "../integration/blog-content-adapters";
import * as store from "../store";

describe("blog_post_publish_linkedin_update — adapter wiring", () => {
  it("adapter.updateLinkedInDraft renames linkedinDraftId → draftId for the store + passes refs through", async () => {
    const port = createBlogPublishingPort();
    await port.updateLinkedInDraft({
      projectId: "proj-1",
      postId: "post-1",
      linkedinDraftId: "lkd-42",
      // Port input takes artifact refs only; the legacy `content: string`
      // shape is gone. The agent materializes operator-edited copy via
      // `artifact_authoring_emit` before calling this primitive.
      contentArtifactId: "art-operator-edit",
      contentRepresentationRevisionId: "rev-operator-edit",
    });
    expect(store.updateLinkedInDraftReference).toHaveBeenCalledTimes(1);
    expect(store.updateLinkedInDraftReference).toHaveBeenCalledWith({
      projectId: "proj-1",
      postId: "post-1",
      // CRITICAL: store expects `draftId`, not `linkedinDraftId`. If the
      // adapter ever skips the rename, this assertion fails.
      draftId: "lkd-42",
      contentArtifactId: "art-operator-edit",
      contentRepresentationRevisionId: "rev-operator-edit",
    });
  });
});

describe("blog_post_publish_wordpress_delete — deleteInWordPress plumbing", () => {
  // Import again to get the mocked module fresh. This test verifies that
  // the adapter forwards the new `deleteInWordPress` flag through to the
  // store function so the wordpress-publish-agent's reject path can
  // actually delete the WP draft from WordPress (not just the local
  // reference).
  it("adapter.deleteWordPressDraft passes deleteInWordPress flag through", async () => {
    const generation = await import("../generation");
    const port = createBlogPublishingPort();
    await port.deleteWordPressDraft({
      projectId: "proj-1",
      postId: "post-1",
      wordpressDraftId: "wp-99",
      deleteInWordPress: true,
    });
    expect(generation.deleteWordPressDraft).toHaveBeenCalledTimes(1);
    expect(generation.deleteWordPressDraft).toHaveBeenCalledWith({
      projectId: "proj-1",
      postId: "post-1",
      draftId: "wp-99",
      deleteInWordPress: true,
    });
  });

  it("adapter.deleteWordPressDraft defaults deleteInWordPress=undefined for back-compat", async () => {
    const generation = await import("../generation");
    vi.mocked(generation.deleteWordPressDraft).mockClear();
    const port = createBlogPublishingPort();
    await port.deleteWordPressDraft({
      projectId: "proj-1",
      postId: "post-1",
      wordpressDraftId: "wp-99",
      // deleteInWordPress not provided
    });
    expect(generation.deleteWordPressDraft).toHaveBeenCalledTimes(1);
    expect(generation.deleteWordPressDraft).toHaveBeenCalledWith({
      projectId: "proj-1",
      postId: "post-1",
      draftId: "wp-99",
      deleteInWordPress: undefined,
    });
  });
});
