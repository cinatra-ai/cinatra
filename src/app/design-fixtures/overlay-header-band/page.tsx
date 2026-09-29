import type { Metadata } from "next";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const metadata: Metadata = {
  title: "Design Fixtures — Overlay header band — Cinatra",
  description:
    "Internal route mounting a long select low in the viewport, beneath the app shell's own sticky header, so the overlay-header-band conformance gate can assert an open panel never occupies the header's band.",
};

/**
 * /design-fixtures/overlay-header-band.
 *
 * Internal, unlinked route. The geometry harness for cinatra#3105: an open
 * overlay panel must never OCCUPY the app-shell header's band, even though it
 * paints above it.
 *
 * The header this is measured against is the REAL one — every route renders
 * inside `AppShell` (src/app/layout.tsx), so the sticky 4rem `z-[140]` band
 * carrying the breadcrumb and the top-bar control is already above this page.
 * A copy of it here would only be measured instead of the thing that was
 * reported, so the fixture supplies just the other half: a select whose option
 * list is far taller than the room beneath its trigger, with the trigger pushed
 * low in the viewport — the exact shape observed on a connector setup page,
 * where the list grew upward across the header and hid both.
 *
 * The paired tests/e2e/design/conformance/overlay-header-band.spec.ts asserts
 * on the production-equivalent boot that the open panel's top edge is at or
 * below the real header's bottom edge, in the light theme and the dark theme,
 * and that every option is still reachable inside the bounded panel.
 *
 * Kept OFF the now-retired /design-fixtures catalog (same convention as the
 * header-rule fixture) which cinatra#3189 removed;
 * coverage here is geometry assertion, not snapshot.
 */
const CALENDARS = Array.from({ length: 40 }, (_, i) => ({
  value: `calendar-${i + 1}`,
  label: `Calendar ${i + 1}`,
}));

export default function OverlayHeaderBandFixturePage() {
  return (
    <main className="px-8 pb-[120vh]">
      {/* Push the trigger low in the viewport, so a list this long has to
          resolve upward — the case that used to cross the header. */}
      <div className="h-[70vh]" />
      <div data-testid="fixture-select-field" className="max-w-sm">
        <Select>
          <SelectTrigger data-testid="fixture-select-trigger" className="w-full">
            <SelectValue placeholder="Choose a calendar" />
          </SelectTrigger>
          <SelectContent data-testid="fixture-select-panel">
            {CALENDARS.map((calendar) => (
              <SelectItem key={calendar.value} value={calendar.value}>
                {calendar.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </main>
  );
}
