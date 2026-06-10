/**
 * Server-side wizard/widget manifest registry. Resolves the LIVE manifest set
 * from the generated extension manifest + extension lifecycle
 * (chat-widget-catalog.server.ts) — no extension package is named here, and
 * adding/removing a widget-bearing extension changes the result with zero
 * edits to this file (#34 / IOC-40, IOC-41).
 *
 * The former per-tool/per-resource lookup helpers (getManifestByResourceType,
 * findManifestForCreateTool/UpdateTool, getAllRefreshToolPatterns,
 * getAllDataBindings) had no consumers anywhere in the tree and were removed
 * with the static-import cutover; the catalog is the substrate to rebuild any
 * of them on when a consumer appears.
 */

import type { WidgetManifest } from "@cinatra-ai/sdk-ui";
import { resolveChatWidgetManifests } from "@/lib/chat-widget-catalog.server";

export async function getAllManifests(): Promise<WidgetManifest[]> {
  return resolveChatWidgetManifests();
}
