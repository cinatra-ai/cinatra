/**
 * cinatra#2022 — blog-publish re-point.
 *
 * `publishBlogPostDraftToWordPress` moves 3 of its 4 legs off direct REST
 * (the connector-owned `wordpressContent`/`wordpressAdmin` clients) onto the
 * governed generic invoker (`invokeConnectorInstanceTool`):
 *   - draft creation        -> ewpa/create-post
 *   - draft meta write      -> ewpa/update-post-meta
 *   - latest-published read -> ewpa/get-posts
 *
 * Featured-image upload is the ONE leg that stays on direct WordPress core
 * REST (`wordpressContent.uploadMedia`) for now. This suite asserts the
 * both-paths-live seam does not leak either direction: the three re-pointed
 * legs NEVER reach `wordpressContent`'s create/meta/read-latest members, and
 * the media leg NEVER reaches the invoker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const spies = vi.hoisted(() => ({
  readInstanceById: vi.fn(),
  uploadMedia: vi.fn(),
  createDraft: vi.fn(),
  updateDraftMeta: vi.fn(),
  readLatestPublishedWordPressPost: vi.fn(),
  buildDraftPayload: vi.fn(),
  readBlogImageArtifactBytes: vi.fn(),
  invokeConnectorInstanceTool: vi.fn<
    (input: Record<string, unknown>, deps: unknown) => Promise<unknown>
  >(),
  buildConnectorInstanceInvokerDeps: vi.fn(() => ({ marker: "deps" })),
  resolveTrustedWriteActor: vi.fn<
    () => Promise<{
      actor: { principalType: "HumanUser"; principalId: string; authSource: "worker"; policyVersion: string };
      userId: string;
      orgId: string;
    } | null>
  >(),
}));

vi.mock("@/lib/connector-client-providers", () => ({
  requireWordPressInstanceAdmin: () => ({
    readInstanceById: (...args: unknown[]) => spies.readInstanceById(...args),
    // Deliberately NOT provided as a working member: the re-pointed leg must
    // never call it. If a future regression calls it, this throws loudly
    // rather than silently degrading.
    readLatestPublishedWordPressPost: (...args: unknown[]) =>
      spies.readLatestPublishedWordPressPost(...args),
  }),
  requireWordPressContentClient: () => ({
    uploadMedia: (...args: unknown[]) => spies.uploadMedia(...args),
    createDraft: (...args: unknown[]) => spies.createDraft(...args),
    updateDraftMeta: (...args: unknown[]) => spies.updateDraftMeta(...args),
  }),
}));

vi.mock("@/lib/blog-system-provider", () => ({
  requireBlogSystem: () => ({
    buildDraftPayload: (...args: unknown[]) => spies.buildDraftPayload(...args),
  }),
}));

vi.mock("@/lib/blog-image-materializer", () => ({
  readBlogImageArtifactBytes: (...args: unknown[]) => spies.readBlogImageArtifactBytes(...args),
}));

vi.mock("@/lib/connector-instance-invoker", () => ({
  invokeConnectorInstanceTool: spies.invokeConnectorInstanceTool,
}));

vi.mock("@/lib/register-host-connector-services", () => ({
  buildConnectorInstanceInvokerDeps: spies.buildConnectorInstanceInvokerDeps,
}));

vi.mock("@/lib/connector-instance-write-authority", () => ({
  resolveTrustedWriteActor: spies.resolveTrustedWriteActor,
}));

import { publishBlogPostDraftToWordPress } from "../wordpress";

const INSTANCE = {
  id: "wp-instance-1",
  name: "Acme Blog",
  siteUrl: "https://acme.example.com/",
  username: "editor",
  applicationPassword: "app-pass",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const TRUSTED_ACTOR = {
  actor: { principalType: "HumanUser" as const, principalId: "user-1", authSource: "worker" as const, policyVersion: "v2" },
  userId: "user-1",
  orgId: "org-1",
};

function toolNamesCalled(): string[] {
  return spies.invokeConnectorInstanceTool.mock.calls.map((call) => (call[0] as { toolName: string }).toolName);
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.readInstanceById.mockReturnValue(INSTANCE);
  spies.resolveTrustedWriteActor.mockResolvedValue(TRUSTED_ACTOR);
  spies.buildDraftPayload.mockResolvedValue({
    createPayload: {
      title: "Hello world",
      content: "<p>Body</p>",
      excerpt: "An excerpt",
      status: "draft" as const,
    },
    postMeta: undefined,
  });
});

describe("publishBlogPostDraftToWordPress — invoker re-point (cinatra#2022)", () => {
  it("creates the draft via ewpa/create-post through the invoker, never through wordpressContent.createDraft", async () => {
    spies.invokeConnectorInstanceTool.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.toolName === "ewpa/get-posts") return { success: true, data: [] };
      if (input.toolName === "ewpa/create-post") {
        return {
          success: true,
          data: { post_id: 42, permalink: "https://acme.example.com/?p=42", status: "draft" },
        };
      }
      throw new Error(`unexpected toolName ${String(input.toolName)}`);
    });

    const result = await publishBlogPostDraftToWordPress({
      wordpressInstanceId: "wp-instance-1",
      companyUrl: "https://acme.example.com",
      postTitle: "Hello world",
      postExcerpt: "An excerpt",
      blogPostContent: "<p>Body</p>",
      causation: "job-123",
    });

    expect(spies.createDraft).not.toHaveBeenCalled();
    expect(result.createdDraft).toEqual({
      wordpressPostId: 42,
      publicUrl: "https://acme.example.com/?p=42",
      adminUrl: "https://acme.example.com/wp-admin/post.php?post=42&action=edit",
    });
    // The input instanceId is preserved on the returned instance (the
    // "draft reference keeps the input instanceId" invariant).
    expect(result.instance.id).toBe("wp-instance-1");

    const createCall = spies.invokeConnectorInstanceTool.mock.calls.find(
      (call) => (call[0] as { toolName: string }).toolName === "ewpa/create-post",
    );
    expect(createCall).toBeTruthy();
    const createInput = createCall![0] as Record<string, unknown>;
    expect(createInput.connectorKey).toBe("wordpress");
    expect(createInput.instanceId).toBe("wp-instance-1");
    expect(createInput.args).toEqual({
      title: "Hello world",
      content: "<p>Body</p>",
      excerpt: "An excerpt",
      status: "draft",
    });
    expect(createInput.actor).toEqual(TRUSTED_ACTOR);
    expect(createInput.causation).toBe("job-123");
    // Fail-safe surface: never one of the recognized delegated surfaces.
    expect(createInput.sourceType).toBe("background_job");
  });

  it("drops REST-only fields with no ewpa/create-post equivalent and warns instead of silently absorbing them", async () => {
    spies.buildDraftPayload.mockResolvedValue({
      createPayload: {
        title: "Hello world",
        content: "<p>Body</p>",
        excerpt: "An excerpt",
        status: "draft" as const,
        categories: [3, 7],
        tags: [9],
        comment_status: "open" as const,
        meta: { some_flag: true },
      },
      postMeta: undefined,
    });
    spies.invokeConnectorInstanceTool.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.toolName === "ewpa/get-posts") return { success: true, data: [] };
      return { success: true, data: { post_id: 1, permalink: "https://acme.example.com/?p=1" } };
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await publishBlogPostDraftToWordPress({
      wordpressInstanceId: "wp-instance-1",
      companyUrl: "https://acme.example.com",
      postTitle: "Hello world",
      postExcerpt: "An excerpt",
      blogPostContent: "<p>Body</p>",
    });

    const createCall = spies.invokeConnectorInstanceTool.mock.calls.find(
      (call) => (call[0] as { toolName: string }).toolName === "ewpa/create-post",
    );
    const args = (createCall![0] as Record<string, unknown>).args as Record<string, unknown>;
    expect(args.categories).toBeUndefined();
    expect(args.tags).toBeUndefined();
    expect(args.comment_status).toBeUndefined();
    expect(args.meta).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("writes draft meta via N sequential ewpa/update-post-meta calls, never through wordpressContent.updateDraftMeta", async () => {
    spies.buildDraftPayload.mockResolvedValue({
      createPayload: {
        title: "Hello world",
        content: "<p>Body</p>",
        excerpt: "An excerpt",
        status: "draft" as const,
      },
      postMeta: { _elementor_data: [{ id: "a" }], _elementor_edit_mode: "builder" },
    });
    spies.invokeConnectorInstanceTool.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.toolName === "ewpa/get-posts") return { success: true, data: [] };
      if (input.toolName === "ewpa/create-post") return { success: true, data: { post_id: 7 } };
      if (input.toolName === "ewpa/update-post-meta") return { success: true, data: {} };
      throw new Error(`unexpected toolName ${String(input.toolName)}`);
    });

    await publishBlogPostDraftToWordPress({
      wordpressInstanceId: "wp-instance-1",
      companyUrl: "https://acme.example.com",
      postTitle: "Hello world",
      postExcerpt: "An excerpt",
      blogPostContent: "<p>Body</p>",
    });

    expect(spies.updateDraftMeta).not.toHaveBeenCalled();
    const metaCalls = spies.invokeConnectorInstanceTool.mock.calls
      .map((call) => call[0] as Record<string, unknown>)
      .filter((call) => call.toolName === "ewpa/update-post-meta");
    expect(metaCalls).toHaveLength(2);
    const byKey = new Map(metaCalls.map((c) => [(c.args as Record<string, unknown>).meta_key, c.args as Record<string, unknown>]));
    expect(byKey.get("_elementor_data")).toEqual({
      post_id: 7,
      meta_key: "_elementor_data",
      meta_value: JSON.stringify([{ id: "a" }]),
    });
    expect(byKey.get("_elementor_edit_mode")).toEqual({
      post_id: 7,
      meta_key: "_elementor_edit_mode",
      meta_value: "builder",
    });
  });

  it("fails the publish when ewpa/update-post-meta reports success:false instead of silently swallowing it", async () => {
    spies.buildDraftPayload.mockResolvedValue({
      createPayload: {
        title: "Hello world",
        content: "<p>Body</p>",
        excerpt: "An excerpt",
        status: "draft" as const,
      },
      postMeta: { _elementor_data: [{ id: "a" }] },
    });
    spies.invokeConnectorInstanceTool.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.toolName === "ewpa/get-posts") return { success: true, data: [] };
      if (input.toolName === "ewpa/create-post") return { success: true, data: { post_id: 7 } };
      if (input.toolName === "ewpa/update-post-meta") {
        return { success: false, error: { code: "meta_write_failed", message: "protected meta key" } };
      }
      throw new Error(`unexpected toolName ${String(input.toolName)}`);
    });

    await expect(
      publishBlogPostDraftToWordPress({
        wordpressInstanceId: "wp-instance-1",
        companyUrl: "https://acme.example.com",
        postTitle: "Hello world",
        postExcerpt: "An excerpt",
        blogPostContent: "<p>Body</p>",
      }),
    ).rejects.toThrow(/did not report success/i);
  });

  it("skips the meta call entirely when the resolved connector returns no postMeta", async () => {
    spies.invokeConnectorInstanceTool.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.toolName === "ewpa/get-posts") return { success: true, data: [] };
      return { success: true, data: { post_id: 5 } };
    });

    await publishBlogPostDraftToWordPress({
      wordpressInstanceId: "wp-instance-1",
      companyUrl: "https://acme.example.com",
      postTitle: "Hello world",
      postExcerpt: "An excerpt",
      blogPostContent: "<p>Body</p>",
    });

    expect(toolNamesCalled().filter((n) => n === "ewpa/update-post-meta")).toHaveLength(0);
  });

  it("reads the latest published post via ewpa/get-posts (status:publish, newest-first), never through wordpressAdmin.readLatestPublishedWordPressPost", async () => {
    spies.invokeConnectorInstanceTool.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.toolName === "ewpa/get-posts") {
        return {
          success: true,
          data: [{ ID: 8, post_title: "Newest published", post_status: "publish", post_excerpt: "ex" }],
        };
      }
      return { success: true, data: { post_id: 1 } };
    });

    await publishBlogPostDraftToWordPress({
      wordpressInstanceId: "wp-instance-1",
      companyUrl: "https://acme.example.com",
      postTitle: "Hello world",
      postExcerpt: "An excerpt",
      blogPostContent: "<p>Body</p>",
    });

    expect(spies.readLatestPublishedWordPressPost).not.toHaveBeenCalled();
    const getPostsCall = spies.invokeConnectorInstanceTool.mock.calls.find(
      (call) => (call[0] as { toolName: string }).toolName === "ewpa/get-posts",
    );
    expect(getPostsCall).toBeTruthy();
    expect((getPostsCall![0] as Record<string, unknown>).args).toEqual({
      status: "publish",
      orderby: "date",
      order: "DESC",
      numberposts: 1,
    });

    // The connector's buildDraftPayload receives the mapped latestPublishedPost.
    const buildDraftPayloadInput = spies.buildDraftPayload.mock.calls[0][0] as {
      latestPublishedPost: { apiResponse: unknown; writableTemplate: { title: string; content: string; excerpt: string } };
    };
    expect(buildDraftPayloadInput.latestPublishedPost.writableTemplate.title).toBe("Newest published");
    // KNOWN, DISCLOSED GAP: ewpa/get-posts returns no post body content, so the
    // best-effort template's content is empty rather than guessed.
    expect(buildDraftPayloadInput.latestPublishedPost.writableTemplate.content).toBe("");
    expect(buildDraftPayloadInput.latestPublishedPost.apiResponse).toEqual({
      ID: 8,
      post_title: "Newest published",
      post_status: "publish",
      post_excerpt: "ex",
    });
  });

  it("returns null (not throw) for the latest-published leg when the site has no published post yet", async () => {
    spies.invokeConnectorInstanceTool.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.toolName === "ewpa/get-posts") return { success: true, data: [] };
      return { success: true, data: { post_id: 1 } };
    });

    await publishBlogPostDraftToWordPress({
      wordpressInstanceId: "wp-instance-1",
      companyUrl: "https://acme.example.com",
      postTitle: "Hello world",
      postExcerpt: "An excerpt",
      blogPostContent: "<p>Body</p>",
    });

    const buildDraftPayloadInput = spies.buildDraftPayload.mock.calls[0][0] as {
      latestPublishedPost: unknown;
    };
    expect(buildDraftPayloadInput.latestPublishedPost).toBeNull();
  });

  it("fails the publish (does not treat as 'no published posts') when ewpa/get-posts reports success:false", async () => {
    spies.invokeConnectorInstanceTool.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.toolName === "ewpa/get-posts") {
        return { success: false, error: { code: "auth_error", message: "invalid credentials" } };
      }
      return { success: true, data: { post_id: 1 } };
    });

    await expect(
      publishBlogPostDraftToWordPress({
        wordpressInstanceId: "wp-instance-1",
        companyUrl: "https://acme.example.com",
        postTitle: "Hello world",
        postExcerpt: "An excerpt",
        blogPostContent: "<p>Body</p>",
      }),
    ).rejects.toThrow(/malformed or failed/i);

    // A real API failure must never be silently downgraded to "no published
    // posts yet" — the draft creation call must not proceed past the failure.
    expect(toolNamesCalled()).not.toContain("ewpa/create-post");
  });

  it("fails the publish when ewpa/get-posts reports success:true but data is not an array (malformed, not empty)", async () => {
    spies.invokeConnectorInstanceTool.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.toolName === "ewpa/get-posts") return { success: true };
      return { success: true, data: { post_id: 1 } };
    });

    await expect(
      publishBlogPostDraftToWordPress({
        wordpressInstanceId: "wp-instance-1",
        companyUrl: "https://acme.example.com",
        postTitle: "Hello world",
        postExcerpt: "An excerpt",
        blogPostContent: "<p>Body</p>",
      }),
    ).rejects.toThrow(/malformed or failed/i);
    expect(toolNamesCalled()).not.toContain("ewpa/create-post");
  });

  it("keeps the featured-image upload on the direct WordPress core REST path — the invoker never sees an upload-image call", async () => {
    spies.readBlogImageArtifactBytes.mockResolvedValue({
      imageBase64: "YmFzZTY0",
      imageMimeType: "image/png",
    });
    spies.uploadMedia.mockResolvedValue({ mediaId: 99, sourceUrl: "https://acme.example.com/media/99.png" });
    spies.invokeConnectorInstanceTool.mockImplementation(async (input: Record<string, unknown>) => {
      if (input.toolName === "ewpa/get-posts") return { success: true, data: [] };
      return { success: true, data: { post_id: 3 } };
    });

    await publishBlogPostDraftToWordPress({
      wordpressInstanceId: "wp-instance-1",
      companyUrl: "https://acme.example.com",
      postTitle: "Hello world",
      postExcerpt: "An excerpt",
      blogPostContent: "<p>Body</p>",
      imageArtifactId: "artifact-1",
      imageRepresentationRevisionId: "rev-1",
    });

    expect(spies.uploadMedia).toHaveBeenCalledTimes(1);
    expect(spies.uploadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ imageBase64: "YmFzZTY0", imageMimeType: "image/png" }),
    );
    // The carve-out boundary does not leak: no invoker call ever names an
    // image/media ability.
    expect(toolNamesCalled().every((name) => !name.includes("image") && !name.includes("media"))).toBe(true);
  });

  it("fails closed BEFORE any write when no trusted actor can be resolved (no anonymous/synthetic executor)", async () => {
    spies.resolveTrustedWriteActor.mockResolvedValue(null);

    await expect(
      publishBlogPostDraftToWordPress({
        wordpressInstanceId: "wp-instance-1",
        companyUrl: "https://acme.example.com",
        postTitle: "Hello world",
        postExcerpt: "An excerpt",
        blogPostContent: "<p>Body</p>",
      }),
    ).rejects.toThrow(/no trusted actor/i);

    expect(spies.invokeConnectorInstanceTool).not.toHaveBeenCalled();
    expect(spies.uploadMedia).not.toHaveBeenCalled();
  });
});
