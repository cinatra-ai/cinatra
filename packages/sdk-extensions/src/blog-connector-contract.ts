// Shared cross-extension BLOG-CONTENT provider contract.
//
// Lives in the SDK (not in `@cinatra-ai/blog-connector`) so a vendor-scoped site
// connector — a private vendor's site connector, a future generic-CMS connector —
// depends ONLY on the SDK for these types and never imports the facade package.
// The facade (the blog-content registry) stays in `@cinatra-ai/blog-connector`;
// this module is the provider-neutral, types-only contract.

/** Provider/connector metadata descriptor — the non-behavioural half. */
export type BlogConnectorDefinition = {
  connectorId: string;
  name: string;
  slug: string;
  description: string;
  settingsHref?: string;
  supportsElementor?: boolean;
};

export type BlogConnectorId = string;

/** Input passed to `BlogConnector.buildDraftPayload`. Provider-neutral. */
export type BlogDraftBuildInput = {
  postTitle: string;
  postExcerpt: string;
  blogPostContent: string;
  contentIsHtml?: boolean;
  latestPublishedPost?: unknown;
  featuredMedia?: { id: number; url: string };
};

/** The WP-shaped create-draft payload returned alongside the optional postMeta. */
export type BlogDraftCreatePayload = {
  title: string;
  content: string;
  excerpt: string;
  status: "draft";
  slug?: string;
  author?: number;
  comment_status?: "open" | "closed";
  ping_status?: "open" | "closed";
  format?: string;
  sticky?: boolean;
  template?: string;
  categories?: number[];
  tags?: number[];
  meta?: Record<string, unknown>;
  featured_media?: number;
};

export type BlogDraftPayload = {
  createPayload: BlogDraftCreatePayload;
  postMeta?: Record<string, unknown>;
};

/** The capability contract every site blog connector implements. */
export interface BlogConnector {
  readonly definition: BlogConnectorDefinition;
  buildDraftPayload(input: BlogDraftBuildInput): Promise<BlogDraftPayload>;
}
