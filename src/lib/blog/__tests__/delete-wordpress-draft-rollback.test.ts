/**
 * Regression test for deleteWordPressDraft rollback semantics.
 *
 * The function does two destructive operations with no transactional
 * envelope:
 *   1. Remote DELETE against the WordPress REST API (if
 *      `deleteInWordPress: true`).
 *   2. Local delete of the draft reference from store.ts.
 *
 * There is no true rollback if step 2 fails after step 1 succeeds — the
 * remote post is already gone. The best we can do is enforce the safer
 * ordering: REMOTE FIRST, then LOCAL. If the remote step fails, the local
 * reference must NOT be deleted so the operator can retry (or manually
 * confirm in WordPress admin) without losing the local pointer.
 *
 * This pins the ordering invariant so a future refactor that swaps
 * local-first cannot land silently.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readBlogPostsProjectById = vi.fn();
const deleteWordPressDraftReference = vi.fn();
const readWordPressInstanceById = vi.fn();
const deleteWordPressPost = vi.fn();

vi.mock("../store", () => ({
  readBlogPostsProjectById: (...args: unknown[]) => readBlogPostsProjectById(...args),
  deleteWordPressDraftReference: (...args: unknown[]) =>
    deleteWordPressDraftReference(...args),
  // The rest are not used by this function but must resolve.
  createBlogPostsProject: vi.fn(),
  getDefaultBlogPostImageGenerationState: vi.fn(),
  readSelectedTranscriptOptions: vi.fn(),
  saveLinkedInDraftReference: vi.fn(),
  saveGeneratedBlogPostDraft: vi.fn(),
  saveGeneratedIdeas: vi.fn(),
  saveWordPressDraftReference: vi.fn(),
  updateLinkedInDraftReference: vi.fn(),
  updateBlogPostDraftImage: vi.fn(),
  updateBlogPostDraftGenerationState: vi.fn(),
  updateBlogPostImageGenerationState: vi.fn(),
  updateBlogPostIdeaGenerationState: vi.fn(),
  updateBlogPostLinkedInDraftGenerationState: vi.fn(),
  updateBlogPostWordPressDraftGenerationState: vi.fn(),
  updateWordPressDraftReference: vi.fn(),
  getDefaultBlogPostDraftGenerationState: vi.fn(),
  getDefaultBlogPostIdeaGenerationState: vi.fn(),
  getDefaultBlogPostLinkedInDraftState: vi.fn(),
  getDefaultBlogPostWordPressDraftState: vi.fn(),
}));

vi.mock("@/lib/wordpress-api", () => ({
  deleteWordPressPost: (...args: unknown[]) => deleteWordPressPost(...args),
  readWordPressInstanceById: (...args: unknown[]) =>
    readWordPressInstanceById(...args),
  readWordPressPostStatus: vi.fn(),
}));

vi.mock("@/lib/background-jobs", () => ({
  BACKGROUND_JOB_NAMES: {},
  cancelBackgroundJob: vi.fn(),
  enqueueBackgroundJob: vi.fn(),
  isBackgroundJobActive: vi.fn(),
  registerBackgroundJobAbortController: vi.fn(),
  unregisterBackgroundJobAbortController: vi.fn(),
}));

vi.mock("@/lib/notifications", () => ({ createNotification: vi.fn() }));
// generation.ts routes LinkedIn through the social-media-connector facade,
// so this package must be mocked for the import to resolve.
vi.mock("@cinatra-ai/social-media-connector", () => ({
  publishSocialMediaPostThroughSystem: vi.fn(),
}));
vi.mock("../openai", () => ({
  deleteUploadedFile: vi.fn(),
  generateBlogPostDraftWithOpenAI: vi.fn(),
  generateBlogPostIdeasWithOpenAI: vi.fn(),
  generateLinkedInPostDraftWithOpenAI: vi.fn(),
  uploadTranscriptFiles: vi.fn(),
}));
vi.mock("../gemini", () => ({ generateBlogPostImage: vi.fn() }));
vi.mock("../wordpress", () => ({ publishBlogPostDraftToWordPress: vi.fn() }));
vi.mock("../mcp/handlers", () => ({ createBlogContentPrimitiveHandlers: vi.fn() }));
vi.mock("@cinatra-ai/mcp-client", () => ({ createInProcessPrimitiveTransport: vi.fn() }));

import { deleteWordPressDraft } from "../generation";

function projectWithWpDraft() {
  return {
    id: "proj-1",
    posts: [
      {
        id: "post-1",
        wordpressDrafts: [
          {
            id: "wp-99",
            wordpressInstanceId: "wp-instance-1",
            wordpressPostId: 42,
          },
        ],
      },
    ],
  };
}

describe("deleteWordPressDraft — ordering invariant regression", () => {
  beforeEach(() => {
    readBlogPostsProjectById.mockReset();
    deleteWordPressDraftReference.mockReset();
    readWordPressInstanceById.mockReset();
    deleteWordPressPost.mockReset();
  });

  it("when remote delete throws, the local reference is NOT deleted", async () => {
    readBlogPostsProjectById.mockResolvedValueOnce(projectWithWpDraft());
    readWordPressInstanceById.mockReturnValueOnce({
      id: "wp-instance-1",
      url: "https://site.example.com",
    });
    deleteWordPressPost.mockRejectedValueOnce(new Error("WP 503 Service Unavailable"));

    await expect(
      deleteWordPressDraft({
        projectId: "proj-1",
        postId: "post-1",
        draftId: "wp-99",
        deleteInWordPress: true,
      }),
    ).rejects.toThrow(/WP 503/);

    // Critical invariant: the local store delete must not have been
    // called. Without this, a transient WP 5xx would leave the operator
    // with no way to retry the delete (the local pointer is gone, so
    // they cannot rerun the reject path).
    expect(deleteWordPressDraftReference).not.toHaveBeenCalled();
  });

  it("when deleteInWordPress is omitted/false, the remote delete is never attempted", async () => {
    readBlogPostsProjectById.mockResolvedValueOnce(projectWithWpDraft());
    deleteWordPressDraftReference.mockResolvedValueOnce(undefined);

    await deleteWordPressDraft({
      projectId: "proj-1",
      postId: "post-1",
      draftId: "wp-99",
      // deleteInWordPress omitted (default false)
    });

    expect(deleteWordPressPost).not.toHaveBeenCalled();
    expect(readWordPressInstanceById).not.toHaveBeenCalled();
    expect(deleteWordPressDraftReference).toHaveBeenCalledWith({
      projectId: "proj-1",
      postId: "post-1",
      draftId: "wp-99",
    });
  });

  it("when remote delete succeeds, local delete is called next", async () => {
    readBlogPostsProjectById.mockResolvedValueOnce(projectWithWpDraft());
    readWordPressInstanceById.mockReturnValueOnce({
      id: "wp-instance-1",
      url: "https://site.example.com",
    });
    deleteWordPressPost.mockResolvedValueOnce(undefined);
    deleteWordPressDraftReference.mockResolvedValueOnce(undefined);

    await deleteWordPressDraft({
      projectId: "proj-1",
      postId: "post-1",
      draftId: "wp-99",
      deleteInWordPress: true,
    });

    expect(deleteWordPressPost).toHaveBeenCalledTimes(1);
    expect(deleteWordPressDraftReference).toHaveBeenCalledTimes(1);
    // Ordering: remote happens before local. This is the rollback-safety invariant.
    const remoteCallOrder = deleteWordPressPost.mock.invocationCallOrder[0];
    const localCallOrder = deleteWordPressDraftReference.mock.invocationCallOrder[0];
    expect(remoteCallOrder).toBeLessThan(localCallOrder);
  });
});
