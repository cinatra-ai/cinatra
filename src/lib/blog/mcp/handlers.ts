import type { PrimitiveInvocationRequest } from "@cinatra-ai/mcp-client";
import { decodeCursor, buildListPage } from "@/lib/mcp-pagination";
import { createBlogContentUseCases } from "../application/use-cases";
// Relocated to @cinatra-ai/blog-connector.
import { getWordPressContentConverter } from "@cinatra-ai/blog-connector";
import * as schemas from "./schemas";

const useCases = createBlogContentUseCases();

export function createBlogContentPrimitiveHandlers() {
  return {
    "blog_project_list": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { cursor, limit: rawLimit } = schemas.listProjectsSchema.parse(request.input ?? {});
      const limit = Math.min(rawLimit ?? 50, 200);
      const offset = decodeCursor(cursor);
      const allProjects = await useCases.listProjects();
      const metadataItems = allProjects.map((project) => ({
        id: project.id,
        name: project.name,
        companyUrl: project.companyUrl,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      }));
      const slice = metadataItems.slice(offset, offset + limit);
      return buildListPage(slice, metadataItems.length, offset, limit);
    },

    "blog_project_get": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { projectId } = schemas.projectIdSchema.parse(request.input);
      return useCases.getProject(projectId);
    },

    "blog_project_create": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.createProjectSchema.parse(request.input);
      return useCases.startIdeaGeneration(input);
    },

    "blog_post_ideas_generate_start": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.createProjectSchema.parse(request.input);
      return useCases.startIdeaGeneration(input);
    },

    "blog_post_ideas_generate_cancel": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { projectId } = schemas.projectIdSchema.parse(request.input);
      return useCases.stopIdeaGeneration(projectId);
    },

    "blog_post_generate_start": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.startDraftGenerationSchema.parse(request.input);
      await useCases.startDraftGeneration(input);
      return useCases.getProject(input.projectId);
    },

    "blog_post_generate_cancel": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { projectId } = schemas.projectIdSchema.parse(request.input);
      return useCases.stopDraftGeneration(projectId);
    },

    "blog_post_update": async (request: PrimitiveInvocationRequest<unknown>) => {
      // Two mutually-exclusive shapes: raw-content (re-materializes)
      // vs refs-only (swaps the post object's artifact refs, no re-materialization).
      const raw = request.input as Record<string, unknown> | null;
      const hasRefs = !!raw && typeof raw.postArtifactId === "string";
      const hasContent = !!raw && (typeof raw.content === "string" || typeof raw.title === "string" || typeof raw.excerpt === "string");
      if (hasRefs && hasContent) {
        return { error: "Provide either raw content OR artifact refs, not both.", code: "blog_post_update_mixed_input" };
      }
      if (hasRefs) {
        const input = schemas.updateDraftRefsSchema.parse(request.input);
        await useCases.updateDraftRefs(input);
        return { ok: true };
      }
      const input = schemas.updateDraftContentSchema.parse(request.input);
      await useCases.updateDraftContent(input);
      return { ok: true };
    },

    "blog_image_generate_start": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.startImageRegenerationSchema.parse(request.input);
      return useCases.startImageRegeneration(input);
    },

    "blog_image_generate_cancel": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { projectId } = schemas.projectIdSchema.parse(request.input);
      return useCases.stopImageRegeneration(projectId);
    },

    "blog_post_publish_wordpress_start": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.startWordPressDraftSchema.parse(request.input);
      return useCases.startWordPressDraftCreation(input);
    },

    "blog_post_publish_wordpress_cancel": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { projectId } = schemas.projectIdSchema.parse(request.input);
      return useCases.stopWordPressDraftCreation(projectId);
    },

    "blog_post_publish_wordpress_delete": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.deleteWordPressDraftSchema.parse(request.input);
      await useCases.deleteWordPressDraft(input);
      return { ok: true };
    },

    "blog_post_publish_wordpress_status": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.refreshWordPressDraftSchema.parse(request.input);
      await useCases.refreshWordPressDraftStatus(input);
      return { ok: true };
    },

    "blog_post_publish_linkedin_start": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.startLinkedInDraftSchema.parse(request.input);
      return useCases.startLinkedInDraftCreation(input);
    },

    "blog_post_publish_linkedin_cancel": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { projectId } = schemas.projectIdSchema.parse(request.input);
      return useCases.stopLinkedInDraftCreation(projectId);
    },

    "blog_post_publish_linkedin_update": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.updateLinkedInDraftSchema.parse(request.input);
      await useCases.updateLinkedInDraft(input);
      return { ok: true } as const;
    },

    "blog_post_publish_linkedin_publish": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.publishLinkedInDraftSchema.parse(request.input);
      return useCases.publishLinkedInDraft(input);
    },

    "blog_post_publish_linkedin_publish_cancel": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { projectId } = schemas.projectIdSchema.parse(request.input);
      return useCases.stopLinkedInDraftPublish(projectId);
    },

    "blog_media_image_save": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.saveImageToMediaSchema.parse(request.input);
      return useCases.saveImageToMediaLibrary(input);
    },

    "blog_media_list": async (_request: PrimitiveInvocationRequest<unknown>) => {
      return useCases.listSavedMedia();
    },

    "blog_personal_skill_create": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.postIdSchema.parse(request.input);
      return useCases.createPersonalSkill(input);
    },

    "blog_transcripts_list": async (_request: PrimitiveInvocationRequest<unknown>) => {
      return useCases.listAvailableTranscripts();
    },

    "blog_wordpress_content_convert": async (request: PrimitiveInvocationRequest<unknown>) => {
      const input = schemas.convertWordPressContentSchema.parse(request.input);
      const converter = getWordPressContentConverter(input.wordpressInstanceId);
      if (!converter) {
        return {
          title: input.title,
          excerpt: input.excerpt,
          content: input.content,
          contentIsHtml: false,
          converted: false,
        };
      }
      const result = await converter(input);
      return {
        title: result.title ?? input.title,
        excerpt: result.excerpt ?? input.excerpt,
        content: result.content,
        contentIsHtml: result.contentIsHtml ?? false,
        converted: true,
      };
    },
  } as const;
}
