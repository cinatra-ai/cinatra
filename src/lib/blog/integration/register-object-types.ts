import { objectTypeRegistry } from "@cinatra-ai/objects";
import { z } from "zod";
import {
  BlogPostListRow,
  BlogPostCard,
  BlogPostDetail,
  BlogPostIdeaListRow,
  BlogPostIdeaCard,
  BlogPostIdeaDetail,
} from "./renderers";

// The obsolete `@cinatra-ai/asset-blog:*` registrations
// (blog-post-idea, blog-post, saved-media) were removed. Live shadow rows were
// re-typed to `@cinatra-ai/assets:*` in place, so the old types have no rows,
// no writers, and no consumers in production. `registerAssetsBlogObjectTypes()`
// below remains the sole blog registrar. The `SavedMedia*` renderers are also
// no longer imported because the `saved-media` type has no new writers.
export function registerBlogObjectTypes() {
  registerAssetsBlogObjectTypes();
}

// ---------------------------------------------------------------------------
// Canonical `@cinatra-ai/assets:*` blog object types. These are the
// source-of-truth model for blog object reads/writes and backfill. project →
// idea → post are linked via `parent_id` (objects substrate); generation state
// lives on the project object because some states predate any idea/post.
// ---------------------------------------------------------------------------
export function registerAssetsBlogObjectTypes() {
  // ---- @cinatra-ai/assets:blog-project (NEW first-class; was metadata-only)
  objectTypeRegistry.register({
    type: "@cinatra-ai/assets:blog-project",
    category: "project",
    schema: z.object({
      id: z.string(),
      name: z.string(),
      companyUrl: z.string(),
      ideasPerTranscript: z.number(),
      transcriptIds: z.array(z.string()),
      // Generation state machines (transient per-project polling state) live
      // on the project object so a run that has not yet produced an idea/post
      // still has somewhere to record progress.
      ideaGeneration: z.unknown().optional(),
      postGeneration: z.unknown().optional(),
      imageGeneration: z.unknown().optional(),
      wordpressDraftGeneration: z.unknown().optional(),
      linkedinDraftGeneration: z.unknown().optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
    lifecycle: {
      sources: ["agent", "user"],
      mutableBy: ["agent", "user"],
    },
    // Real list/card/detail renderers land with the read/write flip + UI pass;
    // null placeholders here keep the type registered for classification
    // (the precedent is the generic `@cinatra-ai/artifact:object` row).
    renderers: {
      listRow: null,
      card: null,
      detail: null,
    },
    // Blog projects are USER-OWNED metadata (name, companyUrl,
    // ideasPerTranscript, transcriptIds). Agents update the generation-state
    // machines on the project, but they must NOT auto-create a project — that's
    // a deliberate user action. `name` + `companyUrl` are owner-supplied and
    // preserved across agent re-runs.
    crudPolicy: {
      onMatch: "update",
      onNoMatch: "hitl",
      requiredFields: ["name"],
      preserveOnUpdate: [
        "id",
        "createdAt",
        "name",
        "companyUrl",
        "ideasPerTranscript",
        "transcriptIds",
      ],
    },
  });

  // ---- @cinatra-ai/assets:blog-idea (parent = blog-project)
  objectTypeRegistry.register({
    type: "@cinatra-ai/assets:blog-idea",
    category: "idea",
    schema: z.object({
      id: z.string(),
      projectId: z.string().optional(),
      transcriptId: z.string(),
      transcriptTitle: z.string(),
      title: z.string(),
      summaryArtifactId: z.string().optional(),
      summaryRepresentationRevisionId: z.string().optional(),
      createdAt: z.string(),
    }),
    lifecycle: {
      sources: ["agent"],
      mutableBy: ["user"],
    },
    renderers: {
      listRow: BlogPostIdeaListRow,
      card: BlogPostIdeaCard,
      detail: BlogPostIdeaDetail,
    },
    relations: [
      {
        name: "project",
        targetType: "@cinatra-ai/assets:blog-project",
        cardinality: "one",
        fkField: "projectId",
      },
    ],
    // Blog-idea dedupe by title within a project. Existing match → UPDATE
    // (re-generation can refine the summary artifact ref). New idea → CREATE.
    // `title` + `projectId` are required; `id` / `createdAt` /
    // `summaryArtifactId` survive updates by default (the materializer owns the
    // artifact; the dispatcher must not clobber).
    crudPolicy: {
      onMatch: "update",
      onNoMatch: "create",
      requiredFields: ["title", "projectId"],
      preserveOnUpdate: ["id", "createdAt", "summaryArtifactId", "summaryRepresentationRevisionId"],
    },
  });

  // ---- @cinatra-ai/assets:blog-post (parent = blog-idea)
  objectTypeRegistry.register({
    type: "@cinatra-ai/assets:blog-post",
    category: "content",
    schema: z.object({
      id: z.string(),
      ideaId: z.string(),
      projectId: z.string().optional(),
      title: z.string(),
      excerpt: z.string(),
      postArtifactId: z.string().optional(),
      postRepresentationRevisionId: z.string().optional(),
      imageArtifactId: z.string().optional(),
      imageRepresentationRevisionId: z.string().optional(),
      imagePrompt: z.string().optional(),
      savedPrompts: z.array(z.object({ prompt: z.string(), createdAt: z.string() })).optional(),
      personalSkillId: z.string().optional(),
      linkedinDrafts: z.array(z.unknown()).optional(),
      wordpressDrafts: z.array(z.unknown()).optional(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
    lifecycle: {
      sources: ["agent"],
      mutableBy: ["agent", "user"],
    },
    renderers: {
      listRow: BlogPostListRow,
      card: BlogPostCard,
      detail: BlogPostDetail,
    },
    relations: [
      {
        name: "idea",
        targetType: "@cinatra-ai/assets:blog-idea",
        cardinality: "one",
        fkField: "ideaId",
      },
    ],
    // Blog-post dedupe by ideaId (one post per idea). Existing post → MERGE so
    // re-runs accumulate linkedinDrafts / wordpressDrafts / savedPrompts arrays
    // without losing prior publication state. `title` + `ideaId` are required;
    // `id` / `createdAt` / artifact refs (owned by the materializer) are
    // preserved on every dispatcher write.
    crudPolicy: {
      onMatch: "merge",
      onNoMatch: "create",
      mergeableFields: ["linkedinDrafts", "wordpressDrafts", "savedPrompts"],
      requiredFields: ["title", "ideaId"],
      preserveOnUpdate: [
        "id",
        "createdAt",
        "postArtifactId",
        "postRepresentationRevisionId",
        "imageArtifactId",
        "imageRepresentationRevisionId",
      ],
    },
  });
}
