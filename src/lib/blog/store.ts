import "server-only";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { isBackgroundJobExecutionContext } from "@/lib/background-jobs";
// The canonical `cinatra.objects` substrate is the single source of truth for
// blog data. The legacy `source_config:asset-blog` metadata blob and
// fire-and-forget shadow path are no longer authoritative.
import { readObjectsByType, upsertObjectAndEnqueue } from "@/lib/objects-store";
import { getActorContext } from "@cinatra-ai/llm/actor-context";
import {
  assembleStoreFromObjectRows,
  decomposeStoreToObjectRows,
  type CodecObjectRow,
} from "@/lib/blog/integration/asset-blog-store-codec";
import {
  ASSETS_BLOG_PROJECT_TYPE,
  ASSETS_BLOG_IDEA_TYPE,
  ASSETS_BLOG_POST_TYPE,
} from "@/lib/blog/integration/asset-blog-backfill";
import type { BackgroundProcessRunStatus, BackgroundProcessState } from "@cinatra-ai/sdk-ui";
// The idea summary body lives in `@cinatra-ai/blog-idea-artifact`. The record
// carries refs and operational metadata. Title stays as structured metadata,
// not body.
export type BlogPostIdeaRecord = {
  id: string;
  transcriptId: string;
  transcriptTitle: string;
  title: string;
  summaryArtifactId?: string;
  summaryRepresentationRevisionId?: string;
  createdAt: string;
};

