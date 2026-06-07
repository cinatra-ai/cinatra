// Blog widget surface — the chat-side post-editor widget was retired. The
// replacement is the `artifact-edit-text` portlet on the
// blog-content-workflow extension's dashboard at `/dashboards/{id}`; reach
// it via the standard `workflow-status` / `object-list` selection chain on
// that dashboard.

import type { WidgetDefinition, WidgetManifest } from "@cinatra-ai/sdk-ui";

export const contentBlogManifest: WidgetManifest = {
  id: "asset-blog",
  description:
    "Blog widget manifest — retained for backward compatibility; no detectors registered.",
  detectors: [],
};

export const contentBlogWidgets: WidgetDefinition[] = [];
