import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { createBlogContentPrimitiveHandlers } from "./handlers";
import * as schemas from "./schemas";

// Build the primitive actor from the MCP request context so human platform roles are preserved.
function buildActorFromRequestCtx(): Record<string, unknown> {
  const ctx = mcpRequestContextStorage.getStore();
  const platformRole = ctx?.platformRole;
  const actor: Record<string, unknown> = {
    actorType: platformRole ? "human" : "model",
    source: "agent",
  };
  if (ctx?.userId) actor.userId = ctx.userId;
  if (ctx?.orgId) actor.orgId = ctx.orgId;
  if (platformRole) actor.platformRole = platformRole;
  // Transport-resolved org-membership role — coherent with the
  // userId/orgId stamped from the same request-context frame above.
  if (ctx?.orgRole) actor.orgRole = ctx.orgRole;
  return actor;
}

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  "blog_project_list": {
    description: "List all blog projects with metadata only (id, name, companyUrl, createdAt, updatedAt). Call blog_project_get to retrieve ideas, posts, and generation state for a specific project. Uses cursor-based pagination: If nextCursor is present, call again with cursor=<nextCursor> to retrieve the next page.",
    inputSchema: schemas.listProjectsSchema,
  },
  "blog_project_get": {
    description: "Get a blog project with its posts and generation state.",
    inputSchema: schemas.projectIdSchema,
  },
  "blog_project_create": {
    description: "Create a new blog project and start idea generation from transcripts.",
    inputSchema: schemas.createProjectSchema,
  },
  "blog_post_ideas_generate_start": {
    description: "Start generating blog post ideas from the project's linked transcripts.",
    inputSchema: schemas.createProjectSchema,
  },
  "blog_post_ideas_generate_cancel": {
    description: "Cancel an in-progress blog post idea generation.",
    inputSchema: schemas.projectIdSchema,
  },
  "blog_post_generate_start": {
    description: "Start generating a blog post draft from a specific idea.",
    inputSchema: schemas.startDraftGenerationSchema,
  },
  "blog_post_generate_cancel": {
    description: "Cancel an in-progress blog post draft generation.",
    inputSchema: schemas.projectIdSchema,
  },
  "blog_post_update": {
    description:
      "Update a blog post: EITHER raw { title, excerpt, content } (re-materialized) OR artifact refs { postArtifactId, postRepresentationRevisionId, imageArtifactId?, imageRepresentationRevisionId? } to swap (refs-only, no re-materialization). The two shapes are mutually exclusive.",
    inputSchema: schemas.blogPostUpdateToolSchema,
  },
  "blog_image_generate_start": {
    description: "Start generating a hero image for a blog post using AI.",
    inputSchema: schemas.startImageRegenerationSchema,
  },
  "blog_image_generate_cancel": {
    description: "Cancel an in-progress hero image generation.",
    inputSchema: schemas.projectIdSchema,
  },
  "blog_post_publish_wordpress_start": {
    description: "Start creating a WordPress draft for a blog post.",
    inputSchema: schemas.startWordPressDraftSchema,
  },
  "blog_post_publish_wordpress_cancel": {
    description: "Cancel an in-progress WordPress draft creation.",
    inputSchema: schemas.projectIdSchema,
  },
  "blog_post_publish_wordpress_delete": {
    description: "Delete a WordPress draft associated with a blog post.",
    inputSchema: schemas.deleteWordPressDraftSchema,
  },
  "blog_post_publish_wordpress_status": {
    description: "Refresh and return the current status of a WordPress draft.",
    inputSchema: schemas.refreshWordPressDraftSchema,
  },
  "blog_post_publish_linkedin_start": {
    description: "Start creating a LinkedIn post draft for a blog post.",
    inputSchema: schemas.startLinkedInDraftSchema,
  },
  "blog_post_publish_linkedin_cancel": {
    description: "Cancel an in-progress LinkedIn draft creation.",
    inputSchema: schemas.projectIdSchema,
  },
  "blog_post_publish_linkedin_update": {
    description:
      "Update the content of an existing LinkedIn draft. Used by the LinkedIn publish agent to persist operator edits made at the HITL draft-review gate before calling blog_post_publish_linkedin_publish. Returns { ok: true }.",
    inputSchema: schemas.updateLinkedInDraftSchema,
  },
  "blog_post_publish_linkedin_publish": {
    description: "Publish a LinkedIn draft to a LinkedIn page or member profile.",
    inputSchema: schemas.publishLinkedInDraftSchema,
  },
  "blog_post_publish_linkedin_publish_cancel": {
    description: "Cancel an in-progress LinkedIn post publish.",
    inputSchema: schemas.projectIdSchema,
  },
  "blog_media_image_save": {
    description: "Save the generated hero image to the media library.",
    inputSchema: schemas.saveImageToMediaSchema,
  },
  "blog_media_list": {
    description: "List all saved media items in the blog media library.",
    inputSchema: z.object({}),
  },
  "blog_personal_skill_create": {
    description: "Create a personal skill entry for a blog post's generation workflow.",
    inputSchema: schemas.postIdSchema,
  },
  "blog_transcripts_list": {
    description: "List all available transcripts that can be linked to a blog project.",
    inputSchema: z.object({}),
  },
  "blog_wordpress_content_convert": {
    description:
      "Convert blog post content for a specific WordPress instance. If a site-specific converter is registered for the given wordpressInstanceId it is applied and the result is returned; otherwise the original content is returned unchanged. The response includes a `converted` flag and a `contentIsHtml` flag indicating whether the returned content is already HTML.",
    inputSchema: schemas.convertWordPressContentSchema,
  },
};

export function registerBlogContentPrimitives(server: McpRuntimeToolServer) {
  const handlers = createBlogContentPrimitiveHandlers();

  for (const [name, handler] of Object.entries(handlers)) {
    const meta = TOOL_META[name] ?? { description: name, inputSchema: z.object({}).passthrough() };
    server.registerTool(
      name,
      {
        title: name,
        description: meta.description,
        inputSchema: meta.inputSchema,
      },
      (async (input: unknown) => {
        const result = await handler({
          primitiveName: name,
          input,
          actor: buildActorFromRequestCtx() as Parameters<typeof handler>[0]["actor"],
          mode: "agentic",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: Array.isArray(result) ? { items: result } : typeof result === "object" && result !== null ? (result as Record<string, unknown>) : { result },
        };
      }) as any,
    );
  }
}
