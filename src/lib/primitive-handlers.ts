import { createAgentsPrimitiveHandlers, createAgentBuilderPrimitiveHandlers } from "@cinatra-ai/agents/mcp-handlers";
import { createBlogContentPrimitiveHandlers } from "@/lib/blog/mcp/handlers";
// `objects_save` / `objects_classify` / `objects_update` etc. are reachable
// through the /api/agents/passthrough route, but the route's `handlers[tool]`
// lookup goes through this in-process registry. Without this import, the
// passthrough returns 404 "Tool ... has no registered handler", so published
// runs can fail at execution.
import { createObjectsPrimitiveHandlers } from "@cinatra-ai/objects/mcp-handlers";
import { createSkillsPrimitiveHandlers } from "@cinatra-ai/skills/mcp-handlers";
import { createGmailPrimitiveHandlers } from "@cinatra-ai/gmail-connector/mcp-handlers";
import { createWordPressPrimitiveHandlers } from "@cinatra-ai/wordpress-mcp-connector/mcp-handlers";
import { createDrupalPrimitiveHandlers } from "@cinatra-ai/drupal-mcp-connector/mcp-handlers";
import { createLinkedInPrimitiveHandlers } from "@cinatra-ai/linkedin-connector/mcp-handlers";
import { createApolloPrimitiveHandlers } from "@cinatra-ai/apollo-connector/mcp-handlers";
import { createPermissionsPrimitiveHandlers } from "@cinatra-ai/permissions/mcp-handlers";
// Trigger handlers exposed for the deterministic passthrough.
import { createTriggerHandlers } from "@cinatra-ai/trigger";
import { createExtensionsPrimitiveHandlers } from "@cinatra-ai/extensions/mcp-handlers";
import {
  getStoredGoogleCalendarAppointments,
  addGoogleCalendarAppointmentSchedule,
  addUserGoogleCalendarAppointmentSchedule,
} from "@cinatra-ai/google-calendar-connector";

export function collectAllPrimitiveHandlers() {
  return {
    // Agent builder first — ensures agent_* tools are within the
    // MAX_FUNCTION_TOOLS window (OpenAI caps function tools at 128).
    ...createAgentsPrimitiveHandlers(),
    // Include the OAS source-authoring, run-trigger, and agent-CRUD primitives
    // so the chat assistant's function-tool path can reach them. Otherwise,
    // those handlers are only available via the native MCP relay
    // (OpenAI → /api/mcp → tunnel), which has no cookie session and therefore
    // no platform_admin role, making admin-gated calls (agent_source_publish,
    // agent_registry_*, agent_run_trigger_*) impossible from chat.
    ...createAgentBuilderPrimitiveHandlers(),
    // Expose ONLY the read-only `extensions_search` so the chat assistant can
    // probe the configured marketplace (registry.cinatra.ai) for existing
    // agents before authoring a new one. Must be early in the map: OpenAI caps
    // function-tools at MAX_FUNCTION_TOOLS=128 and silently truncates the tail,
    // so tools placed after the connector handlers get dropped before the LLM
    // ever sees them. The mutating handlers
    // (install/uninstall/archive/restore/force_delete/update) stay out; they
    // are admin-gated and live at /configuration/marketplace.
    "extensions_search": async (request: unknown) => {
      const { input } = (request ?? {}) as { input?: { query?: string; limit?: number } };
      return createExtensionsPrimitiveHandlers().extensions_search(input ?? {});
    },
    ...createBlogContentPrimitiveHandlers(),
    // CRM account/contact/list primitive handlers were no-op stubs (the
    // retired entity-accounts / entity-contacts / lists packages); the CRM
    // surface is the crm_* facade. Spreads removed with the package deletion.
    // Mounts objects_save + objects_classify + objects_update + objects_delete
    // + objects_list + objects_get + objects_type_register + objects_types_list.
    ...createObjectsPrimitiveHandlers(),
    ...createSkillsPrimitiveHandlers(),
    ...createGmailPrimitiveHandlers(),
    ...createWordPressPrimitiveHandlers(),
    ...createDrupalPrimitiveHandlers(),
    ...createLinkedInPrimitiveHandlers(),
    ...createApolloPrimitiveHandlers(),
    ...createPermissionsPrimitiveHandlers(),
    ...createTriggerHandlers(),
    "calendar_appointments_list": async () => {
      return getStoredGoogleCalendarAppointments();
    },
    "calendar_appointments_add": async (request: unknown) => {
      const { input } = request as { input?: Record<string, unknown> };
      const url = typeof input?.url === "string" ? input.url : "";
      if (!url) return { error: "A booking page URL is required." };
      const invokingUserId = typeof input?._userId === "string" ? input._userId : undefined;
      if (invokingUserId) {
        const { addUserGoogleCalendarAppointmentSchedule } = await import("@cinatra-ai/google-calendar-connector");
        await addUserGoogleCalendarAppointmentSchedule(invokingUserId, url);
        return getStoredGoogleCalendarAppointments(invokingUserId);
      }
      await addGoogleCalendarAppointmentSchedule(url);
      return getStoredGoogleCalendarAppointments();
    },
  };
}
