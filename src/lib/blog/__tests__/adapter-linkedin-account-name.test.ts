/**
 * Adapter must forward `linkedinAccountName` from the caller instead of
 * hardcoding "".
 *
 * The adapter must not spread `...input` and then override
 * `linkedinAccountName: ""`; doing so silently drops the operator-supplied
 * value. The HITL renderer payload, persisted draft entry, and notifications
 * all require the supplied account name.
 *
 * This test asserts the adapter's transparent pass-through using a known
 * account name.
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

import { createBlogPublishingPort } from "../integration/blog-content-adapters";

describe("blog_post_publish_linkedin_start — linkedinAccountName plumbing", () => {
  it("adapter.startLinkedInDraftCreation forwards operator-supplied linkedinAccountName", async () => {
    const generation = await import("../generation");
    vi.mocked(generation.startLinkedInDraftCreation).mockClear();
    const port = createBlogPublishingPort();
    await port.startLinkedInDraftCreation({
      projectId: "proj-1",
      postId: "post-1",
      linkedinAccountId: "li-acc-7",
      // CRITICAL: the adapter must not overwrite this with "" via
      // `{ ...input, linkedinAccountName: "" }`.
      linkedinAccountName: "Acme Corp LinkedIn",
      destinationType: "organization",
      destinationId: "org-42",
      destinationName: "Acme Corp",
      blogPostUrl: "https://example.com/blog/post-1",
    });
    expect(generation.startLinkedInDraftCreation).toHaveBeenCalledTimes(1);
    expect(generation.startLinkedInDraftCreation).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedinAccountId: "li-acc-7",
        linkedinAccountName: "Acme Corp LinkedIn",
        destinationName: "Acme Corp",
      }),
    );
    // Specifically, must not be overwritten with an empty string.
    const callArg = vi.mocked(generation.startLinkedInDraftCreation).mock.calls[0][0];
    expect(callArg.linkedinAccountName).not.toBe("");
  });
});
