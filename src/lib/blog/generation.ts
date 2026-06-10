import "server-only";

import { createNotification } from "@/lib/notifications";
import {
  createBlogPostsProject,
  deleteWordPressDraftReference,
  getDefaultBlogPostImageGenerationState,
  readSelectedTranscriptOptions,
  saveLinkedInDraftReference,
  saveGeneratedBlogPostDraft,
  saveGeneratedIdeas,
  saveWordPressDraftReference,
  updateLinkedInDraftReference,
  updateBlogPostDraftImage,
  updateBlogPostDraftGenerationState,
  updateBlogPostImageGenerationState,
  markBlogPostImageGenerationStoppedIfRunning,
  updateBlogPostIdeaGenerationState,
  updateBlogPostLinkedInDraftGenerationState,
  updateBlogPostWordPressDraftGenerationState,
  updateWordPressDraftReference,
  getDefaultBlogPostDraftGenerationState,
  getDefaultBlogPostIdeaGenerationState,
  getDefaultBlogPostLinkedInDraftState,
  getDefaultBlogPostWordPressDraftState,
  readBlogPostsProjectById,
} from "./store";
// `generate{BlogPostIdeas,BlogPostDraft,LinkedInPostDraft}WithOpenAI`,
// `deleteUploadedFile`, and `uploadTranscriptFiles` are no longer called
// from generation.ts because the jobs they served are retired. Their
// definitions in `openai.ts` remain for legacy compatibility.
import { generateBlogPostImage } from "./gemini";
import { publishBlogPostDraftToWordPress } from "./wordpress";
import { resolveBlogDashboardUrl } from "./dashboard-url";
import { getActorContext } from "@cinatra-ai/llm/actor-context";
import { createBlogContentPrimitiveHandlers } from "./mcp/handlers";
import { createInProcessPrimitiveTransport } from "@cinatra-ai/mcp-client";
// The LinkedIn transport call routes through @cinatra-ai/social-media-connector.
// The asset-blog `blog_post_publish_linkedin_*` primitives remain compatibility
// wrappers: only the actual provider/transport call routes through the facade;
// project state and HITL lifecycle stay in asset-blog.
import { publishSocialMediaPostThroughSystem } from "@cinatra-ai/social-media-connector";
import { materializeBlogImageThroughSystem } from "@cinatra-ai/blog-connector";
// Post body and idea summary live in semantic artifacts; resolve via the
// reader helpers when image regeneration, WordPress publishing, or LinkedIn
// publishing flows need the body string.
import { readBlogPostBodyArtifactBytes } from "@/lib/blog-post-artifact-materializer";
import { readBlogIdeaArtifactBytes } from "@/lib/blog-idea-artifact-materializer";
import { deleteWordPressPost, readWordPressInstanceById, readWordPressPostStatus } from "@/lib/wordpress-api";
import {
  BACKGROUND_JOB_NAMES,
  cancelBackgroundJob,
  enqueueBackgroundJob,
  isBackgroundJobActive,
  registerBackgroundJobAbortController,
  unregisterBackgroundJobAbortController,
} from "@/lib/background-jobs";

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Background process stopped.");
  }
}

// RETIRED. Text job 1 (`BLOG_POST_IDEA_GENERATION`) is replaced by
// `blog-idea-generator-agent` via `blog-pipeline-agent` `idea_flow`. The
// BullMQ constant and worker case are deleted; this stub remains so legacy
// callers (`route-handlers.ts`, `blog-content-adapters.ts`) still compile.
export async function startBlogPostIdeaGeneration(_input: {
  name: string;
  companyUrl: string;
  ideasPerTranscript: number;
  transcriptIds: string[];
}): Promise<never> {
  throw new Error(
    "Retired. Use the blog-pipeline-agent " +
      "idea_flow (via `@cinatra-ai/blog-pipeline-agent`) instead. " +
      "`packages/asset-blog` keeps this stub for legacy callers.",
  );
}

