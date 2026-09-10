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
import { runBoundedInExtensionEgressScope } from "@/lib/extension-egress-fetch";

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
 * The bound on ONE add, and the reason this module owns one at all.
 *
 * THE CONNECTOR'S WORK IS THE SAME WORK ON BOTH ROADS; THE BOUND WAS NOT. The
 * connector's own setup screen reaches this connector through the extension
 * ui-action dispatch, which runs every handler inside the host's egress scope
 * and under its own bound. The two roads THIS module serves — the MCP tool
 * dispatch the chat catalog is derived from, and the deterministic passthrough
 * the agent-run road uses — never enter a ui action, so the connector's
 * outbound request ran here with no bound of any kind. Measured on one
 * instance, in one minute, against one live connection: the same add settled
 * in 1.95 s through the setup screen while every call on the tool road was
 * still unanswered when its caller gave up at about 59 s. The wedge itself is
 * named in `src/lib/extension-egress-fetch.ts`; what was wrong HERE is only
 * that this road never entered that scope.
 *
 * The value mirrors the ui-action dispatch's own bound, above the egress
 * scope's 20 s, so a stuck outbound request surfaces as the connector's error
 * (which the connector can phrase) and this bound answers only for the ways
 * the connector can stop that the scope cannot reach.
 */
export const APPOINTMENT_SCHEDULE_ADD_TIMEOUT_MS = 30_000;

/**
 * The answer when the connector's add does not settle within the bound, phrased
 * for the bound THAT RUN ACTUALLY WAITED.
 *
 * The sentence names a duration, so it has to name the real one: a caller may
 * choose its own bound, and a sentence that always said thirty seconds would
 * tell somebody we waited far longer than we did. It says the add MAY have been
 * saved on purpose too: the work cannot be cancelled from here, so telling
 * somebody to simply try again could write twice.
 */
export function appointmentScheduleAddTimeoutError(timeoutMs: number): string {
  const waited =
    timeoutMs >= 1000
      ? `${Math.round(timeoutMs / 1000)} seconds`
      : `${Math.round(timeoutMs)} milliseconds`;
  return (
    `Adding the appointment schedule did not finish within ${waited}, so we stopped ` +
    "waiting for it. It may still have been saved: check the appointment schedules " +
    "list before trying again."
  );
}

/** The sentence for the DEFAULT bound, which is the one every shipped caller waits. */
export const APPOINTMENT_SCHEDULE_ADD_TIMEOUT_ERROR = appointmentScheduleAddTimeoutError(
  APPOINTMENT_SCHEDULE_ADD_TIMEOUT_MS,
);

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
  /**
   * How long to wait for the connector before giving up on it and answering.
   * Defaults to `APPOINTMENT_SCHEDULE_ADD_TIMEOUT_MS`. Present so a caller
   * (and a test) can choose its own bound; there is no way to switch the bound
   * OFF.
   */
  timeoutMs?: number;
}): Promise<unknown> {
  const url = typeof args.url === "string" ? args.url : "";
  if (!url) return { error: APPOINTMENT_SCHEDULE_NO_URL_ERROR };
  const invokingUserId =
    typeof args.invokingUserId === "string" && args.invokingUserId.trim().length > 0
      ? args.invokingUserId
      : undefined;
  if (!invokingUserId) return { error: APPOINTMENT_SCHEDULE_NO_USER_ERROR };
  const rawCalendarId = typeof args.calendarId === "string" ? args.calendarId.trim() : "";
  // EVERY touch of the connector happens inside the ONE bounded egress scope
  // the ui-action road already runs in — the module load, the add, and the
  // read-back — so this road cannot stop in a way that road cannot.
  const timeoutMs = args.timeoutMs ?? APPOINTMENT_SCHEDULE_ADD_TIMEOUT_MS;
  const outcome = await runBoundedInExtensionEgressScope(async () => {
    const schedules = await loadAppointmentScheduleModule();
    await schedules.addUserGoogleAppointmentSchedule(
      invokingUserId,
      url,
      rawCalendarId.length > 0 ? rawCalendarId : undefined,
    );
    return schedules.getStoredGoogleAppointmentSchedules(invokingUserId);
  }, timeoutMs);
  if (outcome.kind === "value") return outcome.value;
  // THE CONNECTOR'S OWN REFUSAL IS THE ANSWER, UNCHANGED. The acceptance
  // sentence for a calendar id that is not one of the person's calendars is
  // the CONNECTOR's sentence; a host paraphrase would not be it, and a host
  // that swallowed the throw would turn a refusal into a silent success. So an
  // error from the connector is rethrown exactly as it was raised, and only a
  // bound this host imposed gets a sentence this host wrote.
  if (outcome.kind === "error") throw outcome.error;
  throw new Error(appointmentScheduleAddTimeoutError(timeoutMs));
}
