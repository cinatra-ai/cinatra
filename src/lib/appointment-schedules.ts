import "server-only";

// Host-side resolution of `appointment-schedules` capability providers
// (cinatra#151 Stage 4): a connector holding per-user bookable appointment
// schedules (google-calendar's synced booking pages today) registers a
// structured provider from its own `register(ctx)`; the CTA server action
// (packages/agents cta-actions) resolves them HERE at call time — never by
// value-importing a connector package.
//
// Consumer-side hardening (the chat-user-context consumer pattern):
//   - deterministic order: providers sorted by packageName;
//   - structural validation: non-conforming impls/rows skipped with a warning;
//   - failure isolation: a throwing/rejecting provider is skipped with a
//     warning — degraded -> fewer/zero schedules, never a crash. With NO
//     provider registered (connector absent/inactive — it is acquirable-on-
//     demand, not required) the result is simply [].

import type {
  AppointmentScheduleEntry,
  AppointmentSchedulesProvider,
} from "@cinatra-ai/sdk-extensions";
import { APPOINTMENT_SCHEDULES_CAPABILITY_ID } from "@cinatra-ai/sdk-extensions/internal";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";

function isAppointmentSchedulesProvider(impl: unknown): impl is AppointmentSchedulesProvider {
  if (typeof impl !== "object" || impl === null) return false;
  return typeof (impl as { getSchedules?: unknown }).getSchedules === "function";
}

function isScheduleEntry(value: unknown): value is AppointmentScheduleEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { title?: unknown; bookingPageUrl?: unknown };
  return typeof candidate.title === "string" && typeof candidate.bookingPageUrl === "string";
}

/**
 * Resolve the live appointment-schedule providers and collect the user's
 * bookable schedules. Fail-soft per provider; deterministic order; malformed
 * rows are dropped (with a warning).
 */
export async function listAppointmentSchedules(
  userId?: string,
): Promise<AppointmentScheduleEntry[]> {
  const providers = [...resolveCapabilityProviders(APPOINTMENT_SCHEDULES_CAPABILITY_ID)].sort(
    (a, b) => a.packageName.localeCompare(b.packageName),
  );
  const out: AppointmentScheduleEntry[] = [];
  for (const provider of providers) {
    if (!isAppointmentSchedulesProvider(provider.impl)) {
      console.warn(
        `[appointment-schedules] provider ${provider.packageName} has a non-conforming impl — skipped`,
      );
      continue;
    }
    try {
      const result = await provider.impl.getSchedules({ userId });
      if (!Array.isArray(result)) {
        console.warn(
          `[appointment-schedules] provider ${provider.packageName} returned a non-array — skipped`,
        );
        continue;
      }
      for (const row of result) {
        if (isScheduleEntry(row)) {
          out.push({ title: row.title, bookingPageUrl: row.bookingPageUrl });
        } else {
          console.warn(
            `[appointment-schedules] provider ${provider.packageName} returned a malformed schedule — dropped`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[appointment-schedules] provider ${provider.packageName} threw — skipped:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return out;
}
