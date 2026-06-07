/**
 * Server-side manifest registry. Imports manifests (metadata only, no React)
 * from all widget packages and provides lookup helpers.
 */

import type { WidgetManifest } from "@cinatra-ai/sdk-ui";
import { contentBlogManifest } from "@/components/widgets/blog";
import { crmContactFinderManifest } from "@cinatra-ai/crm-connector/widgets";
import { connectorApolloManifest } from "@cinatra-ai/apollo-connector/widgets";

const ALL_MANIFESTS: WidgetManifest[] = [
  contentBlogManifest,
  crmContactFinderManifest,
  connectorApolloManifest,
];

export function getAllManifests(): WidgetManifest[] {
  return ALL_MANIFESTS;
}

export function getManifestByResourceType(resourceType: string): WidgetManifest | null {
  return ALL_MANIFESTS.find(
    (m) => m.wizard?.staging.resourceType === resourceType,
  ) ?? null;
}

export function findManifestForCreateTool(toolName: string): WidgetManifest | null {
  return ALL_MANIFESTS.find(
    (m) => m.wizard?.staging.createTools.includes(toolName),
  ) ?? null;
}

export function findManifestForUpdateTool(toolName: string): WidgetManifest | null {
  return ALL_MANIFESTS.find(
    (m) => m.wizard?.staging.updateTools.includes(toolName),
  ) ?? null;
}

/** Collects all refresh tool patterns from all manifests. */
export function getAllRefreshToolPatterns(): string[] {
  return ALL_MANIFESTS.flatMap((m) => m.refreshToolPatterns ?? []);
}

/** Collects all data bindings from all wizard manifests. */
export function getAllDataBindings() {
  return ALL_MANIFESTS.flatMap((m) => {
    if (!m.wizard) return [];
    const resourceType = m.wizard.staging.resourceType;
    return m.wizard.steps.flatMap((step) =>
      (step.dataBindings ?? []).map((binding) => ({
        ...binding,
        resourceType,
        widgetId: step.widgetId,
      })),
    );
  });
}
