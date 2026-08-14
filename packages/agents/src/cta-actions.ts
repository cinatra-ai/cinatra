"use server";

// This server action runs in its own Turbopack bundle, separate from the
// instrumentation boot graph that calls registerHostConnectorServices().
// Without this side-effect import the bundle never publishes the per-concern
// host services a registered provider's lazy deps resolve, and the
// registered appointment-schedules impl throws "host service not
// registered". Same pattern as src/app/api/chat/runner.ts.
import "@/lib/register-host-connector-services";

import { requireAuthSession } from "@/lib/auth-session";
import { listAppointmentSchedules } from "@/lib/appointment-schedules";

type AppointmentSchedule = { title: string; bookingPageUrl: string };

export async function fetchAppointmentSchedules(): Promise<AppointmentSchedule[]> {
  const session = await requireAuthSession().catch(() => null);
  const userId = session?.user?.id;
  // Registration-driven (cinatra#151 Stage 4): whichever connector holds the
  // user's booking pages registers the `appointment-schedules` capability from
  // its register(ctx) — the CTA chain resolves the CAPABILITY and names no
  // package, so the cinatra#2367 extraction moved the provider without
  // touching this call. No provider registered (connector absent/inactive)
  // -> [] — the connector is acquirable-on-demand, not required.
  return listAppointmentSchedules(userId);
}
