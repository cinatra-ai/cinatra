/**
 * stopBlogPostImageRegeneration must never clobber a terminal state
 * (mirrors stop-linkedin-draft-terminal-guard, plus the race window).
 *
 * Two layers:
 *  1. pre-check — already-terminal BEFORE the stop reads → early return;
 *  2. conditional store transition — the worker may commit `succeeded`
 *     BETWEEN the stop's read and its write (while cancelBackgroundJob is in
 *     flight); the stop therefore delegates the write to
 *     markBlogPostImageGenerationStoppedIfRunning, whose body re-checks and
 *     writes in ONE synchronous block (no await boundary — pinned by a
 *     source-text contract below).
 *
 * Without these, a cancel racing job completion erases the outcome of an
 * already-finished job — and, in the dashboard portlet's manual refSwapMode,
 * suppresses the keep/revert gate even though the pipeline already applied
 * the new image refs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const readBlogPostsProjectById = vi.fn();
const updateBlogPostImageGenerationState = vi.fn();
const markBlogPostImageGenerationStoppedIfRunning = vi.fn();
const cancelBackgroundJob = vi.fn();

vi.mock("../store", () => ({
  readBlogPostsProjectById: (...args: unknown[]) => readBlogPostsProjectById(...args),
  updateBlogPostImageGenerationState: (...args: unknown[]) =>
    updateBlogPostImageGenerationState(...args),
  markBlogPostImageGenerationStoppedIfRunning: (...args: unknown[]) =>
    markBlogPostImageGenerationStoppedIfRunning(...args),
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
    markBlogPostImageGenerationStoppedIfRunning.mockReset();
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
    expect(markBlogPostImageGenerationStoppedIfRunning).not.toHaveBeenCalled();
    expect(cancelBackgroundJob).not.toHaveBeenCalled();
  });

  it("cancels and stops via the CONDITIONAL transition when status is running", async () => {
    const before = makeProject("running");
    const after = { ...before, imageGeneration: { ...before.imageGeneration, status: "stopped" as const } };
    readBlogPostsProjectById
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    markBlogPostImageGenerationStoppedIfRunning.mockResolvedValueOnce(true);

    const result = await stopBlogPostImageRegeneration("proj-1");
    expect(cancelBackgroundJob).toHaveBeenCalledWith("job-42");
    expect(markBlogPostImageGenerationStoppedIfRunning).toHaveBeenCalledWith(
      "proj-1",
      "Blog post image generation stopped.",
    );
    // Never the unconditional setter — only the compare-and-write transition.
    expect(updateBlogPostImageGenerationState).not.toHaveBeenCalled();
    expect(result).toBe(after);
  });

  it("race window: worker commits `succeeded` during the cancel round-trip → no clobber", async () => {
    const before = makeProject("running");
    const afterWorkerWon = {
      ...before,
      imageGeneration: { ...before.imageGeneration, status: "succeeded" as const, jobId: null },
    };
    readBlogPostsProjectById
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(afterWorkerWon);
    // Conditional transition declines: the state is already terminal.
    markBlogPostImageGenerationStoppedIfRunning.mockResolvedValueOnce(false);

    const result = await stopBlogPostImageRegeneration("proj-1");
    expect(updateBlogPostImageGenerationState).not.toHaveBeenCalled();
    expect(result).toBe(afterWorkerWon); // succeeded outcome preserved
  });

  it("stops when status is idle without a jobId (no cancel call)", async () => {
    const before = makeProject("idle");
    const after = { ...before, imageGeneration: { ...before.imageGeneration, status: "stopped" as const } };
    readBlogPostsProjectById
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    markBlogPostImageGenerationStoppedIfRunning.mockResolvedValueOnce(true);

    await stopBlogPostImageRegeneration("proj-1");
    expect(cancelBackgroundJob).not.toHaveBeenCalled();
    expect(markBlogPostImageGenerationStoppedIfRunning).toHaveBeenCalledTimes(1);
  });
});

describe("markBlogPostImageGenerationStoppedIfRunning - atomicity source contract", () => {
  it("has NO await boundary in its body (read-check-write stays one synchronous block)", () => {
    const source = readFileSync(resolve(__dirname, "../store.ts"), "utf8");
    const start = source.indexOf("export async function markBlogPostImageGenerationStoppedIfRunning");
    expect(start).toBeGreaterThan(-1);
    // Function bodies in store.ts are brace-balanced; scan to the matching brace.
    const bodyStart = source.indexOf("{", start);
    let depth = 0;
    let end = bodyStart;
    for (let i = bodyStart; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = source.slice(bodyStart, end + 1);
    expect(body).not.toMatch(/\bawait\b/);
  });
});