// RETIRED. `runBlogPostIdeaGenerationJob` was removed; no caller remains after
// the BullMQ `BLOG_POST_IDEA_GENERATION` worker case was deleted. The
// `blog-idea-generator-agent` flow replaces this code path.

// RETIRED. Text job 2 (`BLOG_POST_DRAFT_GENERATION`) is replaced by
// `blog-draft-writer-agent` (`draft_flow`). Stub remains so legacy callers
// compile.
export async function startBlogPostDraftGeneration(_input: {
  projectId: string;
  ideaId: string;
}): Promise<never> {
  throw new Error(
    "Retired. Use the blog-pipeline-agent " +
      "draft_flow (via `@cinatra-ai/blog-pipeline-agent`) instead. " +
      "`packages/asset-blog` keeps this stub for legacy callers.",
  );
}

export async function readBlogPostsProjectGenerationState(projectId: string) {
  const project = await readBlogPostsProjectById(projectId);
  return {
    ideaGeneration: project?.ideaGeneration ?? getDefaultBlogPostIdeaGenerationState(),
    postGeneration: project?.postGeneration ?? getDefaultBlogPostDraftGenerationState(),
    imageGeneration: project?.imageGeneration ?? getDefaultBlogPostImageGenerationState(),
    wordpressDraftGeneration: project?.wordpressDraftGeneration ?? getDefaultBlogPostWordPressDraftState(),
    linkedinDraftGeneration: project?.linkedinDraftGeneration ?? getDefaultBlogPostLinkedInDraftState(),
  };
}

export async function startBlogPostImageRegeneration(input: { projectId: string; postId: string; customPrompt?: string }) {
  const project = await readBlogPostsProjectById(input.projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }

  if (project.imageGeneration.status === "running") {
    if (project.imageGeneration.jobId && (await isBackgroundJobActive(project.imageGeneration.jobId))) {
      return project.imageGeneration;
    }
    await updateBlogPostImageGenerationState(project.id, getDefaultBlogPostImageGenerationState());
  }

  const post = project.posts.find((entry) => entry.id === input.postId);
  if (!post) {
    throw new Error("Blog post draft not found.");
  }

  const idea = project.ideas.find((entry) => entry.id === post.ideaId);
  const jobId = await enqueueBackgroundJob(BACKGROUND_JOB_NAMES.BLOG_POST_IMAGE_REGENERATION, {
    projectId: project.id,
    postId: post.id,
    customPrompt: input.customPrompt,
  });

  const runningState = {
    status: "running" as const,
    message: "Gemini is generating a new blog post image.",
    updatedAt: new Date().toISOString(),
    jobId,
    postId: post.id,
    postTitle: post.title,
  };
  await updateBlogPostImageGenerationState(project.id, runningState);

  return runningState;
}

