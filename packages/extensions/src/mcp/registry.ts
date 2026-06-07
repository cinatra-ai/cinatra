import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import type { Actor } from "@cinatra-ai/extension-types";
import { createExtensionsPrimitiveHandlers } from "./handlers";
import * as schemas from "./schemas";

// ---------------------------------------------------------------------------
// Admin-gated MCP tool registration for extensions primitives.
//
// Admin gate: getAuthSession() + isPlatformAdmin() (session-based).
// Actor construction: mcpRequestContextStorage (request context for userId/orgId).
// ---------------------------------------------------------------------------

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  extensions_search: {
    description:
      "Search the extensions registry for available agent, skill, connector, and artifact packages. Returns a list of matching packages.",
    inputSchema: schemas.extensionsSearchSchema,
  },
  extensions_install: {
    description:
      "Install an extension package by name and version. Admin-only. Dispatches through the extensionRegistry to the appropriate type handler.",
    inputSchema: schemas.extensionsInstallSchema,
  },
  extensions_update: {
    description:
      "Update an already-installed extension package to a new version. Admin-only.",
    inputSchema: schemas.extensionsUpdateSchema,
  },
  extensions_uninstall: {
    description:
      "Uninstall an extension package by name. Admin-only. Dispatches through the extensionRegistry uninstall handler.",
    inputSchema: schemas.extensionsUninstallSchema,
  },
  // Lifecycle management tools.
  extensions_archive: {
    description:
      "Explicitly archive an installed extension package without checking usage. Admin-only. Sets the canonical installed_extension lifecycle status to 'archived'; the row is preserved for provenance and excluded from dispatch.",
    inputSchema: schemas.extensionsArchiveSchema,
  },
  extensions_restore: {
    description:
      "Restore an archived extension to active state at its pinned version. Admin-only. Sets the canonical installed_extension lifecycle status back to 'active'.",
    inputSchema: schemas.extensionsRestoreSchema,
  },
  extensions_force_delete: {
    description:
      "Permanently delete an installed extension's DB rows + on-disk dir for ONE version (FK pre-clean + WayFlow reload), breaking provenance for historical runs that referenced it. Admin-only, audited. Does NOT touch the Verdaccio registry — the package stays re-installable. For full local removal of the whole package (all installed rows + on-disk dirs + quarantine; the Verdaccio registry is left untouched — version cleanup is a separate ops op) plan it with `extensions_purge` then run the `cinatra extensions purge` CLI.",
    inputSchema: schemas.extensionsForceDeleteSchema,
  },
  // DRY-RUN ONLY. Read-only blast-radius + digest. The destructive purge is
  // executed via the `extensions_purge_execute` MCP tool (admin-gated and
  // invocable by the assistant over MCP) or the equivalent human-origin
  // `cinatra extensions purge` CLI -> admin+loopback `/api/extensions/purge`.
  // This dry-run tool itself never mutates.
  extensions_purge: {
    description:
      "PLAN a FULL extension removal (DB + on-disk dir + WayFlow reload + quarantine snapshot) for ANY kind (agent/skill/connector/artifact). DRY-RUN ONLY — returns the blast radius (kind, every published version, installed template id, active dependents that BLOCK removal) and a `digest`. Admin-only, never mutates. NOTE: purge does NOT yank/unpublish versions from the Verdaccio registry — the published versions stay re-installable; cleaning up registry versions is a separate ops operation (deferred). To EXECUTE, call `extensions_purge_execute` with that exact `digest` + `confirmDestructive:true` (or run the `cinatra extensions purge` CLI). For a SINGLE registry version, the lighter siblings are `extensions_registry_unpublish` (deprecate/yank) and `extensions_registry_delete` (hard-remove one version); `extensions_force_delete` is DB/disk-only (no Verdaccio).",
    inputSchema: schemas.extensionsPurgeSchema,
  },
  // Destructive saga, admin-gated and invocable by the assistant over MCP. In
  // MUTATING_TOOLS so the admin gate applies automatically.
  extensions_purge_execute: {
    description:
      "EXECUTE a full extension purge planned by `extensions_purge`: removes DB rows + on-disk dir + WayFlow reload (with a quarantine recovery snapshot), for ANY kind. Requires the exact `expectedDigest` from a fresh `extensions_purge` dry-run (mandatory TOCTOU handshake) + `confirmDestructive:true`. Admin-only. Runs ONE fail-closed saga under the lifecycle lock: full quarantine (recovery snapshot) → audit purge_started → strict disk delete (verified reload) → atomic DB delete (rolls the dir back from quarantine on failure) → audit purge_committed. Does NOT yank/unpublish versions from the Verdaccio registry — lifecycle primitives never delete from the registry; the published versions stay re-installable and registry version cleanup is a separate ops operation (deferred). Refuses on prod DB host, active dependents, digest mismatch, or unresolved kind.",
    inputSchema: schemas.extensionsPurgeExecuteSchema,
  },
  // Registry-only single-version ops for extension packages.
  extensions_registry_unpublish: {
    description:
      "Deprecate (yank) ONE published version of an extension package in the Verdaccio registry without removing its history. Admin-only, audited (writes extension_lifecycle_audit before the mutation). Registry-only — does NOT touch DB/disk/installed state (use extensions_uninstall/force_delete/purge for that). Kind-agnostic. Reversible (history retained).",
    inputSchema: schemas.extensionsRegistryUnpublishSchema,
  },
  extensions_registry_delete: {
    description:
      "Permanently delete ONE specific version of an extension package from the Verdaccio registry (unlike unpublish, which only deprecates). IRREVERSIBLE. Requires confirmDestructive:true; quarantines the target version's tarball to data/extension-quarantine/ AND writes extension_lifecycle_audit BEFORE the delete (fails closed if the version can't be snapshotted). Returns deleted:true / notFound:true + quarantineDir. Admin-only. Registry-only — does NOT touch DB/disk/installed state. For full all-versions+DB+disk removal use extensions_purge. Kind-agnostic.",
    inputSchema: schemas.extensionsRegistryDeleteSchema,
  },
};

