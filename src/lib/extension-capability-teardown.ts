import "server-only";

// Single source of truth for the in-memory capability teardown closure the host
// wires into `setExtensionCapabilityTeardownHook` (see src/lib/extensions.ts).
//
// Kept in its own LIGHTWEIGHT module so the invariant test can import the EXACT
// production closure WITHOUT pulling `src/lib/extensions.ts`'s heavy handler graph
// (agents/skills/workflows + separate-repo connector packages). It depends only
// on the four host-owned `invalidate*ForPackage` registries — the four kinds that
// have an in-process `register(ctx)` channel: { MCP tools, capability providers,
// ctx.ui surfaces/actions, object types }. If a fifth in-memory register-channel
// kind is ever added, THIS closure must grow. The per-kind-teardown invariant test
// asserts this exact function's current four-kind contract — it catches a DROPPED
// kind; a newly-added un-wired register-channel would need the test expanded too.

import { removeExtensionMcpToolsForPackage } from "@/lib/extension-mcp-registry";
import { invalidateProvidersForPackage } from "@/lib/extension-capabilities-registry";
import { invalidateExtensionUiForPackage } from "@/lib/extension-ui-registry";
import { invalidateObjectTypesForPackage } from "@/lib/extension-object-types-teardown";

/** Tear down ALL in-memory register(ctx) registrations a purged/archived/uninstalled
 *  package made — its MCP tools, capability providers, ctx.ui surfaces/actions, and
 *  object types — so it is no longer listable/invocable/resolvable in the running
 *  process without a restart. Wired as the host capability teardown hook. */
export function teardownExtensionCapabilities(packageName: string): {
  removedTools: string[];
  removedTypes: string[];
} {
  const removedTools = removeExtensionMcpToolsForPackage(packageName);
  invalidateProvidersForPackage(packageName);
  invalidateExtensionUiForPackage(packageName);
  // Deregister the package's object types so an archived/uninstalled extension's
  // types stop resolving/listing in the running process without a restart.
  const removedTypes = invalidateObjectTypesForPackage(packageName);
  return { removedTools, removedTypes };
}
