// Appointment-schedules capability contract (cinatra#151 Stage 4).
//
// A connector that holds per-user bookable appointment schedules (e.g. the
// google-calendar connector's synced appointment booking pages) contributes
// them STRUCTURED through the generic capability registry — the
// chat-user-context pattern's structured sibling. The host's CTA server
// action (packages/agents cta-actions) resolves the live providers instead
// of importing a connector package by name.
//
// Contract expectations for providers:
//   - `getSchedules` is called with the CURRENT user's id (or undefined for
//     an anonymous/system context). It must be cheap and local (read
//     already-synced state; no network round-trips) and return `[]` when
//     there is nothing to contribute.
//   - Sync or async returns are both accepted; the consumer awaits.
//
// Consumer-side hardening mirrors the chat-user-context consumer:
// deterministic provider order (sorted by packageName), structural shape
// validation, per-provider failure isolation (a throwing provider is skipped
// with a warning — it must never fail the action).

/** Capability id under which appointment-schedule providers register. */
export const APPOINTMENT_SCHEDULES_CAPABILITY_ID = "appointment-schedules";

/** One bookable appointment schedule. */
export type AppointmentScheduleEntry = {
  title: string;
  bookingPageUrl: string;
};

/** The provider implementation a connector registers for the capability. */
export type AppointmentSchedulesProvider = {
  /** The user's bookable appointment schedules; `[]` when none are synced. */
  getSchedules(input: {
    userId?: string;
  }): AppointmentScheduleEntry[] | Promise<AppointmentScheduleEntry[]>;
};
