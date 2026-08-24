import { createAgentsPrimitiveHandlers, createAgentBuilderPrimitiveHandlers } from "@cinatra-ai/agents/mcp-handlers";
import { createBlogContentPrimitiveHandlers } from "@/lib/blog/mcp/handlers";
// `objects_save` / `objects_classify` / `objects_update` etc. are reachable
// through the /api/agents/passthrough route, but the route's `handlers[tool]`
// lookup goes through this in-process registry. Without this import, the
// passthrough returns 404 "Tool ... has no registered handler", so published
// runs can fail at execution.
import { createObjectsPrimitiveHandlers } from "@cinatra-ai/objects/mcp-handlers";
// cinatra#2960 — the objects-package TYPE registrar, through its narrow
// registration subpath. Mounted here for the same reason as the version-keyed
// serving port below: this in-process registry is the mount point for the
// NON-MCP dispatch paths (e.g. /api/agents/passthrough) that do NOT
// transitively load `@/lib/mcp-server`, whose `createObjectsModule()` is what
// registers these types on the MCP transport path.
import { registerAllObjectTypes as registerObjectsPackageObjectTypes } from "@cinatra-ai/objects/register-object-types";
// cinatra#1392 object-type serve — SIDE-EFFECT import. Loading the version-keyed
// serving registry publishes the edge-bound object-type serve port on its
// globalThis singleton at module load. This in-process primitive registry is the
// mount point for the NON-MCP dispatch paths (e.g. /api/agents/passthrough) that
// do NOT transitively load `@/lib/mcp-server` (which publishes the port on the
// MCP transport path). Importing it here makes the port present before an
// `objects_save` / `objects_types_list` invocation on those paths can run —
// independent of whether the runtime loader's activation ran or was skipped — so
// an edge-bound caller is served fail-closed rather than silently defaulting.
import "@/lib/extension-version-keyed-serving";
// #1625 — wire the run-scoped test-delivery send PORT on the passthrough
// path too (this registry is the mount point for the non-MCP dispatch paths that
// do NOT transitively load @/lib/mcp-server). Fail-closed: the send primitive
// surfaces a clear error if the port was never wired, never a phantom send.
import "@/lib/register-test-delivery-send-port";
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

// Structural data contract for the appointment-schedule surface — resolved by
// SLUG through the manifest entry-module loader (the host names no connector
// package). The export shape below is the host↔connector contract, fixed by
// the connector package and mirrored here (cinatra#2367).
//
// ONE NAME, ONE OWNER: the connector owns `appointment_schedule_list` (its own
// MCP tool, spread in below through loadConnectorPrimitiveHandlers). The core
// keeps exactly ONE bridge — `appointment_schedule_add` — as an
// extension-backed facade, because the assistant's add flow needs the
// invoking-user identity the host holds. There is deliberately no core list
// bridge: a second registration under an `appointment_schedule_*` name would be
// silently overwritten by the spread order below
// (appointment-schedule-primitive-ownership.test.ts pins that).
type AppointmentScheduleModule = {
  getStoredGoogleAppointmentSchedules: (userId: string) => unknown;
  addUserGoogleAppointmentSchedule: (
    userId: string,
    url: string,
    calendarId?: string,
  ) => Promise<unknown>;
};

const APPOINTMENT_SCHEDULE_SLUG = "google-appointment-schedules-connector";

const APPOINTMENT_SCHEDULE_EXPORTS = [
  "getStoredGoogleAppointmentSchedules",
  "addUserGoogleAppointmentSchedule",
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
  // Warm the objects-package type registrar BEFORE the objects_* handlers are
  // mounted (cinatra#2960). Without it an `objects_save` dispatched on a
  // non-MCP path resolves against a COLD registry, so a type the host itself
  // declares is refused fail-closed ("no installed artifact extension defines
  // ..."). Pure in-memory and idempotent (replace-by-id for these null-definer
  // built-ins), so it can neither clobber nor be clobbered by an
  // extension-owned type. Deliberately the PACKAGE registrar, not the
  // app-level one, whose extension-bridge scan would put filesystem work on
  // every dispatch.
  registerObjectsPackageObjectTypes();
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
    // + objects_list + objects_get + objects_types_list.
    ...createObjectsPrimitiveHandlers(),
    ...createSkillsPrimitiveHandlers(),
    // Manifest-discovered connector primitive handlers (manifest slug order).
    ...(await loadConnectorPrimitiveHandlers()),
    ...createPermissionsPrimitiveHandlers(),
    ...createTriggerHandlers(),
    // The ONE retained core appointment-schedule bridge (cinatra#2367). The
    // list side is the connector's own tool, spread in above — do NOT add a
    // core `appointment_schedule_list` back.
    //
    // `calendarId` is OPTIONAL: omitted, the connector resolves the account's
    // PRIMARY calendar (the ratified default-calendar exception); supplied, the
    // connector validates it against a fresh account-scoped calendar list and
    // derives `calendarSummary` server-side. Neither the calendar name nor the
    // user id is ever taken from agent input.
    "appointment_schedule_add": async (request: unknown) => {
      const { input, actor } = (request ?? {}) as {
        input?: Record<string, unknown>;
        actor?: { userId?: string } | null;
      };
      const url = typeof input?.url === "string" ? input.url : "";
      if (!url) return { error: "A booking page URL is required." };
      // Schedules are stored PER USER, so the invoking human must be known.
      // `actor` is the TRUSTED host-built context (the run row / session), never
      // agent-supplied `input` — there is no spoofing surface here.
      const invokingUserId =
        typeof actor?.userId === "string" && actor.userId.trim().length > 0
          ? actor.userId
          : undefined;
      if (!invokingUserId) {
        return {
          error:
            "Appointment schedules are saved per user, and this call carries no invoking user.",
        };
      }
      const rawCalendarId = typeof input?.calendarId === "string" ? input.calendarId.trim() : "";
      const schedules = await loadAppointmentScheduleModule();
      await schedules.addUserGoogleAppointmentSchedule(
        invokingUserId,
        url,
        rawCalendarId.length > 0 ? rawCalendarId : undefined,
      );
      return schedules.getStoredGoogleAppointmentSchedules(invokingUserId);
    },
  };
}
