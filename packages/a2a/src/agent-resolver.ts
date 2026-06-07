import "server-only";

import { readPublishedAgentTemplates } from "@cinatra-ai/agents";

/**
 * Resolves a published virtual agent template by its stable packageName
 * identity. Used by the in-process A2A transport to address
 * sub-agents by package name rather than by module factory.
 *
 * Only templates returned by `readPublishedAgentTemplates()` (status =
 * 'published' AND packageName IS NOT NULL) are visible — callers cannot
 * reach unpublished templates via this helper.
 *
 * @throws when packageName is empty, the template does not exist, or the
 *   found template has no packageName set.
 */
export async function resolveAgentByPackageName(
  packageName: string,
): Promise<{ templateId: string; packageName: string }> {
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error(
      "resolveAgentByPackageName: packageName must be a non-empty string",
    );
  }
  const templates = await readPublishedAgentTemplates();
  const match = templates.find((t) => t.packageName === packageName);
  if (!match) {
    throw new Error(
      `resolveAgentByPackageName: no published agent template with packageName "${packageName}"`,
    );
  }
  if (!match.packageName) {
    // Defensive guard — readPublishedAgentTemplates already filters null
    // packageName, but protect against a future filter regression.
    throw new Error(
      `resolveAgentByPackageName: template ${match.id} has no packageName`,
    );
  }
  return { templateId: match.id, packageName: match.packageName };
}
