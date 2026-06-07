import "server-only";

// Register extension handlers eagerly when this package is loaded by any
// server worker (Server Action, MCP handler, route handler).
//
// The registration call site in @/lib/extensions is imported as a side effect
// of @/lib/mcp-server. Server Action workers that don't transitively import
// @/lib/mcp-server see an empty extensionRegistry and throw
// `No extension handler registered for typeId: "agent"` when a user clicks
// Restore / Reinstall / Install / Update / Uninstall on the /extensions
// surface.
//
// Importing this module from packages/extensions/src/actions.ts ensures the
// handlers are registered in every worker that runs an extension form action.
import { extensionRegistry } from "./index";
import { createAgentExtensionHandler } from "@cinatra-ai/agents/extension-handler";
import { createSkillExtensionHandler } from "@cinatra-ai/skills/extension-handler";
// Register the connector handler so connector-kind packages resolve a typeId
// and can be reached by extensions_force_delete / extensions_purge for DB,
// audit, and Verdaccio cleanup. Model-B (schema-config) connectors are
// runtime-installable; a bundled-react one raises requires-rebuild.
//
// The Server Action path imports ONLY this bootstrap (NOT
// src/lib/extensions.ts), so the connector handler MUST be wired here WITH the
// `resolveUiSurface` dep too. Without it the handler fails OPEN — a bundled-react
// connector would slip past the typed `ConnectorRequiresRebuildError` and enter
// the real-integrity pipeline, leaving a finalized/generic-failed row instead of
// an explicit REQUIRES_REBUILD state. The resolver lives in `@/lib` (host); it is
// dynamic-imported lazily inside the closure so this bootstrap stays cheap (the
// registry/verdaccio-config graph is only pulled on the FIRST connector
// install/update). registerIfAbsent below still preserves the
// src/lib/extensions.ts-wired version when that heavier boot path also ran
// (last-write-wins is avoided; both wire an equivalent resolver).
import { createConnectorExtensionHandler } from "./connector-handler";
// Register the artifact handler so `kind:"artifact"` packages resolve a
// typeId and can be reached by extensions_force_delete / extensions_purge.
// Unlike connector, its mutators are clean no-ops because descriptor
// registration is owned by the object-registry bridge, not workspace-compiled
// throws.
import { createArtifactExtensionHandler } from "./artifact-handler";
// Workflow is the fifth registered extension kind, closing the gap between
// the workflow package shape and the canonical manifest.
import { createWorkflowExtensionHandler } from "@cinatra-ai/workflows/extension-handler";
// Hot-activate: side-effect-wire the host in-process activate hook so a
// Server Action worker (which imports this bootstrap, NOT the heavy
// `@/lib/extensions` MCP boot module) can hot-activate a connector install/update
// in-process without a restart. Lightweight: the wiring only sets the hook; the
// activator body is lazily imported on the first install. Without it,
// `fireExtensionActivate` returns `no-host-hook` and the dispatcher fail-closes
// the connector install (no silent placeholder-as-success).
import "@/lib/extension-activate-hook-wiring";

extensionRegistry.register(createAgentExtensionHandler());
extensionRegistry.register(createSkillExtensionHandler());
// registerIfAbsent: the app boot path (src/lib/extensions.ts) may also register
// the connector handler with its own uiSurface resolver; this Server-Action-path
// registration must NOT clobber it regardless of module load order. Both wire an
// equivalent `resolveUiSurface` so a bundled-react connector reliably
// surfaces the typed requires-rebuild state on the Server Action path too.
extensionRegistry.registerIfAbsent(
  createConnectorExtensionHandler({
    resolveUiSurface: async (ref) => {
      const { resolveConnectorUiSurfaceForPackage } = await import(
        "@/lib/connector-runtime-install-surface"
      );
      return resolveConnectorUiSurfaceForPackage(ref.packageName, ref.version);
    },
  }),
);
extensionRegistry.register(createArtifactExtensionHandler());
// registerIfAbsent: the app boot path (src/lib/extensions.ts) registers the
// workflow handler WITH re-auth deps; this deps-less package-internal fallback
// must NOT clobber it regardless of module load order (last-write-wins).
extensionRegistry.registerIfAbsent(createWorkflowExtensionHandler());
