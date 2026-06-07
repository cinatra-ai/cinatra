import {
  readBlogPostsProjects,
  readBlogPostsProjectById,
  readBlogPostDraftById,
  readSavedMedia,
  listAvailableTranscriptOptions,
  saveBlogPostImageToMediaLibrary,
  saveBlogPostPersonalSkillReference as saveBlogPersonalSkillRef,
  updateBlogPostDraftContent,
  updateBlogPostDraftRefs,
  updateLinkedInDraftReference,
} from "../store";
import { materializeBlogPostBodyArtifact } from "@/lib/blog-post-artifact-materializer";
import {
  startBlogPostIdeaGeneration,
  stopBlogPostIdeaGeneration,
  startBlogPostDraftGeneration,
  stopBlogPostDraftGeneration,
  startBlogPostImageRegeneration,
  stopBlogPostImageRegeneration,
  startWordPressDraftCreation,
  stopWordPressDraftCreation,
  deleteWordPressDraft,
  refreshWordPressDraftStatus,
  startLinkedInDraftCreation,
  stopLinkedInDraftGeneration,
  publishLinkedInDraft,
} from "../generation";
import type {
  BlogProjectPort,
  BlogIdeaGenerationPort,
  BlogDraftGenerationPort,
  BlogImageGenerationPort,
  BlogPublishingPort,
  BlogMediaPort,
} from "../ports/blog-content";

export function createBlogProjectPort(): BlogProjectPort {
  return {
    listProjects: () => readBlogPostsProjects(),
    getProjectById: async (projectId) => (await readBlogPostsProjectById(projectId)) ?? undefined,
    getPostById: async (projectId, postId) => (await readBlogPostDraftById(projectId, postId)) ?? undefined,
    listAvailableTranscripts: () => listAvailableTranscriptOptions(),
    listSavedMedia: () => readSavedMedia(),
  };
}

export function createBlogIdeaGenerationPort(): BlogIdeaGenerationPort {
  return {
    startIdeaGeneration: (input) => startBlogPostIdeaGeneration(input) as any,
    stopIdeaGeneration: async (projectId) => (await stopBlogPostIdeaGeneration(projectId)) as any,
  };
}

export function createBlogDraftGenerationPort(): BlogDraftGenerationPort {
  return {
    startDraftGeneration: async (input) => { await startBlogPostDraftGeneration(input); },
    stopDraftGeneration: async (projectId) => (await stopBlogPostDraftGeneration(projectId)) as any,
    // The UI edit-save port still carries raw `content: string`. Materialize
    // at the adapter boundary so the store only ever sees artifact refs.
    updateDraftContent: async (input) => {
      const materialized = await materializeBlogPostBodyArtifact({
        content: input.content,
        title: input.title,
      });
      await updateBlogPostDraftContent({
        projectId: input.projectId,
        postId: input.postId,
        title: input.title,
        excerpt: input.excerpt,
        postArtifactId: materialized.artifactId,
        postRepresentationRevisionId: materialized.representationRevisionId,
      });
    },
    // Refs-only swap (artifact-edit-text portlet): the caller
    // already minted the new artifact, so we swap refs without re-materializing.
    updateDraftRefs: async (input) => {
      await updateBlogPostDraftRefs(input);
    },
  };
}

export function createBlogImageGenerationPort(): BlogImageGenerationPort {
  return {
    startImageRegeneration: (input) =>
      startBlogPostImageRegeneration({
        projectId: input.projectId,
        postId: input.postId,
        customPrompt: input.prompt,
      }) as any,
    stopImageRegeneration: async (projectId) => (await stopBlogPostImageRegeneration(projectId)) as any,
  };
}

export function createBlogPublishingPort(): BlogPublishingPort {
  return {
    startWordPressDraftCreation: (input) => startWordPressDraftCreation(input) as any,
    stopWordPressDraftCreation: async (projectId) => (await stopWordPressDraftCreation(projectId)) as any,
    deleteWordPressDraft: (input) => deleteWordPressDraft({
      projectId: input.projectId,
      postId: input.postId,
      draftId: input.wordpressDraftId,
      // Preserve the caller's intent so reject paths can delete remote
      // WordPress drafts when requested.
      deleteInWordPress: input.deleteInWordPress,
    }),
    refreshWordPressDraftStatus: async (input) => { await refreshWordPressDraftStatus({ projectId: input.projectId, postId: input.postId, draftId: input.wordpressDraftId }); },
    // Pass input through directly so the operator-supplied LinkedIn account
    // name reaches the approval payload, persisted draft, and notification.
    startLinkedInDraftCreation: (input) => startLinkedInDraftCreation(input) as any,
    stopLinkedInDraftCreation: async (projectId) => (await stopLinkedInDraftGeneration(projectId)) as any,
    // Map port-level `linkedinDraftId` to the store-internal `draftId` so the
    // use-case, port, and handler share the external shape.
    //
    // Publish-agent callers pass artifact refs directly after materializing
    // operator edits. This adapter remains a thin pass-through and does not
    // materialize host-side content.
    updateLinkedInDraft: async (input) => {
      await updateLinkedInDraftReference({
        projectId: input.projectId,
        postId: input.postId,
        draftId: input.linkedinDraftId,
        contentArtifactId: input.contentArtifactId,
        contentRepresentationRevisionId: input.contentRepresentationRevisionId,
      });
    },
    publishLinkedInDraft: (input) => publishLinkedInDraft({ projectId: input.projectId, postId: input.postId, draftId: input.linkedinDraftId }) as any,
    stopLinkedInDraftPublish: async (projectId) => (await stopLinkedInDraftGeneration(projectId)) as any,
  };
}

export function createBlogMediaPort(): BlogMediaPort {
  return {
    saveImageToMediaLibrary: (input) => saveBlogPostImageToMediaLibrary(input),
    savePersonalSkillReference: (input) => saveBlogPersonalSkillRef(input),
  };
}
