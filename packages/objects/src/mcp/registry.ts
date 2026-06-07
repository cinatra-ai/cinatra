import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { createObjectsPrimitiveHandlers } from "./handlers";
import { createObjectHistoryPrimitiveHandlers } from "./object-history-handlers";
import * as schemas from "./schemas";

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  "objects_save": {
    description:
      "Save a structured data object. REQUIRED: rawData must contain the actual data as a JSON object (e.g. {\"confirmedRecipients\":[...], \"drafts\":[...]}). typeHint must be a namespaced type identifier like '@cinatra-ai/campaigns:recipients' or '@cinatra-ai/dynamic:email-drafts-bundle' — it is NOT a description of the data. Never put data inside typeHint.",
    inputSchema: schemas.objectsSaveSchema,
  },
  "objects_list": {
    description: "List objects filtered by type, category, or free-text query.",
    inputSchema: schemas.objectsListSchema,
  },
  "objects_get": {
    description: "Fetch an object by id.",
    inputSchema: schemas.objectsGetSchema,
  },
  "objects_update": {
    description: "Update an object's data by id.",
    inputSchema: schemas.objectsUpdateSchema,
  },
  "objects_delete": {
    description: "Soft-delete an object by id (marks deletedAt).",
    inputSchema: schemas.objectsDeleteSchema,
  },
  "objects_classify": {
    description:
      "Dry-run classify raw data. Returns type + confidence + normalizedData with NO write.",
    inputSchema: schemas.objectsClassifySchema,
  },
  "objects_types_list": {
    description: "List all registered object types (static + dynamic).",
    inputSchema: schemas.objectsTypesListSchema,
  },
  "objects_type_register": {
    description:
      "Register a new dynamic object type as active. Idempotent on repeat with the same typeId. Used by agents and external systems to declare types deliberately (skips the classifier 'proposed' review queue).",
    inputSchema: schemas.objectsTypeRegisterSchema,
  },
  // Data Safety: Undo & Versioning MCP primitives.
  "change_set_undo": {
    description:
      "Undo a change-set by replaying inverse events under the CURRENT actor's RBAC authority. Appends a new change-set; never rewrites history. All-or-none. CAS-guarded. Hard-deleted objects are ineligible.",
    inputSchema: schemas.changeSetUndoSchema,
  },
  "object_version_restore": {
    description:
      "Restore a single object to a specific prior version. Degenerate change-set of size 1. Same CAS + all-or-none + current-actor authz semantics as change_set_undo.",
    inputSchema: schemas.objectVersionRestoreSchema,
  },
  "change_set_get": {
    description:
      "Get a change-set with its events + eligibility verdict. Events on objects the current actor cannot read are redacted (partial-visibility safety).",
    inputSchema: schemas.changeSetGetSchema,
  },
  "change_set_list": {
    description:
      "List change-sets for an org/run, ordered by opened_at DESC. Cursor-paginated.",
    inputSchema: schemas.changeSetListSchema,
  },
  "object_history_list": {
    description:
      "List object_change_event rows for a single object, ordered by created_at DESC. Requires object.read on the target.",
    inputSchema: schemas.objectHistoryListSchema,
  },
  "change_set_eligibility_get": {
    description:
      "Read-only eligibility verdict for a change-set. Computes restore eligibility on demand against the current snapshot (referenced reachability + retention + external freshness).",
    inputSchema: schemas.changeSetEligibilityGetSchema,
  },
  // Operational-visibility primitives. NOT in the delegated-chat allowlist
  // (packages/mcp-server delegated-chat-tool-policy.ts), so chat assistants
  // cannot call them; reachable via the UI + authorized direct callers. Each
  // handler enforces org-scoped + per-event read authz (reads) or
  // platform_admin (retry).
  "freshness_check_for_change_set": {
    description:
      "Probe remote freshness for a change-set's CMS-tagged events. Returns a per-event verdict (fresh/changed/missing/unknown/unsupported). Reader authz; results are limited to events the actor can read.",
    inputSchema: schemas.freshnessCheckForChangeSetSchema,
  },
  "remote_effect_attempts_list_for_change_set": {
    description:
      "List remote_effect_attempts (connector restore lifecycle) for a change-set's events. Reader authz; org-scoped + per-event read on the parent change-set.",
    inputSchema: schemas.remoteEffectAttemptsListForChangeSetSchema,
  },
  "remote_effect_attempt_retry": {
    description:
      "Retry a failed/pending connector restore attempt. platform_admin ONLY. Re-invokes the connector restore with the stored intendedState under a fresh idempotency key.",
    inputSchema: schemas.remoteEffectAttemptRetrySchema,
  },
};

export function registerObjectsPrimitives(server: McpRuntimeToolServer) {
  const handlers = {
    ...createObjectsPrimitiveHandlers(),
    ...createObjectHistoryPrimitiveHandlers(),
  };

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
        // Resolve orgId + userId from AsyncLocalStorage populated by the
        // MCP server transport handler from the active better-auth session.
        // Object handlers enforce an orgId guard; without this wiring, every
        // agent-side call throws "actor.orgId is null".
        const requestCtx = mcpRequestContextStorage.getStore();
        const orgId = requestCtx?.orgId ?? null;
        const userId = requestCtx?.userId ?? null;

        // Construct the actor using the unsafe-cast extension pattern
        // (see packages/objects/src/mcp/handlers.ts:41-50 for the consumer
        // side). orgId and userId are not declared on PrimitiveActorContext
        // yet — handlers read them via a typed cast of an opaque key bag.
        //
        // Also propagate platformRole from the MCP request context. The MCP
        // transport resolves platformRole from the cookie session's user.role
        // ('admin' → 'platform_admin'). Without forwarding it here, the
        // kernel `resolveRoles` returns [] for cookie-authenticated admins
        // on org-visibility objects, and `filterByAuthz` silently drops
        // every row in `objects_list` — including legitimately accessible
        // lists that the list-picker UI then renders as "No lists yet."
        // Switch actorType to "human" when a session-derived platformRole
        // is present, otherwise keep "model" for in-process agent calls
        // (no session).
        const platformRole = requestCtx?.platformRole;
        const actorBase: Record<string, unknown> = {
          actorType: platformRole ? "human" : "model",
          source: "agent",
        };
        if (userId) actorBase.userId = userId;
        if (orgId) actorBase.orgId = orgId;
        if (platformRole) actorBase.platformRole = platformRole;

        const result = await handler({
          primitiveName: name,
          input,
          actor: actorBase as unknown as Parameters<typeof handler>[0]["actor"],
          mode: "agentic",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: Array.isArray(result)
            ? { items: result }
            : (result as Record<string, unknown>),
        };
      }) as any,
    );
  }
}
