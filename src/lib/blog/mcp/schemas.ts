import { z } from "zod";

export const listProjectsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const projectIdSchema = z.object({
  projectId: z.string().min(1),
});

export const postIdSchema = z.object({
  projectId: z.string().min(1),
  postId: z.string().min(1),
});

export const createProjectSchema = z.object({
  name: z.string().min(1),
  companyUrl: z.string().min(1),
  ideasPerTranscript: z.number().int().positive().default(1),
  transcriptIds: z.array(z.string()).default([]),
});

export const startDraftGenerationSchema = z.object({
  projectId: z.string().min(1),
  ideaId: z.string().min(1),
});

export const updateDraftContentSchema = z.object({
  projectId: z.string().min(1),
  postId: z.string().min(1),
  title: z.string(),
  excerpt: z.string(),
  content: z.string(),
});

// Refs-only alternative shape for blog_post_update. The
// artifact-edit-text portlet mints a NEW artifact via artifact_authoring_emit,
// then swaps the post object's refs WITHOUT re-materializing bytes. Mutually
// exclusive with the raw-content shape (the handler rejects a mixed input with
// blog_post_update_mixed_input).
export const updateDraftRefsSchema = z.object({
  projectId: z.string().min(1),
  postId: z.string().min(1),
  postArtifactId: z.string().min(1),
  postRepresentationRevisionId: z.string().min(1),
  imageArtifactId: z.string().min(1).optional(),
  imageRepresentationRevisionId: z.string().min(1).optional(),
});

// Tool-facing input schema for `blog_post_update`. A SINGLE flat object
// (NOT a z.union) so the emitted JSON Schema has a top-level `type: "object"`.
// OpenAI's Responses API rejects a tool whose top-level schema is `anyOf`
// ("Invalid tool schema for: …"), which is what z.union serializes to — and
// because the bridge injects the whole cinatra self-MCP toolset, one rejected
// tool 400s the ENTIRE request before any tool can run. The two real shapes
// (raw `{ title, excerpt, content }` vs refs-only) stay MUTUALLY EXCLUSIVE and
// are still validated branch-by-branch by the `blog_post_update` handler
// (`blog_post_update_mixed_input` guard + per-branch `.parse`), so this only
// widens the advertised schema; it does not loosen runtime validation.
export const blogPostUpdateToolSchema = z.object({
  projectId: z.string().min(1),
  postId: z.string().min(1),
  // raw-content shape
  title: z.string().optional(),
  excerpt: z.string().optional(),
  content: z.string().optional(),
  // refs-only shape (mutually exclusive with the raw-content shape)
  postArtifactId: z.string().min(1).optional(),
  postRepresentationRevisionId: z.string().min(1).optional(),
  imageArtifactId: z.string().min(1).optional(),
  imageRepresentationRevisionId: z.string().min(1).optional(),
});

export const startImageRegenerationSchema = z.object({
  projectId: z.string().min(1),
  postId: z.string().min(1),
  prompt: z.string().optional(),
});

export const startWordPressDraftSchema = z.object({
  projectId: z.string().min(1),
  postId: z.string().min(1),
  wordpressInstanceId: z.string().min(1),
});

export const deleteWordPressDraftSchema = z.object({
  projectId: z.string().min(1),
  postId: z.string().min(1),
  wordpressDraftId: z.string().min(1),
  // When true, deletes the draft from WordPress itself via the
  // connector's `deleteWordPressPost`. Default false preserves local-only
  // delete behaviour for back-compat. The blog-wordpress-publish-agent
  // reject path passes true.
  deleteInWordPress: z.boolean().optional(),
});

// `blog_post_publish_linkedin_update` lets the blog-linkedin-publish-agent
// persist operator edits made at the HITL draft-review gate before invoking
// `_publish`. MCP-shaped throughout the stack; adapter maps
// `linkedinDraftId` to store `draftId`.
//
// Input schema uses artifact refs instead of body-row content. The agent
// materializes operator-edited content via `artifact_authoring_emit` using
// `@cinatra-ai/blog-post-artifact` and passes the resulting refs to this
// primitive. Publish primitives accept refs and operational metadata only.
export const updateLinkedInDraftSchema = z.object({
  projectId: z.string().min(1),
  postId: z.string().min(1),
  linkedinDraftId: z.string().min(1),
  contentArtifactId: z.string().min(1),
  contentRepresentationRevisionId: z.string().min(1),
});

export const refreshWordPressDraftSchema = z.object({
  projectId: z.string().min(1),
  postId: z.string().min(1),
  wordpressDraftId: z.string().min(1),
});

export const startLinkedInDraftSchema = z.object({
  projectId: z.string().min(1),
  postId: z.string().min(1),
  linkedinAccountId: z.string().min(1),
  // Required so the adapter cannot override the value with an empty
  // string without typecheck or schema complaint.
  linkedinAccountName: z.string().min(1),
  destinationType: z.enum(["member", "organization"]),
  destinationId: z.string().min(1),
  destinationName: z.string().min(1),
  blogPostUrl: z.string().min(1),
});

export const publishLinkedInDraftSchema = z.object({
  projectId: z.string().min(1),
  postId: z.string().min(1),
  linkedinDraftId: z.string().min(1),
  linkedinAccountId: z.string().min(1),
});

export const saveImageToMediaSchema = z.object({
  projectId: z.string().min(1),
  postId: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
});

export const convertWordPressContentSchema = z.object({
  wordpressInstanceId: z.string().min(1),
  title: z.string(),
  excerpt: z.string(),
  content: z.string(),
});
