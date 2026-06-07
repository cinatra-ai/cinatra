"use server";

// This server action runs in its own Turbopack bundle, separate from the
// instrumentation boot graph that calls registerTransportConnectors(). Without
// this side-effect import the bundle's copy of the google-calendar-connector
// DI singleton is never wired and getStoredGoogleCalendarAppointments() throws
// "host runtime deps not registered". Same pattern as src/app/api/chat/runner.ts.
import "@/lib/register-transport-connectors";

import { requireAuthSession } from "@/lib/auth-session";
import { getStoredGoogleCalendarAppointments } from "@cinatra-ai/google-calendar-connector";

type AppointmentSchedule = { title: string; bookingPageUrl: string };

export async function fetchAppointmentSchedules(): Promise<AppointmentSchedule[]> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id;
  const { appointments } = getStoredGoogleCalendarAppointments(userId);
  return appointments.map((a) => ({ title: a.title, bookingPageUrl: a.bookingPageUrl }));
}
