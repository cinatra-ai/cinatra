import "server-only";

// ---------------------------------------------------------------------------
// THE ONE `appointment_schedule_add` IMPLEMENTATION.
//
// The primitive is reachable on TWO host surfaces and they must never be two
// implementations:
//
//   - the deterministic passthrough registry (`collectAllPrimitiveHandlers`),
//     which the agent-run road dispatches through, and
//   - the MCP registration pass (`registerAllCapabilities`), which is the ONLY
//     surface the chat assistant's catalog is derived from.
//
// The second one is the whole reason this module exists. A declaration in
// `capability-plan.ts` decides whether a REGISTERED primitive may be admitted
// to delegated chat; it cannot conjure a registration. A primitive that lives
// only in the passthrough map is never planned, never lands in `plan.servable`,
// and is therefore never offered to the model — however it is declared. Both
// halves are required, and this module is what lets the second one exist
// without forking the behaviour the connector's own tests prove.
//
// IDENTITY IS NEVER AGENT INPUT. The invoking user arrives from the trusted
// host frame (the run row / MCP request context), never from the tool's
// arguments — a possibly-injected model cannot ask for someone else's store.
// `calendarId` IS model-supplied, and is deliberately not trusted either: the
// connector validates it against a FRESH account-scoped calendar list and
// derives `calendarSummary` server-side, so an invented id is refused rather
// than stored.
// ---------------------------------------------------------------------------

import { loadConnectorModule } from "@/lib/connector-modules.server";

/**
 * The structural host-connector contract for the appointment-schedule surface,
 * resolved by SLUG through the manifest entry-module loader (the host names no
 * connector package). Fixed by the connector package and mirrored here
 * (cinatra#2367).
 */
export type AppointmentScheduleModule = {
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

export async function loadAppointmentScheduleModule(): Promise<AppointmentScheduleModule> {
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

/** The refusal returned when the call carries no trusted invoking human. */
export const APPOINTMENT_SCHEDULE_NO_USER_ERROR =
  "Appointment schedules are saved per user, and this call carries no invoking user.";

/** The refusal returned when the model supplied no booking page URL. */
export const APPOINTMENT_SCHEDULE_NO_URL_ERROR = "A booking page URL is required.";

/**
 * Add one appointment schedule for the TRUSTED invoking user and return that
 * user's stored schedules.
 *
 * `invokingUserId` is resolved by the CALLER from its own trusted frame — the
 * passthrough's host-built actor, or the MCP request context — and is never
 * read from `input` on either road.
 *
 * `calendarId` is OPTIONAL: omitted, the connector resolves the account's
 * PRIMARY calendar (the ratified default-calendar exception); supplied, the
 * connector validates it against a fresh account-scoped calendar list.
 */
export async function addAppointmentScheduleForUser(args: {
  invokingUserId: string | undefined;
  url: unknown;
  calendarId: unknown;
}): Promise<unknown> {
  const url = typeof args.url === "string" ? args.url : "";
  if (!url) return { error: APPOINTMENT_SCHEDULE_NO_URL_ERROR };
  const invokingUserId =
    typeof args.invokingUserId === "string" && args.invokingUserId.trim().length > 0
      ? args.invokingUserId
      : undefined;
  if (!invokingUserId) return { error: APPOINTMENT_SCHEDULE_NO_USER_ERROR };
  const rawCalendarId = typeof args.calendarId === "string" ? args.calendarId.trim() : "";
  const schedules = await loadAppointmentScheduleModule();
  await schedules.addUserGoogleAppointmentSchedule(
    invokingUserId,
    url,
    rawCalendarId.length > 0 ? rawCalendarId : undefined,
  );
  return schedules.getStoredGoogleAppointmentSchedules(invokingUserId);
}
