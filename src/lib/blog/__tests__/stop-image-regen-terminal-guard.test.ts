/**
 * stopBlogPostImageRegeneration must be a no-op when the job has already
 * reached a terminal state (mirrors stop-linkedin-draft-terminal-guard).
 *
 * Without the guard, a cancel racing job completion clobbers a
 * succeeded/failed status with `stopped`, erasing the outcome of an
 * already-finished job — and, in the dashboard portlet's manual refSwapMode,
 * suppressing the keep/revert gate even though the pipeline already applied
 * the new image refs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readBlogPostsProjectById = vi.fn();
const updateBlogPostImageGenerationState = vi.fn();
const cancelBackgroundJob = vi.fn();

vi.mock("../store", () => ({
  readBlogPostsProjectById: (...args: unknown[]) => readBlogPostsProjectById(...args),
  updateBlogPostImageGenerationState: (...args: unknown[]) =>
    updateBlogPostImageGenerationState(...args),
  // Other store exports referenced by generation.ts at import time. They are
  // unused by the function under test but must resolve.
  createBlogPostsProject: vi.fn(),
  deleteWordPressDraftReference: vi.fn(),
  getDefaultBlogPostImageGenerationState: vi.fn(),
  readSelectedTranscriptOptions: vi.fn(),
  saveLinkedInDraftReference: vi.fn(),
  saveGeneratedBlogPostDraft: vi.fn(),
  saveGeneratedIdeas: vi.fn(),
  saveWordPressDraftReference: vi.fn(),
  updateLinkedInDraftReference: vi.fn(),
  updateBlogPostDraftImage: vi.fn(),
  updateBlogPostDraftGenerationState: vi.fn(),
  updateBlogPostLinkedInDraftGenerationState: vi.fn(),
  updateBlogPostIdeaGenerationState: vi.fn(),
  updateBlogPostWordPressDraftGenerationState: vi.fn(),
  updateWordPressDraftReference: vi.fn(),
  getDefaultBlogPostDraftGenerationState: vi.fn(),
  getDefaultBlogPostIdeaGenerationState: vi.fn(),
  getDefaultBlogPostLinkedInDraftState: vi.fn(),
  getDefaultBlogPostWordPressDraftState: vi.fn(),
}));

vi.mock("@/lib/background-jobs", () => ({
  BACKGROUND_JOB_NAMES: {},
  cancelBackgroundJob: (...args: unknown[]) => cancelBackgroundJob(...args),
  enqueueBackgroundJob: vi.fn(),
  isBackgroundJobActive: vi.fn(),
  registerBackgroundJobAbortController: vi.fn(),
  unregisterBackgroundJobAbortController: vi.fn(),
}));

// Other transitive imports referenced by generation.ts top-level.
vi.mock("@/lib/notifications", () => ({ createNotification: vi.fn() }));
vi.mock("@cinatra-ai/social-media-connector", () => ({
  publishSocialMediaPostThroughSystem: vi.fn(),
}));
vi.mock("@/lib/wordpress-api", () => ({
  deleteWordPressPost: vi.fn(),
  readWordPressInstanceById: vi.fn(),
  readWordPressPostStatus: vi.fn(),
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

import { stopBlogPostImageRegeneration } from "../generation";

function makeProject(status: "idle" | "running" | "succeeded" | "failed" | "stopped") {
  return {
    id: "proj-1",
    imageGeneration: {
      status,
      jobId: status === "running" ? "job-42" : null,
      message: "",
      updatedAt: "t0",
      postId: "post-1",
      postTitle: "Post",
    },
  };
}

describe("stopBlogPostImageRegeneration - terminal-state guard", () => {
  beforeEach(() => {
    readBlogPostsProjectById.mockReset();
    updateBlogPostImageGenerationState.mockReset();
    cancelBackgroundJob.mockReset();
  });

  it.each([
    ["succeeded"],
    ["failed"],
    ["stopped"],
  ] as const)("returns project unchanged when status is %s (no clobber, no cancel)", async (status) => {
    const project = makeProject(status);
    readBlogPostsProjectById.mockResolvedValueOnce(project);
    const result = await stopBlogPostImageRegeneration("proj-1");
    expect(result).toBe(project);
    expect(updateBlogPostImageGenerationState).not.toHaveBeenCalled();
    expect(cancelBackgroundJob).not.toHaveBeenCalled();
  });

  it("cancels and stops when status is running", async () => {
    const before = makeProject("running");
    const after = { ...before, imageGeneration: { ...before.imageGeneration, status: "stopped" as const } };
    readBlogPostsProjectById
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    updateBlogPostImageGenerationState.mockResolvedValueOnce(undefined);

    const result = await stopBlogPostImageRegeneration("proj-1");
    expect(cancelBackgroundJob).toHaveBeenCalledWith("job-42");
    expect(updateBlogPostImageGenerationState).toHaveBeenCalledTimes(1);
    expect(updateBlogPostImageGenerationState.mock.calls[0]![1]).toMatchObject({ status: "stopped" });
    expect(result).toBe(after);
  });

  it("stops when status is idle without a jobId (no cancel call)", async () => {
    const before = makeProject("idle");
    const after = { ...before, imageGeneration: { ...before.imageGeneration, status: "stopped" as const } };
    readBlogPostsProjectById
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    updateBlogPostImageGenerationState.mockResolvedValueOnce(undefined);

    await stopBlogPostImageRegeneration("proj-1");
    expect(cancelBackgroundJob).not.toHaveBeenCalled();
    expect(updateBlogPostImageGenerationState).toHaveBeenCalledTimes(1);
  });
});