// Tools that mutate state — require admin gate.
const MUTATING_TOOLS = new Set([
  "extensions_install",
  "extensions_update",
  "extensions_uninstall",
  "extensions_archive",
  "extensions_restore",
  "extensions_force_delete",
  // Registry-mutating tools are admin-gated and audited as mutations.
  "extensions_registry_unpublish",
  "extensions_registry_delete",
  // The destructive purge saga is admin-gated; the dry-run `extensions_purge`
  // stays read-only in ADMIN_REQUIRED_TOOLS below.
  "extensions_purge_execute",
]);

// Read-only-but-sensitive tools that still require the admin gate.
// extensions_purge is dry-run only (no mutation, no audit row) but its
// response is the full destructive blast radius (every version, installed
// template id, dependents) — confidential, so it must not be model/anon
// reachable without admin just like the mutating set.
const ADMIN_REQUIRED_TOOLS = new Set(["extensions_purge"]);

function requiresAdminGate(name: string): boolean {
  return MUTATING_TOOLS.has(name) || ADMIN_REQUIRED_TOOLS.has(name);
}

export function registerExtensionsPrimitives(server: McpRuntimeToolServer) {
  const handlers = createExtensionsPrimitiveHandlers();

  for (const [name, handler] of Object.entries(handlers)) {
    const meta = TOOL_META[name] ?? {
      description: name,
      inputSchema: z.object({}).passthrough(),
    };

    server.registerTool(
      name,
      {
        title: name,
        description: meta.description,
        inputSchema: meta.inputSchema,
      },
      (async (input: unknown) => {
        // Resolve the session up-front for every mutating tool and use
        // session.user.id (the identity that just passed the admin gate) as
        // the canonical actor.userId. The request context is populated from a
        // separate source, so any drift between it and the session check would
        // let the audit log record an actor that was not the one who actually
        // authorized the call.
        let sessionUserId: string | undefined;
        if (requiresAdminGate(name)) {
          // Accept admin via either path:
          //   1. cookie-authenticated session that passes isPlatformAdmin,
          //   2. MCP request context already stamped with
          //      platformRole:"platform_admin" by an upstream trusted code
          //      path (e.g. chat route -> /api/mcp transport, which reads
          //      the session role at the request boundary into
          //      mcpRequestContextStorage).
          // Path (2) is required because MCP traffic originating from a
          // cookie-authenticated chat assistant can arrive here with no
          // headers after streaming-response context detaches the cookie;
          // getAuthSession() returns null even though the actor is admin.
          const session = await getAuthSession();
          const sessionIsAdmin = !!session && isPlatformAdmin(session);
          const ctxStore = mcpRequestContextStorage.getStore();
          const ctxIsAdmin = ctxStore?.platformRole === "platform_admin";
          if (!sessionIsAdmin && !ctxIsAdmin) {
            return {
              content: [{ type: "text" as const, text: "Admin access required" }],
              isError: true,
            };
          }
          // Prefer the session user id when available so audit rows match
          // the identity that opened the cookie; fall back to the trusted
          // context userId stamped by the MCP transport.
          sessionUserId = session?.user?.id ?? ctxStore?.userId ?? undefined;
        }

        // For non-mutating tools (extensions_search), fall back to the
        // request-context userId for actor enrichment — no audit row is
        // written so the looser identity binding is acceptable.
        const store = mcpRequestContextStorage.getStore();
        const userId = sessionUserId ?? store?.userId ?? undefined;
        const platformRole = store?.platformRole;
        const orgId = store?.orgId ?? undefined;

        const actor: Actor = {
          actorType: "model",
          source: "agent",
          ...(userId ? { userId } : {}),
          // Forward orgId so kind:"workflow" lifecycle (dashboard
          // materialization) has the organization context; the workflow adapter
          // fails closed (MISSING_ORG_CONTEXT) without it.
          ...(orgId ? { orgId } : {}),
          // Forward platformRole so downstream handlers (audit, lifecycle)
          // see the trusted admin hint without re-reading cookies.
          ...(platformRole ? { platformRole } : {}),
        };

        // Dispatch to the typed handler. extensions_search does not take an
        // actor parameter, so cast and call appropriately.
        const typedHandler = handler as (
          input: unknown,
          actor: Actor,
        ) => Promise<unknown>;
        const result = await typedHandler(input, actor);

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent:
            Array.isArray(result)
              ? { items: result }
              : typeof result === "object" && result !== null
                ? (result as Record<string, unknown>)
                : { result },
        };
      }) as unknown as Parameters<typeof server.registerTool>[2],
    );
  }
}
