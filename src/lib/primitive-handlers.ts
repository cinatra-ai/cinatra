import { createAgentsPrimitiveHandlers, createAgentBuilderPrimitiveHandlers } from "@cinatra-ai/agents/mcp-handlers";
import { createBlogContentPrimitiveHandlers } from "@/lib/blog/mcp/handlers";
// `objects_save` / `objects_classify` / `objects_update` etc. are reachable
// through the /api/agents/passthrough route, but the route's `handlers[tool]`
// lookup goes through this in-process registry. Without this import, the
// passthrough returns 404 "Tool ... has no registered handler", so published
// runs can fail at execution.
import { createObjectsPrimitiveHandlers } from "@cinatra-ai/objects/mcp-handlers";
import { createSkillsPrimitiveHandlers } from "@cinatra-ai/skills/mcp-handlers";
// Connector primitive handlers are NOT imported here. They are captured from
// the generated extension manifest (a connector opts in by exporting a
// create*PrimitiveHandlers() factory on its `mcp-handlers` subpath) — see
// loadConnectorPrimitiveHandlers (src/lib/connector-mcp-registration.server.ts).
import { loadConnectorPrimitiveHandlers } from "@/lib/connector-mcp-registration.server";
import { loadConnectorModule } from "@/lib/connector-modules.server";
import { createPermissionsPrimitiveHandlers } from "@cinatra-ai/permissions/mcp-handlers";
// Trigger handlers exposed for the deterministic passthrough.
import { createTriggerHandlers } from "@cinatra-ai/trigger";
import { createExtensionsPrimitiveHandlers } from "@cinatra-ai/extensions/mcp-handlers";

// Structural data contract for the calendar appointment-schedule surface —
// resolved by SLUG through the manifest entry-module loader (the host names no
// connector package). The export shape below is the host↔connector contract.
type AppointmentScheduleModule = {
  getStoredGoogleCalendarAppointments: (userId?: string) => unknown;
  addGoogleCalendarAppointmentSchedule: (url: string) => Promise<unknown>;
  addUserGoogleCalendarAppointmentSchedule: (userId: string, url: string) => Promise<unknown>;
};

const APPOINTMENT_SCHEDULE_SLUG = "google-calendar-connector";

const APPOINTMENT_SCHEDULE_EXPORTS = [
  "getStoredGoogleCalendarAppointments",
  "addGoogleCalendarAppointmentSchedule",
  "addUserGoogleCalendarAppointmentSchedule",
] as const;

async function loadAppointmentScheduleModule(): Promise<AppointmentScheduleModule> {
  const mod = await loadConnectorModule<Partial<AppointmentScheduleModule>>(
    APPOINTMENT_SCHEDULE_SLUG,
  );
  if (!mod) {
    throw new Error(
      `Appointment-schedule connector module not bundled (slug: ${APPOINTMENT_SCHEDULE_SLUG})`,
    );
  }
  // The generic loader cannot type-check the export shape; validate it at the
  // boundary so a renamed/removed export fails with a contract error, not an
  // "is not a function" deep in a handler.
  for (const member of APPOINTMENT_SCHEDULE_EXPORTS) {
    if (typeof mod[member] !== "function") {
      throw new Error(
        `Appointment-schedule connector module (slug: ${APPOINTMENT_SCHEDULE_SLUG}) is missing the "${member}" export`,
      );
    }
  }
  return mod as AppointmentScheduleModule;
}

export async function collectAllPrimitiveHandlers() {
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
    // Manifest-discovered connector primitive handlers (manifest slug order).
    ...(await loadConnectorPrimitiveHandlers()),
    ...createPermissionsPrimitiveHandlers(),
    ...createTriggerHandlers(),
    "calendar_appointments_list": async () => {
      const calendar = await loadAppointmentScheduleModule();
      return calendar.getStoredGoogleCalendarAppointments();
    },
    "calendar_appointments_add": async (request: unknown) => {
      const { input } = request as { input?: Record<string, unknown> };
      const url = typeof input?.url === "string" ? input.url : "";
      if (!url) return { error: "A booking page URL is required." };
      const invokingUserId = typeof input?._userId === "string" ? input._userId : undefined;
      const calendar = await loadAppointmentScheduleModule();
      if (invokingUserId) {
        await calendar.addUserGoogleCalendarAppointmentSchedule(invokingUserId, url);
        return calendar.getStoredGoogleCalendarAppointments(invokingUserId);
      }
      await calendar.addGoogleCalendarAppointmentSchedule(url);
      return calendar.getStoredGoogleCalendarAppointments();
    },
  };
}
