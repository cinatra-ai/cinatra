"use server";

// This server action runs in its own Turbopack bundle, separate from the
// instrumentation boot graph that calls registerHostConnectorServices().
// Without this side-effect import the bundle never publishes the per-concern
// host services the google-calendar-connector's lazy deps resolve, and
// getStoredGoogleCalendarAppointments() throws "host service not
// registered". Same pattern as src/app/api/chat/runner.ts.
import "@/lib/register-host-connector-services";

import { requireAuthSession } from "@/lib/auth-session";
import { getStoredGoogleCalendarAppointments } from "@cinatra-ai/google-calendar-connector";

type AppointmentSchedule = { title: string; bookingPageUrl: string };

export async function fetchAppointmentSchedules(): Promise<AppointmentSchedule[]> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id;
  const { appointments } = getStoredGoogleCalendarAppointments(userId);
  return appointments.map((a) => ({ title: a.title, bookingPageUrl: a.bookingPageUrl }));
}
