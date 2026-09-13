"use client";

/**
 * THE TIMEZONE CONTROL, DRAWN IN ONE PLACE (cinatra#3142 §1).
 *
 * The schedule step draws this twice — once in the scheduled block, once in the
 * recurring one — and the run page is not the only surface that will ever ask
 * for a zone. It is a component rather than a closure inside the form for two
 * reasons: neither call site can then restate the drawing differently, and a
 * conformance fixture can mount THIS, so what the browser measures is the same
 * render the product ships rather than a copy of it.
 *
 * What it draws is decided by `resolveTimezoneField` (see `./trigger-timezone`),
 * which hands over a value that is always a member of its own option list:
 *
 *  - past the drawing's "~8" size rule for the select family, the type-to-filter
 *    Combobox, where "the current value carries an indigo check";
 *  - at or below it — which in practice means a zone list the platform refused
 *    to give us — the plain Select;
 *  - either way a placeholder, so a trigger has something to draw even in a
 *    state neither control is supposed to reach;
 *  - and, when the platform's list could not be read, the degrade is SAID
 *    beside the control instead of being swallowed.
 */

import { Combobox } from "@/components/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  TIMEZONE_DEGRADED_NOTE,
  TIMEZONE_PLACEHOLDER,
  type TimezoneFieldResolution,
} from "./trigger-timezone";

export function TimezoneField({
  id,
  field,
  onValueChange,
  className = "w-56",
}: {
  /** The control's id, which its Label points at. */
  id: string;
  /** The one resolution: the value, its options, the degrade, the control. */
  field: TimezoneFieldResolution;
  onValueChange: (value: string) => void;
  className?: string;
}) {
  return (
    <>
      {field.control === "combobox" ? (
        <Combobox
          id={id}
          value={field.value}
          onValueChange={onValueChange}
          options={field.options.map((tz) => ({ value: tz }))}
          placeholder={TIMEZONE_PLACEHOLDER}
          searchPlaceholder="Search time zones…"
          emptyText="No time zone matches that search."
          className={className}
        />
      ) : (
        <Select value={field.value} onValueChange={onValueChange}>
          <SelectTrigger id={id} className={className}>
            <SelectValue placeholder={TIMEZONE_PLACEHOLDER} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((tz) => (
              <SelectItem key={tz} value={tz}>{tz}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {field.degraded && (
        <p
          role="status"
          data-slot="timezone-degraded"
          className="text-xs text-muted-foreground"
        >
          {TIMEZONE_DEGRADED_NOTE}
        </p>
      )}
    </>
  );
}
