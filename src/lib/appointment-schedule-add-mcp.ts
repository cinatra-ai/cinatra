import "server-only";

// ---------------------------------------------------------------------------
// The appointment-schedule ADD host capability module.
//
// WHY A MODULE AND NOT JUST A DECLARATION. The chat assistant's tool catalog is
// derived from ONE delegated-chat registration pass
// (`buildDelegatedChatCapabilityPlan` -> `registerAllCapabilities`): the
// catalog is exactly `plan.servable`, the set `registerTool` accepted under the
// live perimeter. A primitive that exists only in the deterministic passthrough
// registry (`collectAllPrimitiveHandlers`) is never planned by that pass, so it
// can never appear in the catalog no matter what class the host declares for
// it. Declaring `appointment_schedule_add` in `capability-plan.ts` decides that
// it MAY be admitted; this module is what makes there be something to admit.
//
// ONE IMPLEMENTATION, TWO SURFACES. The behaviour lives in
// `@/lib/appointment-schedule-add.server` and both roads call it, so the
// agent-run road and the chat road cannot drift into two answers.
//
// IDENTITY COMES FROM THE TRUSTED REQUEST FRAME, never from tool input — the
// same rule `connector_inventory_list` states at length: a possibly-injected
// model has nothing to ask another user's store WITH, because the schema
// carries no user, org or scope field and `.strict()` refuses a smuggled one.
// `calendarId` is model-supplied on purpose (it is the acceptance criterion's
// explicit-calendar half) and is validated by the connector against a fresh
// account-scoped calendar list, so an invented id is refused rather than
// stored.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";

/** The primitive's name. Registered as a STRING LITERAL below (the authz
 *  inventory builder scans `server.registerTool("<name>"` statically); this
 *  constant exists for the tests that pin registration + declaration parity. */
export const APPOINTMENT_SCHEDULE_ADD_TOOL_NAME = "appointment_schedule_add";

/**
 * `url` is required; `calendarId` is optional. `.strict()` so a caller that
 * tries to smuggle a userId, orgId or calendar NAME gets a validation failure
 * rather than a silently-ignored field.
 */
export const appointmentScheduleAddSchema = z
  .object({
    url: z
      .string()
      .describe("The public calendar.app.google booking page link for the appointment schedule."),
    calendarId: z
      .string()
      .optional()
      .describe(
        "Optional. The id of the Google calendar to tie the schedule to. Omit to use the " +
          "person's primary calendar. An id that is not one of their calendars is refused.",
      ),
  })
  .strict();

export const APPOINTMENT_SCHEDULE_ADD_TOOL_DESCRIPTION =
  "Save a public Google Calendar appointment schedule (booking page) for the CALLING USER. " +
  "Takes the public calendar.app.google booking link, and optionally the id of the calendar " +
  "to tie it to — omitted, the person's primary calendar is used. The schedule is stored per " +
  "user; identity comes from the request context and is never an argument. Returns the " +
  "caller's stored schedules after the add. Use this when someone asks to add, save or " +
  "connect a booking page or appointment schedule.";

function registerAppointmentScheduleAddPrimitive(server: McpRuntimeToolServer) {
  server.registerTool(
    "appointment_schedule_add",
    {
      title: "appointment_schedule_add",
      description: APPOINTMENT_SCHEDULE_ADD_TOOL_DESCRIPTION,
      inputSchema: appointmentScheduleAddSchema,
    },
    (async (input: unknown) => {
      // Lazily imported so the connector-module + database graph these reach
      // stays off the MCP server's static module graph (same posture as
      // `connector_inventory_list`).
      const { resolveExtensionActorSummary } = await import("@/lib/extension-host-actor");
      const { addAppointmentScheduleForUser } = await import(
        "@/lib/appointment-schedule-add.server"
      );
      const actor = await resolveExtensionActorSummary();
      const args = (input ?? {}) as { url?: unknown; calendarId?: unknown };
      const result = await addAppointmentScheduleForUser({
        invokingUserId: actor?.userId ?? undefined,
        url: args.url,
        calendarId: args.calendarId,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );
}

export function createAppointmentScheduleAddMcpModule() {
  return { registerCapabilities: registerAppointmentScheduleAddPrimitive };
}
