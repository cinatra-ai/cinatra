import type { AgentIOSpec } from "@cinatra-ai/objects";

export const contentBlogPlugin = {
  contentId: "asset-blog",
  name: "Blog",
  slug: "asset-blog",
  description: "Generates and publishes blog posts from transcript content.",
};

// Standalone I/O declaration for asset-blog.
// contentBlogPlugin is a plain object (not AgentPluginDefinition) — exported separately.
// Types use the canonical `@cinatra-ai/assets:*` namespace.
export const blogIoSpec: AgentIOSpec = {
  input: [{ type: "@cinatra-ai/assets:blog-idea", cardinality: "one" }],
  output: [{ type: "@cinatra-ai/assets:blog-post", cardinality: "one-per-input" }],
};
