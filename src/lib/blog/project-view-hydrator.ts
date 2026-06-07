import "server-only";

// ---------------------------------------------------------------------------
// Server-side hydration helper. The host store carries refs only (post body /
// idea summary / LinkedIn copy / saved-media bytes live in semantic artifacts).
// UI client components consume PLAIN STRINGS (textareas, prose); this helper
// dereferences the refs server-side and returns view objects with hydrated body
// fields.
//
// Mirrors the image-panel.tsx URL pattern for IMAGE bytes (which use
// `/api/artifacts/...` directly from the client); for TEXT bytes the hydrator
// returns the resolved string because textareas need the value, not a URL.
// ---------------------------------------------------------------------------

import { readBlogPostBodyArtifactBytes } from "@/lib/blog-post-artifact-materializer";
import { readBlogIdeaArtifactBytes } from "@/lib/blog-idea-artifact-materializer";
import type {
  BlogPostsProjectRecord,
  BlogPostIdeaRecord,
  BlogPostDraftRecord,
  SavedMediaRecord,
} from "./store";

export type BlogPostIdeaView = BlogPostIdeaRecord & { summary: string };

export type BlogLinkedInDraftView = NonNullable<BlogPostDraftRecord["linkedinDrafts"]>[number] & {
  content: string;
};

export type BlogPostDraftView = Omit<BlogPostDraftRecord, "linkedinDrafts"> & {
  content: string;
  linkedinDrafts?: BlogLinkedInDraftView[];
};

// `media` lives at the top-level `BlogPostsStore`, not on a project —
// re-export for symmetry but `BlogPostsProjectView` does NOT include it.
export type SavedMediaView = SavedMediaRecord;

export type BlogPostsProjectView = Omit<BlogPostsProjectRecord, "posts" | "ideas"> & {
  ideas: BlogPostIdeaView[];
  posts: BlogPostDraftView[];
};

async function hydrateIdea(idea: BlogPostIdeaRecord): Promise<BlogPostIdeaView> {
  if (!idea.summaryArtifactId || !idea.summaryRepresentationRevisionId) {
    return { ...idea, summary: "" };
  }
  const bytes = await readBlogIdeaArtifactBytes({
    artifactId: idea.summaryArtifactId,
    representationRevisionId: idea.summaryRepresentationRevisionId,
  });
  return { ...idea, summary: bytes?.summary ?? "" };
}

async function hydratePost(post: BlogPostDraftRecord): Promise<BlogPostDraftView> {
  const postBodyP =
    post.postArtifactId && post.postRepresentationRevisionId
      ? readBlogPostBodyArtifactBytes({
          artifactId: post.postArtifactId,
          representationRevisionId: post.postRepresentationRevisionId,
        })
      : Promise.resolve(null);
  const linkedinDraftsP = Promise.all(
    (post.linkedinDrafts ?? []).map(async (draft): Promise<BlogLinkedInDraftView> => {
      if (!draft.contentArtifactId || !draft.contentRepresentationRevisionId) {
        return { ...draft, content: "" };
      }
      const bytes = await readBlogPostBodyArtifactBytes({
        artifactId: draft.contentArtifactId,
        representationRevisionId: draft.contentRepresentationRevisionId,
      });
      return { ...draft, content: bytes?.body ?? "" };
    }),
  );
  const [body, linkedinDrafts] = await Promise.all([postBodyP, linkedinDraftsP]);
  const { linkedinDrafts: _legacy, ...rest } = post;
  return {
    ...rest,
    content: body?.body ?? "",
    linkedinDrafts: post.linkedinDrafts === undefined ? undefined : linkedinDrafts,
  };
}

export async function hydrateBlogPostsProject(
  project: BlogPostsProjectRecord,
): Promise<BlogPostsProjectView> {
  const [ideas, posts] = await Promise.all([
    Promise.all(project.ideas.map(hydrateIdea)),
    Promise.all(project.posts.map(hydratePost)),
  ]);
  const { ideas: _i, posts: _p, ...rest } = project;
  return {
    ...rest,
    ideas,
    posts,
  };
}

export async function hydrateBlogPostDraftWithProject(input: {
  draft: BlogPostDraftRecord;
  project: BlogPostsProjectRecord;
  idea: BlogPostIdeaRecord | null;
}): Promise<BlogPostDraftView & {
  project: BlogPostsProjectView;
  idea: BlogPostIdeaView | null;
}> {
  const [draftView, projectView, ideaView] = await Promise.all([
    hydratePost(input.draft),
    hydrateBlogPostsProject(input.project),
    input.idea ? hydrateIdea(input.idea) : Promise.resolve(null),
  ]);
  return { ...draftView, project: projectView, idea: ideaView };
}
