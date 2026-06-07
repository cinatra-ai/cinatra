import "server-only";

// ---------------------------------------------------------------------------
// Thin host module for blog projects.
//
// The retained blog project pieces live here as their canonical home:
// the `cinatra.metadata` blob (`source_config:asset-blog`), the
// `cinatra.objects` shadow rows for the 3 blog object types, and the
// project-store operations the facade reaches. Keeping them in this host
// module lets the facade pull them via `BlogSystemDeps` without importing
// `@cinatra-ai/asset-blog` directly.
//
// Module boundaries:
//   • `BlogSystemDeps.projectStore` exposes the operational-metadata +
//     artifact-ref ops the facade needs (no content bytes).
//   • The 3 object types (`blog-post-idea`, `blog-post`, `saved-media`)
//     register from this host module.
//   • Storage location is unchanged (still `source_config:asset-blog`
//     in `cinatra.metadata`); the asset-blog package delegates reads/
//     writes through this module.
// ---------------------------------------------------------------------------

import { registerBlogObjectTypes as registerBlogObjectTypesImpl } from "@/lib/blog/integration/register-object-types";
// Leaf-store import: pull only the project-store functions we delegate,
// not the full `@cinatra-ai/asset-blog` barrel, so the host registration
// path stays lean.
import {
  readBlogPostsProjects,
  readBlogPostsProjectById,
  updateBlogPostDraftImage,
} from "@/lib/blog/store";
import type { BlogProjectStore } from "@cinatra-ai/blog-connector";

/**
 * Host-side `BlogProjectStore` impl injected into the facade. The shape
 * is intentionally narrow and exposes only project metadata and artifact
 * reference updates needed by facade-owned operations.
 */
export function createBlogProjectStore(): BlogProjectStore {
  return {
    listProjects: async () => {
      const projects = await readBlogPostsProjects();
      return projects.map((project) => ({
        id: project.id,
        name: project.name,
        companyUrl: project.companyUrl,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      }));
    },
    getProject: async (projectId) => {
      const project = await readBlogPostsProjectById(projectId);
      if (!project) return null;
      return {
        id: project.id,
        name: project.name,
        companyUrl: project.companyUrl,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
    },
    updatePostImageArtifactRefs: async (input) => {
      await updateBlogPostDraftImage({
        projectId: input.projectId,
        postId: input.postId,
        imageArtifactId: input.imageArtifactId,
        imageRepresentationRevisionId: input.imageRepresentationRevisionId,
        imagePrompt: input.imagePrompt,
      });
    },
  };
}

/**
 * Register the 3 blog object types (`blog-post-idea`, `blog-post`,
 * `saved-media`). This host module is the canonical entry point.
 * The renderer and schema definitions are registered through the
 * implementation imported above.
 */
export function registerBlogObjectTypes(): void {
  registerBlogObjectTypesImpl();
}
