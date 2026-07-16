import "server-only";
import {
  extensionRegistry,
  setExtensionCapabilityTeardownHook,
} from "@cinatra-ai/extensions";
// Hot-activate: the activate hook is wired by the SHARED lightweight
// wiring module (also imported by the Server Action path's handler-bootstrap), so
// every worker that can drive extensionRegistry.install/.update has it wired —
// not just the MCP boot path. Single source of truth (idempotent).
import "@/lib/extension-activate-hook-wiring";
// Side-effect import: installs the durable data-teardown hook. Kept in its own
// lightweight module so the UI Server Action path + instrumentation boot can
// wire it WITHOUT pulling this module's heavy handler-graph imports.
import "@/lib/extension-data-teardown-wiring";
// Side-effect import: installs the org-scoped dashboard-archival lifecycle hook
// (cinatra#1628, S11a — archive/restore extension dashboards on the committed
// (package, org) transition). Same lightweight-wiring rationale as above.
import "@/lib/extension-dashboard-lifecycle-wiring";
// The in-memory capability teardown closure (the four register-channel kinds)
// lives in a shared lightweight module — single source of truth the host wires
// here and the per-kind-teardown invariant test asserts directly.
import { teardownExtensionCapabilities } from "@/lib/extension-capability-teardown";
// Side-effect import: HOST-side binding of the external-MCP-registry connector's
// WRITE named actions (createServer/deleteServer), discovered from the generated
// manifest (core names no extension). The connector's own register(ctx) registers
// only the read/probe actions and DEFERS the write actions + their per-operation
// authorization to the host (cinatra#658, PR-4). Registering them here lands them
// in the same ui-action registry the host action endpoint reads.
import "@/lib/mcp-server-write-actions";
import { createAgentExtensionHandler } from "@cinatra-ai/agents/extension-handler";
import { createSkillExtensionHandler } from "@cinatra-ai/skills/extension-handler";
import { createConnectorExtensionHandler } from "@cinatra-ai/extensions/connector-handler";
import { createArtifactExtensionHandler } from "@cinatra-ai/extensions/artifact-handler";

// Register handlers at startup. Imported as a side effect from src/lib/mcp-server.ts.
extensionRegistry.register(createAgentExtensionHandler());
extensionRegistry.register(createSkillExtensionHandler());
// kind:"connector" handler (model-B-aware). A schema-config connector
// (cinatra.uiSurface: "schema-config" + cinatra.configSchema, ships NO bundled
// React) is RUNTIME-INSTALLABLE — install/update/uninstall are clean no-ops so
// the dispatcher's real-integrity pipeline materializes + hot-activates it. A
// bundled-react connector raises the typed ConnectorRequiresRebuildError (the
// dispatch surfaces it as a clear "requires rebuild" state, never a crash). The
// host injects the uiSurface resolver (reads the resolved manifest's
// cinatra.uiSurface) because the handler must not round-trip the registry on its
// own boundary. See packages/extensions/src/connector-handler.ts.
extensionRegistry.register(
  createConnectorExtensionHandler({
    resolveUiSurface: async (ref) => {
      const { resolveConnectorUiSurfaceForPackage } = await import(
        "@/lib/connector-runtime-install-surface"
      );
      return resolveConnectorUiSurfaceForPackage(ref.packageName, ref.version);
    },
  }),
);
// kind:"artifact" handler. Metadata-only; descriptor (re)registration
// is owned by the object-registry bridge, so mutators are clean audit
// no-ops (not workspace-compiled throws).
extensionRegistry.register(createArtifactExtensionHandler());

// Split-brain guard: inject the in-memory capability teardown the
// purge saga fires after a committed DB delete. `removeExtensionMcpToolsForPackage`
// lives in `@/lib` (the host), which `@cinatra-ai/extensions` cannot import, so
// the host wires it here via the globalThis-anchored hook (mirrors
// `setLiveAgentManifestProvider`). Set on this module's load — the same boot
// side-effect path that registers the handlers above, and the path the MCP
// `extensions_purge_execute` handler runs through.
// Tear down ALL in-memory register(ctx) registrations a purged package made:
// its MCP tools, its capability providers, and its ctx.ui surfaces/actions. The
// purge saga fires this after the DB delete commits so a removed extension is
// no longer listable/invocable/resolvable in the running process without a restart.
// The closure body lives in the shared lightweight `extension-capability-teardown`
// module so the per-kind-teardown invariant test can assert the EXACT production
// closure without importing this heavy handler-graph module.
setExtensionCapabilityTeardownHook((packageName) => teardownExtensionCapabilities(packageName));

// (The hot-activate hook is wired by the shared
// `@/lib/extension-activate-hook-wiring` side-effect import at the top of this
// file — it injects the in-process activator the dispatcher fires after a
// verdaccio-source NEW install / UPDATE commits, so the running process picks the
// package up WITHOUT a restart. Shared so the Server Action path wires it too.)

export { extensionRegistry };
