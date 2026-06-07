import type {
  BlogPostsProjectRecord,
  BlogPostDraftRecord,
  SavedMediaRecord,
  AvailableTranscriptOption,
  BlogPostIdeaGenerationState,
  BlogPostDraftGenerationState,
  BlogPostImageGenerationState,
  BlogPostWordPressDraftState,
  BlogPostLinkedInDraftState,
} from "../store";

/** Read/write access to blog projects and posts. */
export type BlogProjectPort = {
  listProjects(): Promise<BlogPostsProjectRecord[]>;
  getProjectById(projectId: string): Promise<BlogPostsProjectRecord | undefined>;
  getPostById(projectId: string, postId: string): Promise<BlogPostDraftRecord | undefined>;
  listAvailableTranscripts(): Promise<AvailableTranscriptOption[]>;
  listSavedMedia(): Promise<SavedMediaRecord[]>;
};

/** Manages idea generation jobs. */
export type BlogIdeaGenerationPort = {
  startIdeaGeneration(input: {
    name: string;
    companyUrl: string;
    ideasPerTranscript: number;
    transcriptIds: string[];
  }): Promise<BlogPostsProjectRecord>;
  stopIdeaGeneration(projectId: string): Promise<BlogPostsProjectRecord>;
};

/** Manages post draft generation jobs. */
export type BlogDraftGenerationPort = {
  startDraftGeneration(input: { projectId: string; ideaId: string }): Promise<void>;
  stopDraftGeneration(projectId: string): Promise<BlogPostsProjectRecord>;
  updateDraftContent(input: {
    projectId: string;
    postId: string;
    title: string;
    excerpt: string;
    content: string;
  }): Promise<void>;
  // Refs-only swap (caller already minted the artifact).
  updateDraftRefs(input: {
    projectId: string;
    postId: string;
    postArtifactId: string;
    postRepresentationRevisionId: string;
    imageArtifactId?: string;
    imageRepresentationRevisionId?: string;
  }): Promise<void>;
};

/** Manages image generation jobs. */
export type BlogImageGenerationPort = {
  startImageRegeneration(input: {
    projectId: string;
    postId: string;
    prompt?: string;
    personalSkillId?: string;
  }): Promise<BlogPostImageGenerationState>;
  stopImageRegeneration(projectId: string): Promise<BlogPostImageGenerationState>;
};

/** Manages WordPress and LinkedIn publishing. */
export type BlogPublishingPort = {
  startWordPressDraftCreation(input: {
    projectId: string;
    postId: string;
    wordpressInstanceId: string;
  }): Promise<BlogPostWordPressDraftState>;
  stopWordPressDraftCreation(projectId: string): Promise<BlogPostWordPressDraftState>;
  deleteWordPressDraft(input: {
    projectId: string;
    postId: string;
    wordpressDraftId: string;
    // When true, also deletes the draft from WordPress itself via the
    // connector; default false = local reference only.
    deleteInWordPress?: boolean;
  }): Promise<void>;
  refreshWordPressDraftStatus(input: {
    projectId: string;
    postId: string;
    wordpressDraftId: string;
  }): Promise<void>;
  startLinkedInDraftCreation(input: {
    projectId: string;
    postId: string;
    linkedinAccountId: string;
    // Required to match the underlying generation.ts contract.
    // Preserves operator-provided account identity for draft creation.
    linkedinAccountName: string;
    destinationType: "member" | "organization";
    destinationId: string;
    destinationName: string;
    blogPostUrl: string;
  }): Promise<BlogPostLinkedInDraftState>;
  stopLinkedInDraftCreation(projectId: string): Promise<BlogPostLinkedInDraftState>;
  // Persist operator edits made at the HITL gate before publish.
  // linkedinDraftId is MCP-shaped; the adapter maps it to the store's
  // internal `draftId`.
  //
  // Input content is passed as artifact refs. The agent materializes
  // operator-edited copy via `artifact_authoring_emit` before calling
  // this port.
  updateLinkedInDraft(input: {
    projectId: string;
    postId: string;
    linkedinDraftId: string;
    contentArtifactId: string;
    contentRepresentationRevisionId: string;
  }): Promise<void>;
  publishLinkedInDraft(input: {
    projectId: string;
    postId: string;
    linkedinDraftId: string;
    linkedinAccountId: string;
  }): Promise<BlogPostLinkedInDraftState>;
  stopLinkedInDraftPublish(projectId: string): Promise<BlogPostLinkedInDraftState>;
};

/** Manages media library. */
export type BlogMediaPort = {
  saveImageToMediaLibrary(input: {
    projectId: string;
    postId: string;
    title?: string;
    description?: string;
  }): Promise<SavedMediaRecord | undefined>;
  savePersonalSkillReference(input: {
    projectId: string;
    postId: string;
    skillId: string;
    skillName: string;
  }): Promise<void>;
};

export type {
  BlogPostsProjectRecord,
  BlogPostDraftRecord,
  SavedMediaRecord,
  AvailableTranscriptOption,
} from "../store";
