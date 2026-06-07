import "server-only";

import {
  createWordPressDraft,
  readLatestPublishedWordPressPost,
  readWordPressInstanceById,
  updateWordPressDraftMeta,
  type WordPressWritablePostPayload,
  uploadWordPressMedia,
} from "@/lib/wordpress-api";
// The WordPress draft-write is fully routed through the
// @cinatra-ai/blog-connector facade. The create payload (+ optional
// site-specific `postMeta`) is built by the resolved connector:
//   - no `blogConnectorId` binding -> `defaultBlogConnector` (generic
//     markdown->HTML, no Elementor)
//   - a named `blogConnectorId` -> the bundled site connector registered under
//     that id (e.g. a site-specific page-builder node-tree swap + template selectors)
//
// ALL Elementor-meta construction + the site-specific rendered-template
// selectors live in the bundled site connector. This file (and
// `@cinatra-ai/blog-connector`) contain ZERO Elementor-meta references;
// the grep gate asserts this.
import { buildBlogDraftPayloadThroughSystem } from "@cinatra-ai/blog-connector";
import { readBlogImageArtifactBytes } from "@/lib/blog-image-materializer";

export async function publishBlogPostDraftToWordPress(input: {
  wordpressInstanceId: string;
  companyUrl: string;
  postTitle: string;
  postExcerpt: string;
  blogPostContent: string;
  /** When `true`, `blogPostContent` is already HTML (returned by a site-specific MCP converter). */
  contentIsHtml?: boolean;
  // Image bytes are read from the canonical
  // `@cinatra-ai/blog-image-artifact` representation via refs; the publish
  // path does not accept raw bytes from callers.
  imageArtifactId?: string;
  imageRepresentationRevisionId?: string;
  onProgress?: (message: string, instanceName?: string) => Promise<void> | void;
}) {
  const instance = readWordPressInstanceById(input.wordpressInstanceId);
  if (!instance) {
    throw new Error("Selected WordPress instance not found.");
  }

  await input.onProgress?.("Loading the latest published WordPress post JSON.", instance.name);
  const latestPublishedPost = await readLatestPublishedWordPressPost(instance);

  let featuredMediaId: number | undefined;
  let featuredMediaUrl: string | undefined;
  if (input.imageArtifactId && input.imageRepresentationRevisionId) {
    await input.onProgress?.("Reading image bytes from the blog-image-artifact.", instance.name);
    const bytes = await readBlogImageArtifactBytes({
      imageArtifactId: input.imageArtifactId,
      imageRepresentationRevisionId: input.imageRepresentationRevisionId,
    });
    if (bytes) {
      await input.onProgress?.("Uploading image as the featured image in WordPress.", instance.name);
      const uploadedMedia = await uploadWordPressMedia({
        instance,
        imageBase64: bytes.imageBase64,
        imageMimeType: bytes.imageMimeType,
        title: input.postTitle,
      });
      featuredMediaId = uploadedMedia.mediaId;
      featuredMediaUrl = uploadedMedia.sourceUrl;
    }
  }

  await input.onProgress?.("Preparing the WordPress post payload.", instance.name);
  const builtDraft = await buildBlogDraftPayloadThroughSystem(
    {
      postTitle: input.postTitle,
      postExcerpt: input.postExcerpt,
      blogPostContent: input.blogPostContent,
      contentIsHtml: input.contentIsHtml,
      latestPublishedPost,
      featuredMedia:
        featuredMediaId && featuredMediaUrl
          ? { id: featuredMediaId, url: featuredMediaUrl }
          : undefined,
    },
    {
      instanceBlogConnectorId: instance.blogConnectorId,
    },
  );

  await input.onProgress?.("Creating the draft in WordPress.", instance.name);
  const createdDraft = await createWordPressDraft({
    instance,
    payload: {
      ...builtDraft.createPayload,
      excerpt: input.postExcerpt.trim() || builtDraft.createPayload.excerpt,
      featured_media:
        featuredMediaId ??
        ("featured_media" in builtDraft.createPayload
          ? builtDraft.createPayload.featured_media
          : undefined),
    } satisfies WordPressWritablePostPayload,
  });

  // The resolved connector returns `postMeta` ONLY when it has site-
  // specific meta to write (the named site connector -> the swapped node-tree).
  // The generic default returns `postMeta: undefined` and the second call
  // is skipped entirely.
  if (builtDraft.postMeta) {
    await input.onProgress?.("Applying the connector-supplied post meta to the draft.", instance.name);
    await updateWordPressDraftMeta({
      instance,
      wordpressPostId: createdDraft.wordpressPostId,
      meta: builtDraft.postMeta,
    });
  }

  return {
    instance,
    formattedDraft: builtDraft.createPayload,
    createdDraft,
  };
}