export async function runBlogPostImageRegenerationJob(
  input: { projectId: string; postId: string; customPrompt?: string },
  _jobId: string,
) {
  const project = await readBlogPostsProjectById(input.projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }

  const post = project.posts.find((entry) => entry.id === input.postId);
  if (!post) {
    throw new Error("Blog post draft not found.");
  }

  const idea = project.ideas.find((entry) => entry.id === post.ideaId);
  const runningState = {
    status: "running" as const,
    message: "Gemini is generating a new blog post image.",
    updatedAt: new Date().toISOString(),
    jobId: _jobId,
    postId: post.id,
    postTitle: post.title,
  };
  const controller = new AbortController();
  registerBackgroundJobAbortController(_jobId, controller);

  try {
    throwIfAborted(controller.signal);
    // Resolve body bytes server-side. Falls back to the post excerpt when refs
    // are absent (e.g. a freshly seeded project without materialized body).
    const ideaSummaryBytes =
      idea?.summaryArtifactId && idea.summaryRepresentationRevisionId
        ? await readBlogIdeaArtifactBytes({
            artifactId: idea.summaryArtifactId,
            representationRevisionId: idea.summaryRepresentationRevisionId,
          })
        : null;
    const postBodyBytes =
      post.postArtifactId && post.postRepresentationRevisionId
        ? await readBlogPostBodyArtifactBytes({
            artifactId: post.postArtifactId,
            representationRevisionId: post.postRepresentationRevisionId,
          })
        : null;
    const image = await generateBlogPostImage({
      companyUrl: project.companyUrl,
      projectName: project.name,
      ideaTitle: post.title,
      ideaSummary: ideaSummaryBytes?.summary ?? post.excerpt,
      blogPostContent: postBodyBytes?.body ?? "",
      customPrompt: input.customPrompt,
    });
    throwIfAborted(controller.signal);

    // Regeneration mints a new artifact id because each materialization is a
    // fresh `createSemanticArtifact` call. Post-record refs are swapped to the
    // new pair; the previous artifact remains in `/artifacts` for replay.
    const imageMaterialization = await materializeBlogImageThroughSystem({
      imageBase64: image.imageBase64,
      imageMimeType: image.imageMimeType,
      title: post.title,
    });

    await updateBlogPostImageGenerationState(project.id, {
      ...runningState,
      message: "Saving regenerated blog post image.",
    });

    await updateBlogPostDraftImage({
      projectId: project.id,
      postId: post.id,
      imageArtifactId: imageMaterialization.artifactId,
      imageRepresentationRevisionId: imageMaterialization.representationRevisionId,
      imagePrompt: image.imagePrompt,
    });

    await updateBlogPostImageGenerationState(project.id, {
      status: "succeeded",
      message: "Generated a new blog post image.",
      updatedAt: new Date().toISOString(),
      jobId: _jobId,
      postId: post.id,
      postTitle: post.title,
    });

    const workerActor = getActorContext();
    const dashboardHref = workerActor
      ? await resolveBlogDashboardUrl(workerActor, project.id)
      : "/dashboards";
    await createNotification({
      title: "Blog post image regenerated",
      body: `Generated a new hero image for "${post.title}".`,
      kind: "success",
      href: dashboardHref,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      await updateBlogPostImageGenerationState(project.id, {
        status: "stopped",
        message: "Blog post image generation stopped.",
        updatedAt: new Date().toISOString(),
        jobId: _jobId,
        postId: post.id,
        postTitle: post.title,
      });
      return;
    }
    await updateBlogPostImageGenerationState(project.id, {
      status: "failed",
      message: error instanceof Error ? error.message : "Unable to regenerate the image.",
      updatedAt: new Date().toISOString(),
      jobId: _jobId,
      postId: post.id,
      postTitle: post.title,
    });
  } finally {
    unregisterBackgroundJobAbortController(_jobId);
  }
}

export async function startWordPressDraftCreation(input: {
  projectId: string;
  postId: string;
  wordpressInstanceId: string;
}) {
  const project = await readBlogPostsProjectById(input.projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }

  if (project.wordpressDraftGeneration.status === "running") {
    if (project.wordpressDraftGeneration.jobId && (await isBackgroundJobActive(project.wordpressDraftGeneration.jobId))) {
      return project.wordpressDraftGeneration;
    }
    await updateBlogPostWordPressDraftGenerationState(project.id, getDefaultBlogPostWordPressDraftState());
  }

  const post = project.posts.find((entry) => entry.id === input.postId);
  if (!post) {
    throw new Error("Blog post draft not found.");
  }

  // Idempotent no-op: if a prior WordPress draft already exists
  // for this {projectId,postId,wordpressInstanceId}, do NOT enqueue a new job.
  // Surface a succeeded envelope carrying the prior draft's refs so the
  // publish-agent's `blog_project_get` poll resolves on the existing state.
  const existingDraft = post.wordpressDrafts?.find(
    (d) => d.wordpressInstanceId === input.wordpressInstanceId && d.status !== "deleted",
  );
  if (existingDraft) {
    const idempotentState = {
      status: "succeeded" as const,
      message: "Existing WordPress draft reused (idempotent).",
      updatedAt: new Date().toISOString(),
      postId: post.id,
      postTitle: post.title,
      wordpressInstanceId: input.wordpressInstanceId,
      wordpressInstanceName: existingDraft.wordpressInstanceName,
      adminUrl: existingDraft.adminUrl,
      idempotentNoop: true,
      wordpressDraftId: existingDraft.id,
      wordpressPostId: existingDraft.wordpressPostId,
    };
    await updateBlogPostWordPressDraftGenerationState(project.id, idempotentState);
    return idempotentState;
  }

  const jobId = await enqueueBackgroundJob(BACKGROUND_JOB_NAMES.BLOG_POST_WORDPRESS_DRAFT_CREATION, {
    projectId: project.id,
    postId: post.id,
    wordpressInstanceId: input.wordpressInstanceId,
  });

  const runningState = {
    status: "running" as const,
    message: "Loading the latest published WordPress post.",
    updatedAt: new Date().toISOString(),
    jobId,
    postId: post.id,
    postTitle: post.title,
    wordpressInstanceId: input.wordpressInstanceId,
    wordpressInstanceName: undefined,
    adminUrl: undefined,
  };
  await updateBlogPostWordPressDraftGenerationState(project.id, runningState);

  return runningState;
}

export async function runWordPressDraftCreationJob(
  input: { projectId: string; postId: string; wordpressInstanceId: string },
  _jobId: string,
) {
  const project = await readBlogPostsProjectById(input.projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }

  const post = project.posts.find((entry) => entry.id === input.postId);
  if (!post) {
    throw new Error("Blog post draft not found.");
  }

  const runningState = {
    status: "running" as const,
    message: "Loading the latest published WordPress post.",
    updatedAt: new Date().toISOString(),
    jobId: _jobId,
    postId: post.id,
    postTitle: post.title,
    wordpressInstanceId: input.wordpressInstanceId,
    wordpressInstanceName: undefined,
    adminUrl: undefined,
  };
  const controller = new AbortController();
  registerBackgroundJobAbortController(_jobId, controller);

  try {
    throwIfAborted(controller.signal);

    // Resolve body bytes via the post-body-artifact reader before handing off
    // to the WordPress converter / publisher. The converter primitive's input
    // schema still takes `content: string`.
    const postBodyBytes =
      post.postArtifactId && post.postRepresentationRevisionId
        ? await readBlogPostBodyArtifactBytes({
            artifactId: post.postArtifactId,
            representationRevisionId: post.postRepresentationRevisionId,
          })
        : null;
    const resolvedPostBody = postBodyBytes?.body ?? "";

    // Check the MCP server for a site-specific content converter registered for
    // this WordPress instance. If one is found the converter runs and its output
    // (possibly pre-rendered HTML) replaces the raw markdown content before the
    // standard publish pipeline processes it.
    const blogTransport = createInProcessPrimitiveTransport(createBlogContentPrimitiveHandlers());
    const conversionResponse = await blogTransport.invoke({
      primitiveName: "blog_wordpress_content_convert",
      input: {
        wordpressInstanceId: input.wordpressInstanceId,
        title: post.title,
        excerpt: post.excerpt,
        content: resolvedPostBody,
      },
      actor: { actorType: "system", source: "worker" },
      mode: "system",
    });

    const convertedPost =
      conversionResponse.ok && (conversionResponse.output as { converted?: boolean } | undefined)?.converted
        ? (conversionResponse.output as { title: string; excerpt: string; content: string; contentIsHtml: boolean })
        : { title: post.title, excerpt: post.excerpt, content: resolvedPostBody, contentIsHtml: false };

    const published = await publishBlogPostDraftToWordPress({
      wordpressInstanceId: input.wordpressInstanceId,
      companyUrl: project.companyUrl,
      postTitle: convertedPost.title,
      postExcerpt: convertedPost.excerpt,
      blogPostContent: convertedPost.content,
      contentIsHtml: convertedPost.contentIsHtml,
      imageArtifactId: post.imageArtifactId,
      imageRepresentationRevisionId: post.imageRepresentationRevisionId,
      onProgress: async (message, instanceName) => {
        if (controller.signal.aborted) {
          return;
        }
        await updateBlogPostWordPressDraftGenerationState(project.id, {
          ...runningState,
          message,
          wordpressInstanceName: instanceName,
        });
      },
    });
    throwIfAborted(controller.signal);

    await updateBlogPostWordPressDraftGenerationState(project.id, {
      ...runningState,
      message: "Saving the WordPress draft link.",
      wordpressInstanceName: published.instance.name,
    });

    await saveWordPressDraftReference({
      projectId: project.id,
      postId: post.id,
      wordpressInstanceId: published.instance.id,
      wordpressInstanceName: published.instance.name,
      wordpressPostId: published.createdDraft.wordpressPostId,
      adminUrl: published.createdDraft.adminUrl,
      publicUrl: published.createdDraft.publicUrl,
      status: "draft",
    });

    await updateBlogPostWordPressDraftGenerationState(project.id, {
      status: "succeeded",
      message: `Created a WordPress draft in ${published.instance.name}.`,
      updatedAt: new Date().toISOString(),
      jobId: _jobId,
      postId: post.id,
      postTitle: post.title,
      wordpressInstanceId: published.instance.id,
      wordpressInstanceName: published.instance.name,
      adminUrl: published.createdDraft.adminUrl,
    });

    await createNotification({
      title: "WordPress draft created",
      body: `Created a draft for "${post.title}" in ${published.instance.name}.`,
      kind: "success",
      href: published.createdDraft.adminUrl,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      await updateBlogPostWordPressDraftGenerationState(project.id, {
        status: "stopped",
        message: "WordPress draft creation stopped.",
        updatedAt: new Date().toISOString(),
        jobId: _jobId,
        postId: post.id,
        postTitle: post.title,
        wordpressInstanceId: input.wordpressInstanceId,
        wordpressInstanceName: undefined,
        adminUrl: undefined,
      });
      return;
    }
    await updateBlogPostWordPressDraftGenerationState(project.id, {
      status: "failed",
      message: error instanceof Error ? error.message : "Unable to create the WordPress draft.",
      updatedAt: new Date().toISOString(),
      jobId: _jobId,
      postId: post.id,
      postTitle: post.title,
      wordpressInstanceId: input.wordpressInstanceId,
      wordpressInstanceName: undefined,
      adminUrl: undefined,
    });
  } finally {
    unregisterBackgroundJobAbortController(_jobId);
  }
}

// RETIRED. Text job 5 (`BLOG_POST_LINKEDIN_DRAFT_CREATION`) is replaced by
// `blog-linkedin-writer-agent` (`linkedin_flow`). The BullMQ constant, worker
// case, and `generateLinkedInPostDraftWithOpenAI` callsite are deleted; the
// stub remains so `blog-content-adapters.ts` and `route-handlers.ts` callers
// compile.
export async function startLinkedInDraftCreation(_input: {
  projectId: string;
  postId: string;
  linkedinAccountId: string;
  linkedinAccountName: string;
  linkedinUserId?: string;
  destinationType: "member" | "organization";
  destinationId: string;
  destinationName: string;
  blogPostUrl: string;
}): Promise<never> {
  throw new Error(
    "Retired. Use the blog-pipeline-agent " +
      "linkedin_flow (via `@cinatra-ai/blog-pipeline-agent`) instead. " +
      "`packages/asset-blog` keeps this stub for legacy callers.",
  );
}

export async function refreshWordPressDraftStatus(input: {
  projectId: string;
  postId: string;
  draftId: string;
}) {
  const project = await readBlogPostsProjectById(input.projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }

  const post = project.posts.find((entry) => entry.id === input.postId);
  const draft = post?.wordpressDrafts?.find((entry) => entry.id === input.draftId);
  if (!post || !draft) {
    throw new Error("WordPress draft reference not found.");
  }

  const instance = readWordPressInstanceById(draft.wordpressInstanceId);
  if (!instance) {
    throw new Error("Connected WordPress website not found.");
  }

  const status = await readWordPressPostStatus({
    instance,
    wordpressPostId: draft.wordpressPostId,
  });

  await updateWordPressDraftReference({
    projectId: input.projectId,
    postId: input.postId,
    draftId: draft.id,
    status: status.status,
    publicUrl: status.publicUrl,
    adminUrl: status.adminUrl,
  });

  return status;
}

export async function deleteWordPressDraft(input: {
  projectId: string;
  postId: string;
  draftId: string;
  deleteInWordPress?: boolean;
}) {
  const project = await readBlogPostsProjectById(input.projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }

  const post = project.posts.find((entry) => entry.id === input.postId);
  const draft = post?.wordpressDrafts?.find((entry) => entry.id === input.draftId);
  if (!post || !draft) {
    throw new Error("WordPress draft reference not found.");
  }

  if (input.deleteInWordPress) {
    const instance = readWordPressInstanceById(draft.wordpressInstanceId);
    if (!instance) {
      throw new Error("Connected WordPress website not found.");
    }
    await deleteWordPressPost({
      instance,
      wordpressPostId: draft.wordpressPostId,
    });
  }

  await deleteWordPressDraftReference({
    projectId: input.projectId,
    postId: input.postId,
    draftId: input.draftId,
  });
}

export async function publishLinkedInDraft(input: {
  projectId: string;
  postId: string;
  draftId: string;
}) {
  const project = await readBlogPostsProjectById(input.projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }

  if (project.linkedinDraftGeneration.status === "running") {
    if (project.linkedinDraftGeneration.jobId && (await isBackgroundJobActive(project.linkedinDraftGeneration.jobId))) {
      return project.linkedinDraftGeneration;
    }
    await updateBlogPostLinkedInDraftGenerationState(project.id, getDefaultBlogPostLinkedInDraftState());
  }

  const post = project.posts.find((entry) => entry.id === input.postId);
  const draft = post?.linkedinDrafts?.find((entry) => entry.id === input.draftId);
  if (!post || !draft) {
    throw new Error("LinkedIn draft not found.");
  }

  const hasPublishedWordPressDraft = (post.wordpressDrafts ?? []).some((entry) => entry.status === "publish" && entry.publicUrl);
  if (!hasPublishedWordPressDraft) {
    throw new Error("Publish the blog post on WordPress before publishing on LinkedIn.");
  }

  const alreadyPublishedLinkedInDraft = (post.linkedinDrafts ?? []).some((entry) => entry.status === "published");
  if (alreadyPublishedLinkedInDraft) {
    throw new Error("A LinkedIn post has already been published for this blog post.");
  }

  const jobId = await enqueueBackgroundJob(BACKGROUND_JOB_NAMES.BLOG_POST_LINKEDIN_DRAFT_PUBLISH, {
    projectId: project.id,
    postId: post.id,
    draftId: draft.id,
  });

  const runningState = {
    status: "running" as const,
    message: "Preparing the LinkedIn post for publishing.",
    updatedAt: new Date().toISOString(),
    jobId,
    operation: "publish" as const,
    postId: post.id,
    postTitle: post.title,
    linkedinAccountId: draft.linkedinAccountId,
    linkedinAccountName: draft.linkedinAccountName,
    linkedinUserId: draft.linkedinUserId,
    destinationType: draft.destinationType,
    destinationId: draft.destinationId,
    destinationName: draft.destinationName,
    linkedinPostUrl: undefined,
  };
  await updateBlogPostLinkedInDraftGenerationState(project.id, runningState);

  return runningState;
}

export async function runLinkedInDraftPublishJob(input: { projectId: string; postId: string; draftId: string }, _jobId: string) {
  const project = await readBlogPostsProjectById(input.projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }

  const post = project.posts.find((entry) => entry.id === input.postId);
  const draft = post?.linkedinDrafts?.find((entry) => entry.id === input.draftId);
  if (!post || !draft) {
    throw new Error("LinkedIn draft not found.");
  }

  const runningState = {
    status: "running" as const,
    message: "Preparing the LinkedIn post for publishing.",
    updatedAt: new Date().toISOString(),
    jobId: _jobId,
    operation: "publish" as const,
    postId: post.id,
    postTitle: post.title,
    linkedinAccountId: draft.linkedinAccountId,
    linkedinAccountName: draft.linkedinAccountName,
    linkedinUserId: draft.linkedinUserId,
    destinationType: draft.destinationType,
    destinationId: draft.destinationId,
    destinationName: draft.destinationName,
    linkedinPostUrl: undefined,
  };
  const controller = new AbortController();
  registerBackgroundJobAbortController(_jobId, controller);

  try {
    throwIfAborted(controller.signal);
    await updateBlogPostLinkedInDraftGenerationState(project.id, {
      ...runningState,
      message: "Publishing the LinkedIn post.",
    });

    // Resolve LinkedIn copy bytes via the post-body artifact reader.
    const draftContentBytes =
      draft.contentArtifactId && draft.contentRepresentationRevisionId
        ? await readBlogPostBodyArtifactBytes({
            artifactId: draft.contentArtifactId,
            representationRevisionId: draft.contentRepresentationRevisionId,
          })
        : null;

    const published = await publishSocialMediaPostThroughSystem(
      {
        accountId: draft.linkedinAccountId,
        destinationType: draft.destinationType,
        destinationId: draft.destinationId,
        content: draftContentBytes?.body ?? "",
      },
      {
        connectorId: "linkedin",
        userId: draft.linkedinUserId,
      },
    );
    throwIfAborted(controller.signal);

    await updateBlogPostLinkedInDraftGenerationState(project.id, {
      ...runningState,
      message: "Saving the LinkedIn post link.",
      linkedinPostUrl: published.providerPostUrl,
    });

    await updateLinkedInDraftReference({
      projectId: project.id,
      postId: post.id,
      draftId: draft.id,
      status: "published",
      linkedinPostUrn: published.providerPostId,
      linkedinPostUrl: published.providerPostUrl,
      publishedAt: published.publishedAt,
    });

    await updateBlogPostLinkedInDraftGenerationState(project.id, {
      status: "succeeded",
      message: `Published the LinkedIn post for ${draft.destinationName}.`,
      updatedAt: new Date().toISOString(),
      jobId: _jobId,
      operation: "publish",
      postId: post.id,
      postTitle: post.title,
      linkedinAccountId: draft.linkedinAccountId,
      linkedinAccountName: draft.linkedinAccountName,
      linkedinUserId: draft.linkedinUserId,
      destinationType: draft.destinationType,
      destinationId: draft.destinationId,
      destinationName: draft.destinationName,
      linkedinPostUrl: published.providerPostUrl,
    });

    await createNotification({
      title: "LinkedIn post published",
      body: `Published the LinkedIn post for "${post.title}".`,
      kind: "success",
      href: published.providerPostUrl,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      await updateBlogPostLinkedInDraftGenerationState(project.id, {
        status: "stopped",
        message: "LinkedIn publishing stopped.",
        updatedAt: new Date().toISOString(),
        jobId: _jobId,
        operation: "publish",
        postId: post.id,
        postTitle: post.title,
        linkedinAccountId: draft.linkedinAccountId,
        linkedinAccountName: draft.linkedinAccountName,
        linkedinUserId: draft.linkedinUserId,
        destinationType: draft.destinationType,
        destinationId: draft.destinationId,
        destinationName: draft.destinationName,
        linkedinPostUrl: undefined,
      });
      return;
    }
    await updateBlogPostLinkedInDraftGenerationState(project.id, {
      status: "failed",
      message: error instanceof Error ? error.message : "Unable to publish the LinkedIn post.",
      updatedAt: new Date().toISOString(),
      jobId: _jobId,
      operation: "publish",
      postId: post.id,
      postTitle: post.title,
      linkedinAccountId: draft.linkedinAccountId,
      linkedinAccountName: draft.linkedinAccountName,
      linkedinUserId: draft.linkedinUserId,
      destinationType: draft.destinationType,
      destinationId: draft.destinationId,
      destinationName: draft.destinationName,
      linkedinPostUrl: undefined,
    });
  } finally {
    unregisterBackgroundJobAbortController(_jobId);
  }
}

export async function stopBlogPostIdeaGeneration(projectId: string) {
  const project = await readBlogPostsProjectById(projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }
  if (project.ideaGeneration.jobId) {
    await cancelBackgroundJob(project.ideaGeneration.jobId);
  }
  await updateBlogPostIdeaGenerationState(project.id, {
    ...project.ideaGeneration,
    status: "stopped",
    message: "Blog post idea generation stopped.",
    updatedAt: new Date().toISOString(),
  });
  return await readBlogPostsProjectById(projectId);
}

export async function stopBlogPostDraftGeneration(projectId: string) {
  const project = await readBlogPostsProjectById(projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }
  if (project.postGeneration.jobId) {
    await cancelBackgroundJob(project.postGeneration.jobId);
  }
  await updateBlogPostDraftGenerationState(project.id, {
    ...project.postGeneration,
    status: "stopped",
    message: "Blog post generation stopped.",
    updatedAt: new Date().toISOString(),
  });
  return await readBlogPostsProjectById(projectId);
}

export async function stopBlogPostImageRegeneration(projectId: string) {
  const project = await readBlogPostsProjectById(projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }
  // Terminal-state guard (mirrors stopLinkedInDraftGeneration). Without it a
  // cancel racing job completion clobbers a succeeded/failed status with
  // `stopped`, erasing the outcome of an already-finished job — and, in the
  // dashboard portlet's manual refSwapMode, suppressing the keep/revert gate
  // even though the new image was already applied by the pipeline.
  const currentStatus = project.imageGeneration.status;
  if (
    currentStatus === "succeeded" ||
    currentStatus === "failed" ||
    currentStatus === "stopped"
  ) {
    return project;
  }
  if (project.imageGeneration.jobId) {
    await cancelBackgroundJob(project.imageGeneration.jobId);
  }
  // The worker may have committed a terminal state (e.g. `succeeded`) while
  // the cancel round-trip above was in flight. The store-level conditional
  // transition re-checks and writes in ONE synchronous block (no await
  // boundary), so an already-terminal outcome is never clobbered.
  await markBlogPostImageGenerationStoppedIfRunning(project.id, "Blog post image generation stopped.");
  return await readBlogPostsProjectById(projectId);
}

export async function stopWordPressDraftCreation(projectId: string) {
  const project = await readBlogPostsProjectById(projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }
  if (project.wordpressDraftGeneration.jobId) {
    await cancelBackgroundJob(project.wordpressDraftGeneration.jobId);
  }
  await updateBlogPostWordPressDraftGenerationState(project.id, {
    ...project.wordpressDraftGeneration,
    status: "stopped",
    message: "WordPress draft creation stopped.",
    updatedAt: new Date().toISOString(),
  });
  return await readBlogPostsProjectById(projectId);
}

export async function stopLinkedInDraftGeneration(projectId: string) {
  const project = await readBlogPostsProjectById(projectId);
  if (!project) {
    throw new Error("Blog posts project not found.");
  }
  // Terminal-state guard. Without it, this clobbers a succeeded/failed/stopped
  // status with `stopped`, erasing the outcome of an already-finished job
  // (e.g. losing the `linkedinPostUrl` of a successful publish) and making the
  // blog-linkedin-publish-agent reject path destroy real state when called
  // after `_publish` already succeeded.
  const currentStatus = project.linkedinDraftGeneration.status;
  if (
    currentStatus === "succeeded" ||
    currentStatus === "failed" ||
    currentStatus === "stopped"
  ) {
    return project;
  }
  if (project.linkedinDraftGeneration.jobId) {
    await cancelBackgroundJob(project.linkedinDraftGeneration.jobId);
  }
  await updateBlogPostLinkedInDraftGenerationState(project.id, {
    ...project.linkedinDraftGeneration,
    status: "stopped",
    message:
      project.linkedinDraftGeneration.operation === "publish"
        ? "LinkedIn publishing stopped."
        : "LinkedIn draft creation stopped.",
    updatedAt: new Date().toISOString(),
  });
  return await readBlogPostsProjectById(projectId);
}
