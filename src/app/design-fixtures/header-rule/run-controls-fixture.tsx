"use client";

/**
 * The three conditions cinatra#3142 names, side by side, on the real control.
 *
 * `?controls=timezones&condition=ordinary` (the default) — the browser's full zone set, far past
 * the drawing's "~8", so the drawn control is the type-to-filter combobox.
 * `?condition=degraded` — the platform's list could not be read at all.
 * `?condition=blank` — a bound timezone of the empty string, which is what an
 * applied suggestion can leave behind.
 *
 * The zone list is fixed rather than read from the runner, so the assertions
 * below it are about the CONTROL and not about which zones a machine happens to
 * ship. The resolution and the render are the product's own.
 */

import { useMemo, useState } from "react";

import { Label } from "@/components/ui/label";
import { TimezoneField } from "../../../../packages/agents/src/timezone-field";
import { resolveTimezoneField } from "../../../../packages/agents/src/trigger-timezone";

/** A stand-in for the browser's full IANA set — far past the drawing's ~8. */
const ZONES = [
  "Africa/Cairo",
  "America/Chicago",
  "America/New_York",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Madrid",
  "Pacific/Auckland",
  "UTC",
];

const BROWSER_ZONE = "Europe/Berlin";

export function TimezoneControlFixture({
  condition,
}: {
  condition: "ordinary" | "degraded" | "blank";
}) {
  const [bound, setBound] = useState<string>(
    condition === "blank" ? "" : BROWSER_ZONE,
  );

  const field = useMemo(
    () =>
      resolveTimezoneField({
        bound,
        browserTimezone: BROWSER_ZONE,
        supported: condition === "degraded" ? null : ZONES,
      }),
    [bound, condition],
  );

  return (
    <main className="flex flex-col gap-6 px-8 py-10">
      {(["timezone-scheduled", "timezone-recurring"] as const).map((id) => (
        <div key={id} className="flex flex-col gap-1">
          <Label htmlFor={id} className="font-normal">
            Timezone
          </Label>
          <TimezoneField id={id} field={field} onValueChange={setBound} />
        </div>
      ))}
    </main>
  );
}
