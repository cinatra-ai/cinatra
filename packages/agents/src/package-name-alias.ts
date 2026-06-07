import "server-only";

import { readInstanceIdentity } from "@/lib/instance-identity-store";

/**
 * Narrow operator-vendor → `@cinatra-ai/` alias for the `agent_run` MCP
 * primitive's packageName resolver.
 *
 * Background: publishing rescopes `@cinatra-ai/<slug>` →
 * `@<instanceNamespace>/<slug>` when publishing to Verdaccio. agent_templates
 * rows for in-repo agents stay keyed on the canonical `@cinatra-ai/` scope.
 * Chat assistants / external MCP clients that discover the agent via
 * Verdaccio see the operator-vendor name and pass that. This helper returns
 * the canonical-scoped alias IFF:
 *   1. The input is `@<scope>/<slug>` shaped
 *   2. The scope matches the current instance's namespace
 *   3. The slug is non-empty
 *
 * Returns null when:
 *   - The input doesn't match the operator-vendor pattern
 *   - The current instance namespace can't be read
 *   - The input is already canonical-scoped (`@cinatra-ai/...`)
 *
 * Arbitrary third-party scopes are NOT collapsed to `@cinatra-ai` — only the
 * exact current instance namespace triggers the alias. This narrow
 * normalization prevents the realistic incident class where Verdaccio shows
 * operator-vendor scope while the DB has the canonical scope, without
 * allowing arbitrary scope coercion.
 */

// Same strict shape as PACKAGE_NAME_RE in wayflow-url.ts. Embedded slashes in
// slug are rejected; lowercase + digit + hyphen only. Keeps the alias dialect
// consistent with the canonical packageName invariant.
const STRICT_PACKAGE_NAME_RE = /^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;

export function aliasPackageNameToCanonicalScope(
  packageName: string,
): string | null {
  const match = STRICT_PACKAGE_NAME_RE.exec(packageName);
  if (!match) return null;
  const [, scope, slug] = match;
  if (!scope || !slug) return null;
  if (scope === "cinatra-ai") return null; // already canonical — no alias

  let instanceNamespace: string | undefined;
  try {
    instanceNamespace = readInstanceIdentity()?.instanceNamespace;
  } catch {
    return null;
  }
  if (!instanceNamespace || typeof instanceNamespace !== "string") return null;
  if (instanceNamespace !== scope) return null;
  return `@cinatra-ai/${slug}`;
}
