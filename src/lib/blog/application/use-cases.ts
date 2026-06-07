// LOCAL_USER_ID is kept out of production paths; the dev-bypass fallback
// resolves dynamically inside guarded blocks below.
import { buildDefaultPersonalSkillName, upsertPersonalSkill } from "@cinatra-ai/skills";
import {
  createBlogProjectPort,
  createBlogIdeaGenerationPort,
  createBlogDraftGenerationPort,
  createBlogImageGenerationPort,
  createBlogPublishingPort,
  createBlogMediaPort,
} from "../integration/blog-content-adapters";
import type {
  BlogProjectPort,
  BlogIdeaGenerationPort,
  BlogDraftGenerationPort,
  BlogImageGenerationPort,
  BlogPublishingPort,
  BlogMediaPort,
} from "../ports/blog-content";

export function createBlogContentUseCases(
  projectPort: BlogProjectPort = createBlogProjectPort(),
  ideaGenerationPort: BlogIdeaGenerationPort = createBlogIdeaGenerationPort(),
  draftGenerationPort: BlogDraftGenerationPort = createBlogDraftGenerationPort(),
  imageGenerationPort: BlogImageGenerationPort = createBlogImageGenerationPort(),
  publishingPort: BlogPublishingPort = createBlogPublishingPort(),
  mediaPort: BlogMediaPort = createBlogMediaPort(),
) {
  return {
    listProjects: () => projectPort.listProjects(),
    getProject: (projectId: string) => projectPort.getProjectById(projectId),
    getPost: (projectId: string, postId: string) => projectPort.getPostById(projectId, postId),
    listAvailableTranscripts: () => projectPort.listAvailableTranscripts(),
    listSavedMedia: () => projectPort.listSavedMedia(),

    startIdeaGeneration: (input: {
      name: string;
      companyUrl: string;
      ideasPerTranscript: number;
      transcriptIds: string[];
    }) => ideaGenerationPort.startIdeaGeneration(input),

    stopIdeaGeneration: (projectId: string) => ideaGenerationPort.stopIdeaGeneration(projectId),

    startDraftGeneration: (input: { projectId: string; ideaId: string }) =>
      draftGenerationPort.startDraftGeneration(input),

    stopDraftGeneration: (projectId: string) => draftGenerationPort.stopDraftGeneration(projectId),

    updateDraftContent: (input: {
      projectId: string;
      postId: string;
      title: string;
      excerpt: string;
      content: string;
    }) => draftGenerationPort.updateDraftContent(input),

    // Refs-only swap path for the artifact-edit-text portlet.
    updateDraftRefs: (input: {
      projectId: string;
      postId: string;
      postArtifactId: string;
      postRepresentationRevisionId: string;
      imageArtifactId?: string;
      imageRepresentationRevisionId?: string;
    }) => draftGenerationPort.updateDraftRefs(input),

    startImageRegeneration: (input: {
      projectId: string;
      postId: string;
      prompt?: string;
    }) => imageGenerationPort.startImageRegeneration(input),

    stopImageRegeneration: (projectId: string) => imageGenerationPort.stopImageRegeneration(projectId),

    startWordPressDraftCreation: (input: {
      projectId: string;
      postId: string;
      wordpressInstanceId: string;
    }) => publishingPort.startWordPressDraftCreation(input),

    stopWordPressDraftCreation: (projectId: string) => publishingPort.stopWordPressDraftCreation(projectId),

    deleteWordPressDraft: (input: {
      projectId: string;
      postId: string;
      wordpressDraftId: string;
      // Pass through to the adapter; when true the connector also deletes the
      // draft from WordPress itself.
      deleteInWordPress?: boolean;
    }) => publishingPort.deleteWordPressDraft(input),

    refreshWordPressDraftStatus: (input: {
      projectId: string;
      postId: string;
      wordpressDraftId: string;
    }) => publishingPort.refreshWordPressDraftStatus(input),

    startLinkedInDraftCreation: (input: {
      projectId: string;
      postId: string;
      linkedinAccountId: string;
      // Required by the port and generation contract. Keeping this non-optional
      // prevents the adapter from overriding it to "" without a typecheck complaint.
      linkedinAccountName: string;
      destinationType: "member" | "organization";
      destinationId: string;
      destinationName: string;
      blogPostUrl: string;
    }) => publishingPort.startLinkedInDraftCreation(input),

    stopLinkedInDraftCreation: (projectId: string) => publishingPort.stopLinkedInDraftCreation(projectId),

    // Persist operator edits made at the HITL gate before publishing.
    // MCP-shaped (linkedinDraftId, not draftId).
    //
    // Input takes refs only; agent materializes operator-edited copy via
    // `artifact_authoring_emit`.
    updateLinkedInDraft: (input: {
      projectId: string;
      postId: string;
      linkedinDraftId: string;
      contentArtifactId: string;
      contentRepresentationRevisionId: string;
    }) => publishingPort.updateLinkedInDraft(input),

    publishLinkedInDraft: (input: {
      projectId: string;
      postId: string;
      linkedinDraftId: string;
      linkedinAccountId: string;
    }) => publishingPort.publishLinkedInDraft(input),

    stopLinkedInDraftPublish: (projectId: string) => publishingPort.stopLinkedInDraftPublish(projectId),

    saveImageToMediaLibrary: (input: {
      projectId: string;
      postId: string;
      title?: string;
      description?: string;
    }) => mediaPort.saveImageToMediaLibrary(input),

    async createPersonalSkill(input: { projectId: string; postId: string }) {
      const draft = await projectPort.getPostById(input.projectId, input.postId);
      if (!draft) {
        throw new Error("Blog post draft not found.");
      }
      const savedPrompts = (draft.savedPrompts ?? []).filter((entry) => entry.prompt.trim().length > 0);
      if (savedPrompts.length === 0) {
        throw new Error("No saved prompts are available for this draft yet.");
      }
      const skillName = buildDefaultPersonalSkillName({
        campaignName: draft.title,
        sourceLabel: "Blog Post Image Prompts",
      });
      let blogOwnerUserId = (input as { ownerUserId?: string }).ownerUserId;
      if (!blogOwnerUserId) {
        if (process.env.BETTER_AUTH_DEV_BYPASS === "true") {
          const skillsConstants = await import("@cinatra-ai/skills");
          blogOwnerUserId = (skillsConstants as { LOCAL_USER_ID?: string }).LOCAL_USER_ID;
        }
        if (!blogOwnerUserId) {
          throw new Error(
            "blog use-case: ownerUserId required.",
          );
        }
      }
      // Write the assignment row alongside the catalog row. asset-blog has no
      // team/org agent ownership today, so this resolves to user scope.
      const skill = await upsertPersonalSkill({
        ownerUserId: blogOwnerUserId,
        agentId: "asset-blog",
        name: skillName,
        description: "Personal skill created from saved blog post image-regeneration prompts.",
        content: skillName,
        ownerType: "user",
        ownerId: blogOwnerUserId,
        createdBy: blogOwnerUserId,
      });
      await mediaPort.savePersonalSkillReference({
        projectId: input.projectId,
        postId: input.postId,
        skillId: skill.id,
        skillName: skill.name,
      });
      return { skillId: skill.id, skillName: skill.name };
    },
  };
}

export type BlogContentUseCases = ReturnType<typeof createBlogContentUseCases>;
