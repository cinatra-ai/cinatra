import "server-only";

import {
  createInProcessPrimitiveTransport,
  invokePrimitive,
  type PrimitiveActorContext,
  type PrimitiveTransport,
} from "@cinatra-ai/mcp-client";
import { createBlogContentPrimitiveHandlers } from "../handlers";

export type DeterministicBlogContentClient = ReturnType<typeof createDeterministicBlogContentClient>;

export function createDeterministicBlogContentClient(input: {
  actor: PrimitiveActorContext;
  transport?: PrimitiveTransport;
}) {
  const transport =
    input.transport ??
    createInProcessPrimitiveTransport(createBlogContentPrimitiveHandlers());

  function invoke<TOutput>(primitiveName: string, primitiveInput: unknown) {
    return invokePrimitive<unknown, TOutput>(transport, {
      primitiveName,
      input: primitiveInput,
      actor: input.actor,
      mode: "deterministic",
    });
  }

  return {
    project: {
      list: (cursor?: string) => invoke<{ items: Array<{ id: string; name: string; companyUrl: string; createdAt: string; updatedAt: string }>; total: number; nextCursor?: string }>("blog_project_list", { cursor }),
      get: (projectId: string) => invoke("blog_project_get", { projectId }),
      create: (input: { name: string; companyUrl: string; ideasPerTranscript?: number; transcriptIds?: string[] }) =>
        invoke("blog_project_create", input),
    },
    ideas: {
      startGeneration: (input: { name: string; companyUrl: string; ideasPerTranscript?: number; transcriptIds?: string[] }) =>
        invoke("blog_post_ideas_generate_start", input),
      cancelGeneration: (projectId: string) =>
        invoke("blog_post_ideas_generate_cancel", { projectId }),
    },
    post: {
      startGeneration: (projectId: string, ideaId: string) =>
        invoke("blog_post_generate_start", { projectId, ideaId }),
      cancelGeneration: (projectId: string) =>
        invoke("blog_post_generate_cancel", { projectId }),
      update: (
        input:
          | { projectId: string; postId: string; title: string; excerpt: string; content: string }
          | {
              projectId: string;
              postId: string;
              postArtifactId: string;
              postRepresentationRevisionId: string;
              imageArtifactId?: string;
              imageRepresentationRevisionId?: string;
            },
      ) => invoke<{ ok: true }>("blog_post_update", input),
    },
    image: {
      startRegeneration: (input: { projectId: string; postId: string; prompt?: string }) =>
        invoke("blog_image_generate_start", input),
      cancelRegeneration: (projectId: string) =>
        invoke("blog_image_generate_cancel", { projectId }),
    },
    wordpress: {
      startDraft: (input: { projectId: string; postId: string; wordpressInstanceId: string }) =>
        invoke("blog_post_publish_wordpress_start", input),
      cancelDraft: (projectId: string) =>
        invoke("blog_post_publish_wordpress_cancel", { projectId }),
      deleteDraft: (input: { projectId: string; postId: string; wordpressDraftId: string }) =>
        invoke<{ ok: true }>("blog_post_publish_wordpress_delete", input),
      refreshStatus: (input: { projectId: string; postId: string; wordpressDraftId: string }) =>
        invoke<{ ok: true }>("blog_post_publish_wordpress_status", input),
      convertContent: (input: {
        wordpressInstanceId: string;
        title: string;
        excerpt: string;
        content: string;
      }) =>
        invoke<{
          title: string;
          excerpt: string;
          content: string;
          contentIsHtml: boolean;
          converted: boolean;
        }>("blog_wordpress_content_convert", input),
    },
    linkedin: {
      startDraft: (input: {
        projectId: string;
        postId: string;
        linkedinAccountId: string;
        // Required, matches the use-case, port, and schema.
        linkedinAccountName: string;
        destinationType: "member" | "organization";
        destinationId: string;
        destinationName: string;
        blogPostUrl: string;
      }) => invoke("blog_post_publish_linkedin_start", input),
      cancelDraft: (projectId: string) =>
        invoke("blog_post_publish_linkedin_cancel", { projectId }),
      publish: (input: { projectId: string; postId: string; linkedinDraftId: string; linkedinAccountId: string }) =>
        invoke("blog_post_publish_linkedin_publish", input),
      cancelPublish: (projectId: string) =>
        invoke("blog_post_publish_linkedin_publish_cancel", { projectId }),
    },
    media: {
      saveImage: (input: { projectId: string; postId: string; title?: string; description?: string }) =>
        invoke("blog_media_image_save", input),
      list: () => invoke("blog_media_list", {}),
    },
    personalSkill: {
      create: (input: { projectId: string; postId: string }) =>
        invoke<{ skillId: string; skillName: string }>("blog_personal_skill_create", input),
    },
    transcripts: {
      list: () => invoke("blog_transcripts_list", {}),
    },
  };
}
