/**
 * blog_post_publish_wordpress_start idempotent_noop guard. A second start with
 * the same {projectId,postId,wordpressInstanceId} returns the prior draft's
 * refs without enqueueing a new background job; the project state is persisted
 * at "succeeded" with idempotentNoop:true so the publish agent's
 * `blog_project_get` poll resolves on the existing state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  enqueueSpy: vi.fn(async () => "job-NEW"),
  updateSpy: vi.fn(async () => undefined),
  readProjectSpy: vi.fn(),
  isJobActiveSpy: vi.fn(async () => false),
}));

vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: h.enqueueSpy,
  isBackgroundJobActive: h.isJobActiveSpy,
  registerBackgroundJobAbortController: vi.fn(),
  throwIfAborted: vi.fn(),
  BACKGROUND_JOB_NAMES: { BLOG_POST_WORDPRESS_DRAFT_CREATION: "BLOG_POST_WORDPRESS_DRAFT_CREATION" },
}));
vi.mock("../store", async () => {
  const actual = await vi.importActual<typeof import("../store")>("../store");
  return {
    ...actual,
    readBlogPostsProjectById: (id: string) => h.readProjectSpy(id),
    updateBlogPostWordPressDraftGenerationState: h.updateSpy,
    getDefaultBlogPostWordPressDraftState: () => ({ status: "idle", message: "", updatedAt: "" }),
  };
});

import { startWordPressDraftCreation } from "../generation";

beforeEach(() => {
  for (const v of Object.values(h)) v.mockClear();
  h.isJobActiveSpy.mockResolvedValue(false);
});

const POST = {
  id: "post-1",
  title: "T",
  wordpressDrafts: [
    {
      id: "draft-prior",
      wordpressInstanceId: "wp-1",
      wordpressInstanceName: "WP One",
      wordpressPostId: 42,
      adminUrl: "https://wp.example/wp-admin/post.php?post=42&action=edit",
      status: "draft",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ],
};
const PROJECT = {
  id: "proj-1",
  posts: [POST],
  wordpressDraftGeneration: { status: "idle", message: "", updatedAt: "" },
};

describe("BCW-04 startWordPressDraftCreation idempotent_noop", () => {
  it("short-circuits when a prior draft exists for the same {projectId,postId,wordpressInstanceId}", async () => {
    h.readProjectSpy.mockReturnValue(PROJECT);
    const state = await startWordPressDraftCreation({ projectId: "proj-1", postId: "post-1", wordpressInstanceId: "wp-1" });
    expect(state.status).toBe("succeeded");
    expect((state as { idempotentNoop?: boolean }).idempotentNoop).toBe(true);
    expect((state as { wordpressDraftId?: string }).wordpressDraftId).toBe("draft-prior");
    expect((state as { wordpressPostId?: number }).wordpressPostId).toBe(42);
    expect(h.enqueueSpy).not.toHaveBeenCalled();
    // The project state is persisted at succeeded so the agent's poll resolves.
    expect(h.updateSpy).toHaveBeenCalledTimes(1);
  });

  it("enqueues normally when there is NO prior draft for this instance", async () => {
    h.readProjectSpy.mockReturnValue({ ...PROJECT, posts: [{ ...POST, wordpressDrafts: [] }] });
    const state = await startWordPressDraftCreation({ projectId: "proj-1", postId: "post-1", wordpressInstanceId: "wp-1" });
    expect(state.status).toBe("running");
    expect(h.enqueueSpy).toHaveBeenCalledTimes(1);
  });

  it("treats a 'deleted'-status draft as absent (still enqueues a fresh run)", async () => {
    h.readProjectSpy.mockReturnValue({
      ...PROJECT,
      posts: [{ ...POST, wordpressDrafts: [{ ...POST.wordpressDrafts[0]!, status: "deleted" }] }],
    });
    const state = await startWordPressDraftCreation({ projectId: "proj-1", postId: "post-1", wordpressInstanceId: "wp-1" });
    expect(state.status).toBe("running");
    expect(h.enqueueSpy).toHaveBeenCalledTimes(1);
  });
});