export type BlogPostDraftRecord = {
  id: string;
  ideaId: string;
  title: string;
  excerpt: string;
  // Image bytes live only in `@cinatra-ai/blog-image-artifact` rows. The post
  // body lives in `@cinatra-ai/blog-post-artifact`; the record carries refs
  // and operational metadata. Consumers read bytes via the reader helper
  // (`readBlogPostBodyArtifactBytes`) or the artifact-content route
  // (`/api/artifacts/...`) for the image.
  postArtifactId?: string;
  postRepresentationRevisionId?: string;
  imageArtifactId?: string;
  imageRepresentationRevisionId?: string;
  imagePrompt?: string;
  savedPrompts?: Array<{
    prompt: string;
    createdAt: string;
  }>;
  personalSkillId?: string;
  personalSkillName?: string;
  personalSkillCreatedAt?: string;
  // `updatedAt` is required so the SKILL.md tiebreaker can pick the entry with
  // the latest update, and so the coalesce upsert in saveLinkedInDraftReference
  // has a stable bump field. Stamped on every save/update path; backfilled on
  // read for entries persisted before this field existed.
  //
  // LinkedIn copy reuses `@cinatra-ai/blog-post-artifact`; the draft entry
  // carries refs and operational metadata only.
  linkedinDrafts?: Array<{
    id: string;
    linkedinAccountId: string;
    linkedinAccountName: string;
    linkedinUserId?: string;
    destinationType: "member" | "organization";
    destinationId: string;
    destinationName: string;
    contentArtifactId?: string;
    contentRepresentationRevisionId?: string;
    blogPostUrl: string;
    status?: "draft" | "published";
    linkedinPostUrn?: string;
    linkedinPostUrl?: string;
    publishedAt?: string;
    createdAt: string;
    updatedAt: string;
  }>;
  wordpressDrafts?: Array<{
    id: string;
    wordpressInstanceId: string;
    wordpressInstanceName: string;
    wordpressPostId: number;
    adminUrl: string;
    publicUrl?: string;
    status?: string;
    lastCheckedAt?: string;
    createdAt: string;
    updatedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

// Saved-media bytes live in `@cinatra-ai/blog-image-artifact` rows (same
// artifact extension as inline blog post hero images). The record exists only
// for rows normalized to refs, or removed when no bytes are resolvable. The
// `media_save` primitive has no new writers for this record shape.
export type SavedMediaRecord = {
  id: string;
  kind: "image";
  title: string;
  description?: string;
  imageArtifactId?: string;
  imageRepresentationRevisionId?: string;
  sourceProjectId?: string;
  sourceProjectName?: string;
  sourcePostId?: string;
  sourcePostTitle?: string;
  createdAt: string;
  updatedAt: string;
};

export type BlogPostIdeaGenerationState = BackgroundProcessState<BackgroundProcessRunStatus> & {
  totalCount: number;
  completedCount: number;
  failedCount: number;
  currentTranscriptTitle?: string;
};

export type BlogPostDraftGenerationState = BackgroundProcessState<BackgroundProcessRunStatus> & {
  ideaId?: string;
  ideaTitle?: string;
  postId?: string;
};

export type BlogPostWordPressDraftState = BackgroundProcessState<BackgroundProcessRunStatus> & {
  postId?: string;
  postTitle?: string;
  wordpressInstanceId?: string;
  wordpressInstanceName?: string;
  adminUrl?: string;
  // Additive idempotency metadata. When a prior WordPress draft
  // exists for the same {projectId,postId,wordpressInstanceId}, the start
  // primitive short-circuits and surfaces these markers (+ the prior draft refs)
  // so the publish-agent's poll loop resolves on the existing succeeded state.
  idempotentNoop?: boolean;
  wordpressDraftId?: string;
  wordpressPostId?: number;
};

export type BlogPostImageGenerationState = BackgroundProcessState<BackgroundProcessRunStatus> & {
  postId?: string;
  postTitle?: string;
};

export type BlogPostLinkedInDraftState = BackgroundProcessState<BackgroundProcessRunStatus> & {
  operation?: "draft" | "publish";
  postId?: string;
  postTitle?: string;
  linkedinAccountId?: string;
  linkedinAccountName?: string;
  linkedinUserId?: string;
  destinationType?: "member" | "organization";
  destinationId?: string;
  destinationName?: string;
  linkedinPostUrl?: string;
};

export type BlogPostsProjectRecord = {
  id: string;
  name: string;
  companyUrl: string;
  ideasPerTranscript: number;
  transcriptIds: string[];
  createdAt: string;
  updatedAt: string;
  ideas: BlogPostIdeaRecord[];
  posts: BlogPostDraftRecord[];
  ideaGeneration: BlogPostIdeaGenerationState;
  postGeneration: BlogPostDraftGenerationState;
  imageGeneration: BlogPostImageGenerationState;
  wordpressDraftGeneration: BlogPostWordPressDraftState;
  linkedinDraftGeneration: BlogPostLinkedInDraftState;
};

type BlogPostsStore = {
  projects: BlogPostsProjectRecord[];
  media: SavedMediaRecord[];
};

export type AvailableTranscriptOption = {
  id: string;
  title: string;
  generatorId: string;
  generatorName: string;
  createdAt: string;
  transcript: string;
  itemUrl?: string;
};

const STORE_KEY = "asset-blog";

function nowIso() {
  return new Date().toISOString();
}

function safeRevalidatePath(path: string) {
  if (isBackgroundJobExecutionContext()) {
    return;
  }
  revalidatePath(path);
}

export function getDefaultBlogPostIdeaGenerationState(): BlogPostIdeaGenerationState {
  return {
    status: "idle",
    message: "No idea generation is currently running.",
    updatedAt: nowIso(),
    jobId: undefined,
    totalCount: 0,
    completedCount: 0,
    failedCount: 0,
    currentTranscriptTitle: undefined,
  };
}

export function getDefaultBlogPostDraftGenerationState(): BlogPostDraftGenerationState {
  return {
    status: "idle",
    message: "No blog post draft generation is currently running.",
    updatedAt: nowIso(),
    jobId: undefined,
    ideaId: undefined,
    ideaTitle: undefined,
    postId: undefined,
  };
}

export function getDefaultBlogPostWordPressDraftState(): BlogPostWordPressDraftState {
  return {
    status: "idle",
    message: "No WordPress draft creation is currently running.",
    updatedAt: nowIso(),
    jobId: undefined,
    postId: undefined,
    postTitle: undefined,
    wordpressInstanceId: undefined,
    wordpressInstanceName: undefined,
    adminUrl: undefined,
  };
}

export function getDefaultBlogPostImageGenerationState(): BlogPostImageGenerationState {
  return {
    status: "idle",
    message: "No image regeneration is currently running.",
    updatedAt: nowIso(),
    jobId: undefined,
    postId: undefined,
    postTitle: undefined,
  };
}

export function getDefaultBlogPostLinkedInDraftState(): BlogPostLinkedInDraftState {
  return {
    status: "idle",
    message: "No LinkedIn draft generation is currently running.",
    updatedAt: nowIso(),
    jobId: undefined,
    operation: "draft",
    postId: undefined,
    postTitle: undefined,
    linkedinAccountId: undefined,
    linkedinAccountName: undefined,
    destinationType: undefined,
    destinationId: undefined,
    destinationName: undefined,
    linkedinPostUrl: undefined,
  };
}

function getDefaultStore(): BlogPostsStore {
  return {
    projects: [],
    media: [],
  };
}

function revalidateBlogPostPaths(_projectIds: string[] = [], _postIds: Array<{ projectId: string; postId: string }> = []) {
  // The blog operator surface lives on the blog-content-workflow extension's
  // dashboard at `/dashboards/{id}`. Without an actor in scope here we can't
  // resolve the specific row id synchronously, so we revalidate the dashboard
  // INDEX (catches the dashboard list page + any same-org operator viewing
  // /dashboards). Per-row revalidation is the caller's responsibility when
  // it has the actor (e.g. `generation.ts` resolves via
  // `resolveBlogDashboardUrl(actor, projectId)`).
  safeRevalidatePath("/artifacts");
  safeRevalidatePath("/dashboards");
}

// Canonical-backed read. Lists all blog project, idea, and post rows from
// `cinatra.objects` (org-agnostic single-shared-store semantics matching the
// prior blob; the existing shadow rows were written without an org tag) and
// assembles the legacy nested-tree shape via the codec. The downstream
// `.map(...)` pipeline below runs the same defensive normalization the blob
// path used so consumers see a byte-identical shape.
function readBlogObjectRowsCanonical(): CodecObjectRow[] {
  return [
    ...readObjectsByType(ASSETS_BLOG_PROJECT_TYPE),
    ...readObjectsByType(ASSETS_BLOG_IDEA_TYPE),
    ...readObjectsByType(ASSETS_BLOG_POST_TYPE),
  ];
}

function readStore(): BlogPostsStore {
  const { store: assembled, warnings } = assembleStoreFromObjectRows(readBlogObjectRowsCanonical());
  if (warnings.length > 0) {
    console.warn(`[blog/store] ${warnings.length} canonical-assembly warning(s):`, warnings);
  }
  const stored = assembled as unknown as BlogPostsStore;
  const rawProjects = Array.isArray(stored.projects) ? (stored.projects as Array<Record<string, any>>) : [];

  return {
    projects: rawProjects
      .map((project): BlogPostsProjectRecord => {
        const ideaGenerationStatus: BlogPostIdeaGenerationState["status"] =
          project.ideaGeneration?.status === "running" ||
          project.ideaGeneration?.status === "succeeded" ||
          project.ideaGeneration?.status === "failed" ||
          project.ideaGeneration?.status === "stopped"
            ? project.ideaGeneration.status
            : "idle";
        const postGenerationStatus: BlogPostDraftGenerationState["status"] =
          project.postGeneration?.status === "running" ||
          project.postGeneration?.status === "succeeded" ||
          project.postGeneration?.status === "failed" ||
          project.postGeneration?.status === "stopped"
            ? project.postGeneration.status
            : "idle";
        const wordpressDraftGenerationStatus: BlogPostWordPressDraftState["status"] =
          project.wordpressDraftGeneration?.status === "running" ||
          project.wordpressDraftGeneration?.status === "succeeded" ||
          project.wordpressDraftGeneration?.status === "failed" ||
          project.wordpressDraftGeneration?.status === "stopped"
            ? project.wordpressDraftGeneration.status
            : "idle";
        const imageGenerationStatus: BlogPostImageGenerationState["status"] =
          project.imageGeneration?.status === "running" ||
          project.imageGeneration?.status === "succeeded" ||
          project.imageGeneration?.status === "failed" ||
          project.imageGeneration?.status === "stopped"
            ? project.imageGeneration.status
            : "idle";
        const linkedinDraftGenerationStatus: BlogPostLinkedInDraftState["status"] =
          project.linkedinDraftGeneration?.status === "running" ||
          project.linkedinDraftGeneration?.status === "succeeded" ||
          project.linkedinDraftGeneration?.status === "failed" ||
          project.linkedinDraftGeneration?.status === "stopped"
            ? project.linkedinDraftGeneration.status
            : "idle";

        return {
          id: String(project.id ?? ""),
          name: String(project.name ?? "Blog posts"),
          companyUrl: String(project.companyUrl ?? ""),
          ideasPerTranscript: Math.max(1, Math.min(5, Number(project.ideasPerTranscript) || 1)),
          transcriptIds: Array.isArray(project.transcriptIds) ? project.transcriptIds.map((value) => String(value)).filter(Boolean) : [],
          createdAt: typeof project.createdAt === "string" && project.createdAt.trim() ? project.createdAt : nowIso(),
          updatedAt: typeof project.updatedAt === "string" && project.updatedAt.trim() ? project.updatedAt : nowIso(),
          ideas: Array.isArray(project.ideas)
            ? project.ideas
                .map((idea) => ({
                  id: String(idea.id ?? ""),
                  transcriptId: String(idea.transcriptId ?? ""),
                  transcriptTitle: String(idea.transcriptTitle ?? "Transcript"),
                  title: String(idea.title ?? "Idea"),
                  // Idea summary lives in `@cinatra-ai/blog-idea-artifact`;
                  // the record carries refs. Legacy `summary: string` fields
                  // are stripped during normalization.
                  summaryArtifactId:
                    typeof idea.summaryArtifactId === "string" && idea.summaryArtifactId.trim()
                      ? idea.summaryArtifactId
                      : undefined,
                  summaryRepresentationRevisionId:
                    typeof idea.summaryRepresentationRevisionId === "string" &&
                    idea.summaryRepresentationRevisionId.trim()
                      ? idea.summaryRepresentationRevisionId
                      : undefined,
                  createdAt: typeof idea.createdAt === "string" && idea.createdAt.trim() ? idea.createdAt : nowIso(),
                }))
                .filter((idea) => idea.id && idea.transcriptId && idea.title)
            : [],
          posts: Array.isArray(project.posts)
            ? project.posts
                .map((post) => ({
                  id: String(post.id ?? ""),
                  ideaId: String(post.ideaId ?? ""),
                  title: String(post.title ?? "Blog post"),
                  excerpt: typeof post.excerpt === "string" ? post.excerpt : "",
                  // Post body lives in `@cinatra-ai/blog-post-artifact`; the
                  // record carries refs. Legacy `content: string` is stripped
                  // during normalization.
                  postArtifactId:
                    typeof post.postArtifactId === "string" && post.postArtifactId.trim()
                      ? post.postArtifactId
                      : undefined,
                  postRepresentationRevisionId:
                    typeof post.postRepresentationRevisionId === "string" &&
                    post.postRepresentationRevisionId.trim()
                      ? post.postRepresentationRevisionId
                      : undefined,
                  imageArtifactId:
                    typeof post.imageArtifactId === "string" && post.imageArtifactId.trim()
                      ? post.imageArtifactId
                      : undefined,
                  imageRepresentationRevisionId:
                    typeof post.imageRepresentationRevisionId === "string" &&
                    post.imageRepresentationRevisionId.trim()
                      ? post.imageRepresentationRevisionId
                      : undefined,
                  // Legacy `imageBase64`/`imageMimeType` fields are
                  // intentionally not normalized through. They are purged
                  // alongside the metadata blob.
                  imagePrompt:
                    typeof post.imagePrompt === "string" && post.imagePrompt.trim() ? post.imagePrompt : undefined,
                  savedPrompts: Array.isArray(post.savedPrompts)
                    ? post.savedPrompts
                        .map((entry) => ({
                          prompt: String(entry?.prompt ?? ""),
                          createdAt:
                            typeof entry?.createdAt === "string" && entry.createdAt.trim() ? entry.createdAt : nowIso(),
                        }))
                        .filter((entry) => entry.prompt.trim().length > 0)
                    : [],
                  personalSkillId:
                    typeof post.personalSkillId === "string" && post.personalSkillId.trim()
                      ? post.personalSkillId
                      : undefined,
                  personalSkillName:
                    typeof post.personalSkillName === "string" && post.personalSkillName.trim()
                      ? post.personalSkillName
                      : undefined,
                  personalSkillCreatedAt:
                    typeof post.personalSkillCreatedAt === "string" && post.personalSkillCreatedAt.trim()
                      ? post.personalSkillCreatedAt
                      : undefined,
                  linkedinDrafts: Array.isArray(post.linkedinDrafts)
                    ? post.linkedinDrafts
                        .map((draft) => ({
                          id: String(draft.id ?? ""),
                          linkedinAccountId: String(draft.linkedinAccountId ?? ""),
                          linkedinAccountName: String(draft.linkedinAccountName ?? ""),
                          linkedinUserId:
                            typeof draft.linkedinUserId === "string" && draft.linkedinUserId.trim()
                              ? draft.linkedinUserId
                              : undefined,
                          destinationType: draft.destinationType === "organization" ? "organization" : "member",
                          destinationId: String(draft.destinationId ?? ""),
                          destinationName: String(draft.destinationName ?? ""),
                          // LinkedIn copy lives in
                          // `@cinatra-ai/blog-post-artifact`, reusing the same
                          // extension as blog post bodies. The entry carries refs.
                          contentArtifactId:
                            typeof draft.contentArtifactId === "string" && draft.contentArtifactId.trim()
                              ? draft.contentArtifactId
                              : undefined,
                          contentRepresentationRevisionId:
                            typeof draft.contentRepresentationRevisionId === "string" &&
                            draft.contentRepresentationRevisionId.trim()
                              ? draft.contentRepresentationRevisionId
                              : undefined,
                          blogPostUrl: String(draft.blogPostUrl ?? ""),
                          status: draft.status === "published" ? "published" : "draft",
                          linkedinPostUrn:
                            typeof draft.linkedinPostUrn === "string" && draft.linkedinPostUrn.trim()
                              ? draft.linkedinPostUrn
                              : undefined,
                          linkedinPostUrl:
                            typeof draft.linkedinPostUrl === "string" && draft.linkedinPostUrl.trim()
                              ? draft.linkedinPostUrl
                              : undefined,
                          publishedAt:
                            typeof draft.publishedAt === "string" && draft.publishedAt.trim() ? draft.publishedAt : undefined,
                          createdAt: typeof draft.createdAt === "string" && draft.createdAt.trim() ? draft.createdAt : nowIso(),
                          // Backfill `updatedAt` for entries persisted before this field
                          // existed; fall back to createdAt.
                          updatedAt:
                            typeof draft.updatedAt === "string" && draft.updatedAt.trim()
                              ? draft.updatedAt
                              : typeof draft.createdAt === "string" && draft.createdAt.trim()
                                ? draft.createdAt
                                : nowIso(),
                        }))
                        .filter(
                          (draft) =>
                            draft.id &&
                            draft.linkedinAccountId &&
                            draft.linkedinAccountName &&
                            draft.destinationId &&
                            draft.destinationName &&
                            draft.blogPostUrl,
                        )
                    : [],
                  wordpressDrafts: Array.isArray(post.wordpressDrafts)
                    ? post.wordpressDrafts
                        .map((draft) => ({
                          id: String(draft.id ?? ""),
                          wordpressInstanceId: String(draft.wordpressInstanceId ?? ""),
                          wordpressInstanceName: String(draft.wordpressInstanceName ?? ""),
                          wordpressPostId: Number(draft.wordpressPostId ?? 0),
                          adminUrl: String(draft.adminUrl ?? ""),
                          publicUrl:
                            typeof draft.publicUrl === "string" && draft.publicUrl.trim() ? draft.publicUrl : undefined,
                          status:
                            typeof draft.status === "string" && draft.status.trim() ? draft.status.trim() : undefined,
                          lastCheckedAt:
                            typeof draft.lastCheckedAt === "string" && draft.lastCheckedAt.trim() ? draft.lastCheckedAt : undefined,
                          createdAt: typeof draft.createdAt === "string" && draft.createdAt.trim() ? draft.createdAt : nowIso(),
                          // Backfill `updatedAt` for entries persisted before this field
                          // existed; fall back to createdAt.
                          updatedAt:
                            typeof draft.updatedAt === "string" && draft.updatedAt.trim()
                              ? draft.updatedAt
                              : typeof draft.lastCheckedAt === "string" && draft.lastCheckedAt.trim()
                                ? draft.lastCheckedAt
                                : typeof draft.createdAt === "string" && draft.createdAt.trim()
                                  ? draft.createdAt
                                  : nowIso(),
                        }))
                        .filter((draft) => draft.id && draft.wordpressInstanceId && draft.wordpressInstanceName && draft.wordpressPostId > 0 && draft.adminUrl)
                    : [],
                  createdAt: typeof post.createdAt === "string" && post.createdAt.trim() ? post.createdAt : nowIso(),
                  updatedAt: typeof post.updatedAt === "string" && post.updatedAt.trim() ? post.updatedAt : nowIso(),
                }))
                .filter((post) => post.id && post.ideaId)
            : [],
          ideaGeneration:
            project.ideaGeneration && typeof project.ideaGeneration === "object"
              ? {
                  status: ideaGenerationStatus,
                  message:
                    typeof project.ideaGeneration.message === "string" && project.ideaGeneration.message.trim()
                      ? project.ideaGeneration.message
                      : "No idea generation is currently running.",
                  updatedAt:
                    typeof project.ideaGeneration.updatedAt === "string" && project.ideaGeneration.updatedAt.trim()
                      ? project.ideaGeneration.updatedAt
                      : nowIso(),
                  jobId:
                    typeof project.ideaGeneration.jobId === "string" && project.ideaGeneration.jobId.trim()
                      ? project.ideaGeneration.jobId
                      : undefined,
                  totalCount: Number.isFinite(Number(project.ideaGeneration.totalCount)) ? Number(project.ideaGeneration.totalCount) : 0,
                  completedCount:
                    Number.isFinite(Number(project.ideaGeneration.completedCount)) ? Number(project.ideaGeneration.completedCount) : 0,
                  failedCount: Number.isFinite(Number(project.ideaGeneration.failedCount)) ? Number(project.ideaGeneration.failedCount) : 0,
                  currentTranscriptTitle:
                    typeof project.ideaGeneration.currentTranscriptTitle === "string" && project.ideaGeneration.currentTranscriptTitle.trim()
                      ? project.ideaGeneration.currentTranscriptTitle
                      : undefined,
                }
              : getDefaultBlogPostIdeaGenerationState(),
          postGeneration:
            project.postGeneration && typeof project.postGeneration === "object"
              ? {
                  status: postGenerationStatus,
                  message:
                    typeof project.postGeneration.message === "string" && project.postGeneration.message.trim()
                      ? project.postGeneration.message
                      : "No blog post draft generation is currently running.",
                  updatedAt:
                    typeof project.postGeneration.updatedAt === "string" && project.postGeneration.updatedAt.trim()
                      ? project.postGeneration.updatedAt
                      : nowIso(),
                  jobId:
                    typeof project.postGeneration.jobId === "string" && project.postGeneration.jobId.trim()
                      ? project.postGeneration.jobId
                      : undefined,
                  ideaId:
                    typeof project.postGeneration.ideaId === "string" && project.postGeneration.ideaId.trim()
                      ? project.postGeneration.ideaId
                      : undefined,
                  ideaTitle:
                    typeof project.postGeneration.ideaTitle === "string" && project.postGeneration.ideaTitle.trim()
                      ? project.postGeneration.ideaTitle
                      : undefined,
                  postId:
                    typeof project.postGeneration.postId === "string" && project.postGeneration.postId.trim()
                      ? project.postGeneration.postId
                      : undefined,
                }
              : getDefaultBlogPostDraftGenerationState(),
          imageGeneration:
            project.imageGeneration && typeof project.imageGeneration === "object"
              ? {
                  status: imageGenerationStatus,
                  message:
                    typeof project.imageGeneration.message === "string" && project.imageGeneration.message.trim()
                      ? project.imageGeneration.message
                      : "No image regeneration is currently running.",
                  updatedAt:
                    typeof project.imageGeneration.updatedAt === "string" && project.imageGeneration.updatedAt.trim()
                      ? project.imageGeneration.updatedAt
                      : nowIso(),
                  jobId:
                    typeof project.imageGeneration.jobId === "string" && project.imageGeneration.jobId.trim()
                      ? project.imageGeneration.jobId
                      : undefined,
                  postId:
                    typeof project.imageGeneration.postId === "string" && project.imageGeneration.postId.trim()
                      ? project.imageGeneration.postId
                      : undefined,
                  postTitle:
                    typeof project.imageGeneration.postTitle === "string" && project.imageGeneration.postTitle.trim()
                      ? project.imageGeneration.postTitle
                      : undefined,
                }
              : getDefaultBlogPostImageGenerationState(),
          wordpressDraftGeneration:
            project.wordpressDraftGeneration && typeof project.wordpressDraftGeneration === "object"
              ? {
                  status: wordpressDraftGenerationStatus,
                  message:
                    typeof project.wordpressDraftGeneration.message === "string" && project.wordpressDraftGeneration.message.trim()
                      ? project.wordpressDraftGeneration.message
                      : "No WordPress draft creation is currently running.",
                  updatedAt:
                    typeof project.wordpressDraftGeneration.updatedAt === "string" && project.wordpressDraftGeneration.updatedAt.trim()
                      ? project.wordpressDraftGeneration.updatedAt
                      : nowIso(),
                  jobId:
                    typeof project.wordpressDraftGeneration.jobId === "string" && project.wordpressDraftGeneration.jobId.trim()
                      ? project.wordpressDraftGeneration.jobId
                      : undefined,
                  postId:
                    typeof project.wordpressDraftGeneration.postId === "string" && project.wordpressDraftGeneration.postId.trim()
                      ? project.wordpressDraftGeneration.postId
                      : undefined,
                  postTitle:
                    typeof project.wordpressDraftGeneration.postTitle === "string" && project.wordpressDraftGeneration.postTitle.trim()
                      ? project.wordpressDraftGeneration.postTitle
                      : undefined,
                  wordpressInstanceId:
                    typeof project.wordpressDraftGeneration.wordpressInstanceId === "string" &&
                    project.wordpressDraftGeneration.wordpressInstanceId.trim()
                      ? project.wordpressDraftGeneration.wordpressInstanceId
                      : undefined,
                  wordpressInstanceName:
                    typeof project.wordpressDraftGeneration.wordpressInstanceName === "string" &&
                    project.wordpressDraftGeneration.wordpressInstanceName.trim()
                      ? project.wordpressDraftGeneration.wordpressInstanceName
                      : undefined,
                  adminUrl:
                    typeof project.wordpressDraftGeneration.adminUrl === "string" && project.wordpressDraftGeneration.adminUrl.trim()
                      ? project.wordpressDraftGeneration.adminUrl
                      : undefined,
                }
              : getDefaultBlogPostWordPressDraftState(),
          linkedinDraftGeneration:
            project.linkedinDraftGeneration && typeof project.linkedinDraftGeneration === "object"
              ? {
                  status: linkedinDraftGenerationStatus,
                  message:
                    typeof project.linkedinDraftGeneration.message === "string" && project.linkedinDraftGeneration.message.trim()
                      ? project.linkedinDraftGeneration.message
                      : "No LinkedIn draft generation is currently running.",
                  updatedAt:
                    typeof project.linkedinDraftGeneration.updatedAt === "string" && project.linkedinDraftGeneration.updatedAt.trim()
                      ? project.linkedinDraftGeneration.updatedAt
                      : nowIso(),
                  jobId:
                    typeof project.linkedinDraftGeneration.jobId === "string" && project.linkedinDraftGeneration.jobId.trim()
                      ? project.linkedinDraftGeneration.jobId
                      : undefined,
                  operation:
                    project.linkedinDraftGeneration.operation === "publish"
                      ? "publish"
                      : project.linkedinDraftGeneration.operation === "draft"
                        ? "draft"
                        : "draft",
                  postId:
                    typeof project.linkedinDraftGeneration.postId === "string" && project.linkedinDraftGeneration.postId.trim()
                      ? project.linkedinDraftGeneration.postId
                      : undefined,
                  postTitle:
                    typeof project.linkedinDraftGeneration.postTitle === "string" && project.linkedinDraftGeneration.postTitle.trim()
                      ? project.linkedinDraftGeneration.postTitle
                      : undefined,
                  linkedinAccountId:
                    typeof project.linkedinDraftGeneration.linkedinAccountId === "string" &&
                    project.linkedinDraftGeneration.linkedinAccountId.trim()
                      ? project.linkedinDraftGeneration.linkedinAccountId
                      : undefined,
                  linkedinAccountName:
                    typeof project.linkedinDraftGeneration.linkedinAccountName === "string" &&
                    project.linkedinDraftGeneration.linkedinAccountName.trim()
                      ? project.linkedinDraftGeneration.linkedinAccountName
                      : undefined,
                  linkedinUserId:
                    typeof project.linkedinDraftGeneration.linkedinUserId === "string" &&
                    project.linkedinDraftGeneration.linkedinUserId.trim()
                      ? project.linkedinDraftGeneration.linkedinUserId
                      : undefined,
                  destinationType:
                    project.linkedinDraftGeneration.destinationType === "organization"
                      ? "organization"
                      : project.linkedinDraftGeneration.destinationType === "member"
                        ? "member"
                        : undefined,
                  destinationId:
                    typeof project.linkedinDraftGeneration.destinationId === "string" &&
                    project.linkedinDraftGeneration.destinationId.trim()
                      ? project.linkedinDraftGeneration.destinationId
                      : undefined,
                  destinationName:
                    typeof project.linkedinDraftGeneration.destinationName === "string" &&
                    project.linkedinDraftGeneration.destinationName.trim()
                      ? project.linkedinDraftGeneration.destinationName
                      : undefined,
                  linkedinPostUrl:
                    typeof project.linkedinDraftGeneration.linkedinPostUrl === "string" &&
                    project.linkedinDraftGeneration.linkedinPostUrl.trim()
                      ? project.linkedinDraftGeneration.linkedinPostUrl
                      : undefined,
                }
              : getDefaultBlogPostLinkedInDraftState(),
        };
      })
      .filter((project) => project.id && project.companyUrl),
    media: Array.isArray(stored.media)
      ? stored.media
          // Saved-media bytes live in `@cinatra-ai/blog-image-artifact` rows
          // (same extension as inline post hero images). The record carries
          // refs only; legacy `imageBase64`/`imageMimeType` are stripped
          // during normalization. The `media_save` primitive has no new
          // writers.
          .map((entry): SavedMediaRecord => ({
            id: String(entry.id ?? ""),
            kind: "image",
            title: String(entry.title ?? "Saved image"),
            description:
              typeof entry.description === "string" && entry.description.trim() ? entry.description : undefined,
            imageArtifactId:
              typeof entry.imageArtifactId === "string" && entry.imageArtifactId.trim()
                ? entry.imageArtifactId
                : undefined,
            imageRepresentationRevisionId:
              typeof entry.imageRepresentationRevisionId === "string" &&
              entry.imageRepresentationRevisionId.trim()
                ? entry.imageRepresentationRevisionId
                : undefined,
            sourceProjectId:
              typeof entry.sourceProjectId === "string" && entry.sourceProjectId.trim() ? entry.sourceProjectId : undefined,
            sourceProjectName:
              typeof entry.sourceProjectName === "string" && entry.sourceProjectName.trim() ? entry.sourceProjectName : undefined,
            sourcePostId: typeof entry.sourcePostId === "string" && entry.sourcePostId.trim() ? entry.sourcePostId : undefined,
            sourcePostTitle:
              typeof entry.sourcePostTitle === "string" && entry.sourcePostTitle.trim() ? entry.sourcePostTitle : undefined,
            createdAt: typeof entry.createdAt === "string" && entry.createdAt.trim() ? entry.createdAt : nowIso(),
            updatedAt: typeof entry.updatedAt === "string" && entry.updatedAt.trim() ? entry.updatedAt : nowIso(),
          }))
          .filter((entry) => entry.id)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      : [],
  };
}

function writeStore(store: Partial<BlogPostsStore> & Pick<BlogPostsStore, "projects">) {
  const nextStore: BlogPostsStore = {
    ...getDefaultStore(),
    ...readStore(),
    ...store,
    projects: store.projects,
  };
  // Canonical write. Decompose the in-memory tree into per-object rows and
  // id-preservingly upsert each via `upsertObjectAndEnqueue` (which also
  // enqueues the Graphiti projection outbox row). Every blog mutation is
  // projected through this path with no shadow-write bypass. Current write
  // surface never object-deletes (intra-post mutations only), so this is
  // upsert-only.
  //
  // orgId derives from the active actor context (RSC pages / blog_* MCP
  // primitives / agent passthrough all run inside an ActorContext frame). If
  // there is NO frame (e.g. some background-job paths), orgId stays null and
  // `assertWriteScopeAllowed` short-circuits (`!actor → return`). With a
  // frame, the actor's org satisfies the cross-tenant guard. The org_id is
  // a per-write provenance tag — reads remain unfiltered (single-shared-store
  // semantics matching the legacy blob; the prior shadow rows had org_id
  // null and dev has 10 orgs).
  const actorOrgId = getActorContext()?.organizationId ?? null;
  const decomposed = decomposeStoreToObjectRows({ projects: nextStore.projects });
  for (const row of decomposed) {
    upsertObjectAndEnqueue({
      upsertInput: {
        id: row.id,
        type: row.type,
        parentId: row.parentId,
        parentType: row.parentType,
        data: row.data,
        source: "blog-store",
        orgId: actorOrgId,
      },
      operation: "upsert",
    });
  }
  // The legacy metadata blob is no longer the source of truth and the row in
  // `cinatra.metadata` is left in place non-destructively.
  revalidateBlogPostPaths(
    nextStore.projects.map((project) => project.id),
    nextStore.projects.flatMap((project) => project.posts.map((post) => ({ projectId: project.id, postId: post.id }))),
  );
}

export async function readBlogPostsProjects() {
  return readStore().projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readSavedMedia() {
  return readStore().media;
}

export async function readBlogPostsProjectById(projectId: string) {
  return readStore().projects.find((project) => project.id === projectId) ?? null;
}

export async function readBlogPostDraftById(projectId: string, postId: string) {
  const project = await readBlogPostsProjectById(projectId);
  if (!project) {
    return null;
  }

  const post = project.posts.find((entry) => entry.id === postId) ?? null;
  if (!post) {
    return null;
  }

  const idea = project.ideas.find((entry) => entry.id === post.ideaId) ?? null;
  return {
    ...post,
    project,
    idea,
  };
}

export async function createBlogPostsProject(input: {
  name: string;
  companyUrl: string;
  ideasPerTranscript: number;
  transcriptIds: string[];
}) {
  const store = readStore();
  const createdAt = nowIso();
  const projectId = randomUUID();
  const nextProject: BlogPostsProjectRecord = {
    id: projectId,
    name: input.name.trim(),
    companyUrl: input.companyUrl.trim(),
    ideasPerTranscript: Math.max(1, Math.min(5, input.ideasPerTranscript)),
    transcriptIds: input.transcriptIds,
    createdAt,
    updatedAt: createdAt,
    ideas: [],
    posts: [],
    ideaGeneration: getDefaultBlogPostIdeaGenerationState(),
    postGeneration: getDefaultBlogPostDraftGenerationState(),
    imageGeneration: getDefaultBlogPostImageGenerationState(),
    wordpressDraftGeneration: getDefaultBlogPostWordPressDraftState(),
    linkedinDraftGeneration: getDefaultBlogPostLinkedInDraftState(),
  };

  writeStore({
    projects: [nextProject, ...store.projects],
  });

  return nextProject;
}

export async function updateBlogPostIdeaGenerationState(projectId: string, state: BlogPostIdeaGenerationState) {
  const store = readStore();
  writeStore({
    projects: store.projects.map((project) =>
      project.id === projectId
        ? {
            ...project,
            updatedAt: nowIso(),
            ideaGeneration: state,
          }
        : project,
    ),
  });
}

export async function updateBlogPostDraftGenerationState(projectId: string, state: BlogPostDraftGenerationState) {
  const store = readStore();
  writeStore({
    projects: store.projects.map((project) =>
      project.id === projectId
        ? {
            ...project,
            updatedAt: nowIso(),
            postGeneration: state,
          }
        : project,
    ),
  });
}

export async function updateBlogPostWordPressDraftGenerationState(projectId: string, state: BlogPostWordPressDraftState) {
  const store = readStore();
  writeStore({
    projects: store.projects.map((project) =>
      project.id === projectId
        ? {
            ...project,
            updatedAt: nowIso(),
            wordpressDraftGeneration: state,
          }
        : project,
    ),
  });
}

export async function updateBlogPostImageGenerationState(projectId: string, state: BlogPostImageGenerationState) {
  const store = readStore();
  writeStore({
    projects: store.projects.map((project) =>
      project.id === projectId
        ? {
            ...project,
            updatedAt: nowIso(),
            imageGeneration: state,
          }
        : project,
    ),
  });
}

/**
 * Conditional stop transition for the image pipeline
 * (stopBlogPostImageRegeneration). Reads, checks, and writes in ONE
 * synchronous block — deliberately NO await boundary anywhere in the body —
 * so a terminal state (succeeded/failed/stopped) committed by the in-process
 * job worker while the caller's cancel round-trip was in flight is never
 * clobbered with `stopped` (interleaving only happens at await points).
 * Returns true when the stop transition was applied.
 */
export async function markBlogPostImageGenerationStoppedIfRunning(projectId: string, message: string) {
  const store = readStore();
  const project = store.projects.find((entry) => entry.id === projectId);
  if (!project) return false;
  const status = project.imageGeneration?.status;
  if (status === "succeeded" || status === "failed" || status === "stopped") return false;
  const stamped = nowIso();
  writeStore({
    projects: store.projects.map((entry) =>
      entry.id === projectId
        ? {
            ...entry,
            updatedAt: stamped,
            imageGeneration: {
              ...entry.imageGeneration,
              status: "stopped" as const,
              message,
              updatedAt: stamped,
            },
          }
        : entry,
    ),
  });
  return true;
}

export async function updateBlogPostLinkedInDraftGenerationState(projectId: string, state: BlogPostLinkedInDraftState) {
  const store = readStore();
  writeStore({
    projects: store.projects.map((project) =>
      project.id === projectId
        ? {
            ...project,
            updatedAt: nowIso(),
            linkedinDraftGeneration: state,
          }
        : project,
    ),
  });
}

export async function saveGeneratedIdeas(
  projectId: string,
  ideas: Array<{
    transcriptId: string;
    transcriptTitle: string;
    title: string;
    // Caller materializes the idea summary via `materializeBlogIdeaArtifact`
    // and passes refs.
    summaryArtifactId: string;
    summaryRepresentationRevisionId: string;
  }>,
) {
  const store = readStore();
  const updatedAt = nowIso();
  const ideasToShadow: BlogPostIdeaRecord[] = ideas.map((idea) => ({
    id: randomUUID(),
    transcriptId: idea.transcriptId,
    transcriptTitle: idea.transcriptTitle,
    title: idea.title,
    summaryArtifactId: idea.summaryArtifactId,
    summaryRepresentationRevisionId: idea.summaryRepresentationRevisionId,
    createdAt: updatedAt,
  }));
  writeStore({
    projects: store.projects.map((project) =>
      project.id === projectId
        ? {
            ...project,
            updatedAt,
            ideas: ideasToShadow,
          }
        : project,
    ),
  });

  // writeStore() writes canonical @cinatra-ai/assets:* rows directly via the
  // objects substrate.
}

export async function saveGeneratedBlogPostDraft(input: {
  projectId: string;
  ideaId: string;
  title: string;
  excerpt: string;
  // Caller materializes the post body via `materializeBlogPostBodyArtifact`
  // (see `src/lib/blog-post-artifact-materializer.ts`) and passes refs.
  postArtifactId: string;
  postRepresentationRevisionId: string;
  imageArtifactId?: string;
  imageRepresentationRevisionId?: string;
  imagePrompt?: string;
}) {
  const store = readStore();
  const updatedAt = nowIso();
  const postId = randomUUID();
  const post: BlogPostDraftRecord = {
    id: postId,
    ideaId: input.ideaId,
    title: input.title,
    excerpt: input.excerpt,
    postArtifactId: input.postArtifactId,
    postRepresentationRevisionId: input.postRepresentationRevisionId,
    imageArtifactId: input.imageArtifactId,
    imageRepresentationRevisionId: input.imageRepresentationRevisionId,
    imagePrompt: input.imagePrompt,
    savedPrompts: [],
    createdAt: updatedAt,
    updatedAt,
  };

  writeStore({
    projects: store.projects.map((project) =>
      project.id === input.projectId
        ? {
            ...project,
            updatedAt,
            posts: [post, ...project.posts],
          }
        : project,
    ),
  });

  // writeStore() writes canonical @cinatra-ai/assets:* rows directly via the
  // objects substrate.

  return postId;
}

export async function updateBlogPostDraftContent(input: {
  projectId: string;
  postId: string;
  title: string;
  excerpt: string;
  // Every edit save mints a new post-body artifact revision (caller
  // materializes upstream); the record stores the new refs. Mirrors the image
  // regeneration pattern (ref swap per save).
  postArtifactId: string;
  postRepresentationRevisionId: string;
}) {
  const store = readStore();
  const updatedAt = nowIso();
  const nextProjects = store.projects.map((project) =>
    project.id === input.projectId
      ? {
          ...project,
          updatedAt,
          posts: project.posts.map((post) =>
            post.id === input.postId
              ? {
                  ...post,
                  title: input.title,
                  excerpt: input.excerpt,
                  postArtifactId: input.postArtifactId,
                  postRepresentationRevisionId: input.postRepresentationRevisionId,
                  updatedAt,
                }
              : post,
          ),
        }
      : project,
  );
  writeStore({
    projects: nextProjects,
  });

  // The mutated blog-post is already re-upserted by writeStore().
  const mutatedProject = nextProjects.find((entry) => entry.id === input.projectId);
  const mutatedPost = mutatedProject?.posts.find((entry) => entry.id === input.postId);
  // writeStore() writes canonical @cinatra-ai/assets:* rows directly via the
  // objects substrate.
}

// Refs-only swap for the artifact-edit-text portlet. The caller
// already minted a NEW post-body (and/or hero-image) artifact via
// artifact_authoring_emit; this swaps the object's refs WITHOUT touching
// title/excerpt and WITHOUT re-materializing any bytes. Optional image refs let
// one call swap both (the draft-editor portlet only sends post refs).
export async function updateBlogPostDraftRefs(input: {
  projectId: string;
  postId: string;
  postArtifactId: string;
  postRepresentationRevisionId: string;
  imageArtifactId?: string;
  imageRepresentationRevisionId?: string;
}) {
  const store = readStore();
  const updatedAt = nowIso();
  const nextProjects = store.projects.map((project) =>
    project.id === input.projectId
      ? {
          ...project,
          updatedAt,
          posts: project.posts.map((post) =>
            post.id === input.postId
              ? {
                  ...post,
                  postArtifactId: input.postArtifactId,
                  postRepresentationRevisionId: input.postRepresentationRevisionId,
                  ...(input.imageArtifactId ? { imageArtifactId: input.imageArtifactId } : {}),
                  ...(input.imageRepresentationRevisionId
                    ? { imageRepresentationRevisionId: input.imageRepresentationRevisionId }
                    : {}),
                  updatedAt,
                }
              : post,
          ),
        }
      : project,
  );
  writeStore({ projects: nextProjects });
}

export async function updateBlogPostDraftImage(input: {
  projectId: string;
  postId: string;
  imageArtifactId?: string;
  imageRepresentationRevisionId?: string;
  imagePrompt?: string;
}) {
  const store = readStore();
  const updatedAt = nowIso();
  const nextProjects = store.projects.map((project) =>
    project.id === input.projectId
      ? {
          ...project,
          updatedAt,
          posts: project.posts.map((post) =>
            post.id === input.postId
              ? {
                  ...post,
                  imageArtifactId: input.imageArtifactId,
                  imageRepresentationRevisionId: input.imageRepresentationRevisionId,
                  imagePrompt: input.imagePrompt,
                  updatedAt,
                }
              : post,
          ),
        }
      : project,
  );
  writeStore({
    projects: nextProjects,
  });

  // The mutated blog-post is already re-upserted by writeStore().
  const mutatedProject = nextProjects.find((entry) => entry.id === input.projectId);
  const mutatedPost = mutatedProject?.posts.find((entry) => entry.id === input.postId);
  // writeStore() writes canonical @cinatra-ai/assets:* rows directly via the
  // objects substrate.
}

export async function appendBlogPostSavedPrompt(input: {
  projectId: string;
  postId: string;
  prompt: string;
}) {
  const normalizedPrompt = input.prompt.trim();
  if (!normalizedPrompt) {
    return;
  }

  const store = readStore();
  const updatedAt = nowIso();
  writeStore({
    projects: store.projects.map((project) =>
      project.id === input.projectId
        ? {
            ...project,
            updatedAt,
            posts: project.posts.map((post) =>
              post.id === input.postId
                ? {
                    ...post,
                    updatedAt,
                    savedPrompts: [
                      ...(post.savedPrompts ?? []),
                      {
                        prompt: normalizedPrompt,
                        createdAt: updatedAt,
                      },
                    ],
                  }
                : post,
            ),
          }
        : project,
    ),
  });
}

export async function saveBlogPostPersonalSkillReference(input: {
  projectId: string;
  postId: string;
  skillId: string;
  skillName: string;
}) {
  const store = readStore();
  const updatedAt = nowIso();
  const nextProjects = store.projects.map((project) =>
    project.id === input.projectId
      ? {
          ...project,
          updatedAt,
          posts: project.posts.map((post) =>
            post.id === input.postId
              ? {
                  ...post,
                  updatedAt,
                  savedPrompts: [],
                  personalSkillId: input.skillId,
                  personalSkillName: input.skillName,
                  personalSkillCreatedAt: updatedAt,
                }
              : post,
          ),
        }
      : project,
  );
  writeStore({
    projects: nextProjects,
  });

  // The mutated blog-post is already re-upserted by writeStore().
  const mutatedProject = nextProjects.find((entry) => entry.id === input.projectId);
  const mutatedPost = mutatedProject?.posts.find((entry) => entry.id === input.postId);
  // writeStore() writes canonical @cinatra-ai/assets:* rows directly via the
  // objects substrate.
}

// `blog_media_*` is marked `delete-as-superseded`; the saved-media library
// is replaced by canonical `@cinatra-ai/blog-image-artifact` rows visible
// through `/artifacts`. The "save to media library" flow is retired; the
// function stays as a throwing stub so the route handler
// (`handleBlogPostMediaSaveRequest`) compiles until the route and package are
// removed.
export async function saveBlogPostImageToMediaLibrary(_input: {
  projectId: string;
  postId: string;
  title?: string;
  description?: string;
}): Promise<never> {
  throw new Error(
    "Retired: `blog_media_*` is delete-as-superseded. Blog images live in " +
      "`@cinatra-ai/blog-image-artifact` rows; reach them through " +
      "`/artifacts`.",
  );
}

export async function saveWordPressDraftReference(input: {
  projectId: string;
  postId: string;
  wordpressInstanceId: string;
  wordpressInstanceName: string;
  wordpressPostId: number;
  adminUrl: string;
  publicUrl?: string;
  status?: string;
}) {
  const store = readStore();
  const updatedAt = nowIso();
  const nextProjects = store.projects.map((project) =>
    project.id === input.projectId
      ? {
          ...project,
          updatedAt,
          posts: project.posts.map((post) =>
            post.id === input.postId
              ? {
                  ...post,
                  updatedAt,
                  wordpressDrafts: [
                    {
                      id: randomUUID(),
                      wordpressInstanceId: input.wordpressInstanceId,
                      wordpressInstanceName: input.wordpressInstanceName,
                      wordpressPostId: input.wordpressPostId,
                      adminUrl: input.adminUrl,
                      publicUrl: input.publicUrl,
                      status: input.status,
                      lastCheckedAt: updatedAt,
                      createdAt: updatedAt,
                      // Stamped on every save so the tiebreaker has a reliable
                      // monotonic field.
                      updatedAt,
                    },
                    ...(post.wordpressDrafts ?? []),
                  ],
                }
              : post,
          ),
        }
      : project,
  );
  writeStore({
    projects: nextProjects,
  });

  // The mutated blog-post is already re-upserted by writeStore().
  const mutatedProject = nextProjects.find((entry) => entry.id === input.projectId);
  const mutatedPost = mutatedProject?.posts.find((entry) => entry.id === input.postId);
  // writeStore() writes canonical @cinatra-ai/assets:* rows directly via the
  // objects substrate.
}

export async function saveLinkedInDraftReference(input: {
  projectId: string;
  postId: string;
  linkedinAccountId: string;
  linkedinAccountName: string;
  linkedinUserId?: string;
  destinationType: "member" | "organization";
  destinationId: string;
  destinationName: string;
  // Caller materializes LinkedIn copy via `materializeBlogPostBodyArtifact`;
  // LinkedIn drafts reuse blog-post artifacts and pass refs.
  contentArtifactId: string;
  contentRepresentationRevisionId: string;
  blogPostUrl: string;
  status?: "draft" | "published";
  linkedinPostUrn?: string;
  linkedinPostUrl?: string;
  publishedAt?: string;
}) {
  const store = readStore();
  const updatedAt = nowIso();
  const incomingStatus: "draft" | "published" = input.status ?? "draft";
  const nextProjects = store.projects.map((project) =>
    project.id === input.projectId
      ? {
          ...project,
          updatedAt,
          posts: project.posts.map((post) => {
            if (post.id !== input.postId) return post;
            const existing = post.linkedinDrafts ?? [];
            // Coalesce on the natural key when the incoming entry is still a
            // `draft`. Once an entry has been `published` we never overwrite
            // it; a fresh draft for the same destination becomes its own row.
            //
            // The composite key is (linkedinAccountId, destinationId,
            // blogPostUrl). Two `draft` entries with the same key
            // represent two attempts at the same destination; only the
            // latest one is meaningful, so re-running the agent on the
            // same destination must produce 1 entry, not N. Without this
            // coalesce and a stable updatedAt tiebreaker, there is no
            // deterministic winner.
            //
            // `id` + `createdAt` are preserved across a coalesce so any
            // downstream reference (HITL renderer payload, persisted
            // linkedinDraftId) keeps resolving.
            const matchIndex =
              incomingStatus === "draft"
                ? existing.findIndex(
                    (draft) =>
                      (draft.status ?? "draft") === "draft" &&
                      draft.linkedinAccountId === input.linkedinAccountId &&
                      draft.destinationId === input.destinationId &&
                      draft.blogPostUrl === input.blogPostUrl,
                  )
                : -1;
            const coalesced = matchIndex >= 0
              ? existing.map((draft, idx) =>
                  idx === matchIndex
                    ? {
                        ...draft,
                        linkedinAccountId: input.linkedinAccountId,
                        linkedinAccountName: input.linkedinAccountName,
                        linkedinUserId: input.linkedinUserId,
                        destinationType: input.destinationType,
                        destinationId: input.destinationId,
                        destinationName: input.destinationName,
                        contentArtifactId: input.contentArtifactId,
                        contentRepresentationRevisionId: input.contentRepresentationRevisionId,
                        blogPostUrl: input.blogPostUrl,
                        status: incomingStatus,
                        linkedinPostUrn: input.linkedinPostUrn ?? draft.linkedinPostUrn,
                        linkedinPostUrl: input.linkedinPostUrl ?? draft.linkedinPostUrl,
                        publishedAt: input.publishedAt ?? draft.publishedAt,
                        updatedAt,
                      }
                    : draft,
                )
              : [
                  {
                    id: randomUUID(),
                    linkedinAccountId: input.linkedinAccountId,
                    linkedinAccountName: input.linkedinAccountName,
                    linkedinUserId: input.linkedinUserId,
                    destinationType: input.destinationType,
                    destinationId: input.destinationId,
                    destinationName: input.destinationName,
                    contentArtifactId: input.contentArtifactId,
                    contentRepresentationRevisionId: input.contentRepresentationRevisionId,
                    blogPostUrl: input.blogPostUrl,
                    status: incomingStatus,
                    linkedinPostUrn: input.linkedinPostUrn,
                    linkedinPostUrl: input.linkedinPostUrl,
                    publishedAt: input.publishedAt,
                    createdAt: updatedAt,
                    updatedAt,
                  },
                  ...existing,
                ];
            return {
              ...post,
              updatedAt,
              linkedinDrafts: coalesced,
            };
          }),
        }
      : project,
  );
  writeStore({
    projects: nextProjects,
  });

  // The mutated blog-post is already re-upserted by writeStore().
  const mutatedProject = nextProjects.find((entry) => entry.id === input.projectId);
  const mutatedPost = mutatedProject?.posts.find((entry) => entry.id === input.postId);
  // writeStore() writes canonical @cinatra-ai/assets:* rows directly via the
  // objects substrate.
}

export async function updateWordPressDraftReference(input: {
  projectId: string;
  postId: string;
  draftId: string;
  status?: string;
  publicUrl?: string;
  adminUrl?: string;
}) {
  const store = readStore();
  const updatedAt = nowIso();
  writeStore({
    projects: store.projects.map((project) =>
      project.id === input.projectId
        ? {
            ...project,
            updatedAt,
            posts: project.posts.map((post) =>
              post.id === input.postId
                ? {
                    ...post,
                    updatedAt,
                    wordpressDrafts: (post.wordpressDrafts ?? []).map((draft) =>
                      draft.id === input.draftId
                        ? {
                            ...draft,
                            status: input.status ?? draft.status,
                            publicUrl: "publicUrl" in input ? input.publicUrl : draft.publicUrl,
                            adminUrl: "adminUrl" in input ? input.adminUrl ?? draft.adminUrl : draft.adminUrl,
                            lastCheckedAt: updatedAt,
                            // Bumped on every update.
                            updatedAt,
                          }
                        : draft,
                    ),
                  }
                : post,
            ),
          }
        : project,
    ),
  });
}

export async function deleteWordPressDraftReference(input: {
  projectId: string;
  postId: string;
  draftId: string;
}) {
  const store = readStore();
  const updatedAt = nowIso();
  const nextProjects = store.projects.map((project) =>
    project.id === input.projectId
      ? {
          ...project,
          updatedAt,
          posts: project.posts.map((post) =>
            post.id === input.postId
              ? {
                  ...post,
                  updatedAt,
                  wordpressDrafts: (post.wordpressDrafts ?? []).filter((draft) => draft.id !== input.draftId),
                }
              : post,
          ),
        }
      : project,
  );
  writeStore({ projects: nextProjects });

  // Re-upsert the mutated post so the objects row reflects the removed draft reference.
  const mutatedPost = nextProjects.find((p) => p.id === input.projectId)?.posts.find((p) => p.id === input.postId);
  // writeStore() writes canonical @cinatra-ai/assets:* rows directly via the
  // objects substrate.
}

export async function updateLinkedInDraftReference(input: {
  projectId: string;
  postId: string;
  draftId: string;
  // Edits mint a new artifact revision (caller materializes upstream); the
  // draft entry stores the new refs.
  contentArtifactId?: string;
  contentRepresentationRevisionId?: string;
  status?: "draft" | "published";
  linkedinPostUrn?: string;
  linkedinPostUrl?: string;
  publishedAt?: string;
}) {
  const store = readStore();
  const updatedAt = nowIso();
  writeStore({
    projects: store.projects.map((project) =>
      project.id === input.projectId
        ? {
            ...project,
            updatedAt,
            posts: project.posts.map((post) =>
              post.id === input.postId
                ? {
                    ...post,
                    updatedAt,
                    linkedinDrafts: (post.linkedinDrafts ?? []).map((draft) =>
                      draft.id === input.draftId
                        ? {
                            ...draft,
                            contentArtifactId:
                              typeof input.contentArtifactId === "string"
                                ? input.contentArtifactId
                                : draft.contentArtifactId,
                            contentRepresentationRevisionId:
                              typeof input.contentRepresentationRevisionId === "string"
                                ? input.contentRepresentationRevisionId
                                : draft.contentRepresentationRevisionId,
                            status: input.status ?? draft.status,
                            linkedinPostUrn: input.linkedinPostUrn ?? draft.linkedinPostUrn,
                            linkedinPostUrl: input.linkedinPostUrl ?? draft.linkedinPostUrl,
                            publishedAt: input.publishedAt ?? draft.publishedAt,
                            // Bumped on every update so the SKILL.md tiebreaker
                            // can pick the latest updatedAt.
                            updatedAt,
                          }
                        : draft,
                    ),
                  }
                : post,
            ),
          }
        : project,
    ),
  });
}

export async function listAvailableTranscriptOptions(): Promise<AvailableTranscriptOption[]> {
  // The transcript source package is archived. No transcript generators are
  // available until a new transcript source backend is wired into asset-blog.
  return [];
}

export async function readSelectedTranscriptOptions(transcriptIds: string[]) {
  const options = await listAvailableTranscriptOptions();
  const optionById = new Map(options.map((option) => [option.id, option]));
  return transcriptIds.map((id) => optionById.get(id)).filter(Boolean) as AvailableTranscriptOption[];
}
