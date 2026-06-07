/**
 * stopLinkedInDraftGeneration must be a no-op when the job has already reached
 * a terminal state.
 *
 * The guard preserves the outcome of an already-finished job, including the
 * linkedinPostUrl from a successful publish, and prevents the
 * blog-linkedin-publish-agent reject path from destroying real state after
 * `_publish` has already succeeded.
 *
 * Terminal states (succeeded/failed/stopped) early-return.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const readBlogPostsProjectById = vi.fn();
const updateBlogPostLinkedInDraftGenerationState = vi.fn();
const cancelBackgroundJob = vi.fn();

vi.mock("../store", () => ({
  readBlogPostsProjectById: (...args: unknown[]) => readBlogPostsProjectById(...args),
  updateBlogPostLinkedInDraftGenerationState: (...args: unknown[]) =>
    updateBlogPostLinkedInDraftGenerationState(...args),
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
  updateBlogPostImageGenerationState: vi.fn(),
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
// generation.ts routes LinkedIn through the social-media-connector facade.
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

import { stopLinkedInDraftGeneration } from "../generation";

function makeProject(status: "idle" | "running" | "succeeded" | "failed" | "stopped") {
  return {
    id: "proj-1",
    linkedinDraftGeneration: {
      status,
      jobId: status === "running" ? "job-42" : null,
      operation: "publish" as const,
      message: "",
      linkedinPostUrl: status === "succeeded" ? "https://www.linkedin.com/feed/update/urn:li:share:42" : "",
    },
  };
}

describe("stopLinkedInDraftGeneration - terminal-state guard", () => {
  beforeEach(() => {
    readBlogPostsProjectById.mockReset();
    updateBlogPostLinkedInDraftGenerationState.mockReset();
    cancelBackgroundJob.mockReset();
  });

  it.each([
    ["succeeded"],
    ["failed"],
    ["stopped"],
  ] as const)("returns project unchanged when status is %s (no clobber, no cancel)", async (status) => {
    const project = makeProject(status);
    readBlogPostsProjectById.mockResolvedValueOnce(project);
    const result = await stopLinkedInDraftGeneration("proj-1");
    expect(result).toBe(project);
    expect(updateBlogPostLinkedInDraftGenerationState).not.toHaveBeenCalled();
    expect(cancelBackgroundJob).not.toHaveBeenCalled();
  });

  it("cancels and stops when status is running", async () => {
    const before = makeProject("running");
    const after = { ...before, linkedinDraftGeneration: { ...before.linkedinDraftGeneration, status: "stopped" as const } };
    readBlogPostsProjectById
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    updateBlogPostLinkedInDraftGenerationState.mockResolvedValueOnce(undefined);

    const result = await stopLinkedInDraftGeneration("proj-1");
    expect(cancelBackgroundJob).toHaveBeenCalledWith("job-42");
    expect(updateBlogPostLinkedInDraftGenerationState).toHaveBeenCalledTimes(1);
    expect(result).toBe(after);
  });

  it("stops when status is idle without a jobId (no cancel call)", async () => {
    const before = makeProject("idle");
    const after = { ...before, linkedinDraftGeneration: { ...before.linkedinDraftGeneration, status: "stopped" as const } };
    readBlogPostsProjectById
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    updateBlogPostLinkedInDraftGenerationState.mockResolvedValueOnce(undefined);

    await stopLinkedInDraftGeneration("proj-1");
    expect(cancelBackgroundJob).not.toHaveBeenCalled();
    expect(updateBlogPostLinkedInDraftGenerationState).toHaveBeenCalledTimes(1);
  });
});
