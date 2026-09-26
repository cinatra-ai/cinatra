/**
 * THE TIMEZONE FIELD'S ONE RESOLUTION (cinatra#3142 §1).
 *
 * The schedule step's two Timezone controls drew empty because the bound VALUE
 * and the OPTION LIST were resolved independently, with nothing tying them
 * together: the browser's resolved zone went to the value, the platform's zone
 * list went to the options behind a `catch` that returned `["UTC"]`, and `??`
 * never coalesced an empty string. When the list degraded away from the value —
 * or the value arrived blank — no option matched and the trigger had nothing to
 * draw.
 *
 * The invariant belongs in ONE place, not re-argued at each call site:
 *
 *   THE VALUE HANDED TO THE CONTROL IS ALWAYS A MEMBER OF THE OPTION LIST
 *   RENDERED BENEATH IT.
 *
 * This module states it. The value is the first non-blank of the bound value,
 * the browser's zone and the last-resort zone; the option list is the platform's
 * set with that value guaranteed present. A list that could not be read is
 * carried out as `degraded` so the render can SAY so — the old fallback was
 * silent, and the only visible symptom was a blank control.
 *
 * `control` applies the drawing's own size rule for the select family — "Reach
 * for it over Select whenever the option count passes ~8" — so the threshold is
 * stated once here rather than guessed at the two call sites.
 *
 * Pure and DOM-free on purpose: the platform reads are the two thin wrappers at
 * the bottom, and everything that can be got wrong is a function of its inputs.
 */

/** The zone used when neither the form nor the browser offers one. */
export const TIMEZONE_FALLBACK = "UTC";

/**
 * The drawing's size rule for the select family: past ~8 options the drawn
 * control is the type-to-filter combobox, not a plain select.
 */
export const COMBOBOX_OPTION_THRESHOLD = 8;

/** What a trigger falls back to drawing when it holds nothing yet. */
export const TIMEZONE_PLACEHOLDER = "Select a time zone";

/** What the render says instead of degrading in silence. */
export const TIMEZONE_DEGRADED_NOTE =
  "This browser did not offer its time-zone list. Only the current zone is available.";

export interface TimezoneFieldResolution {
  /** The value bound to the control. Never blank, always in `options`. */
  value: string;
  /** The options rendered beneath it. Sorted, de-duplicated, contains `value`. */
  options: string[];
  /** True when the platform's zone list could not be read. */
  degraded: boolean;
  /** The control the drawing's size rule asks for at this option count. */
  control: "combobox" | "select";
}

function firstNonBlank(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed !== "") return trimmed;
  }
  return TIMEZONE_FALLBACK;
}

/**
 * Resolve the value and the options together, so neither can drift from the
 * other. `supported` is `null` when the platform's zone list could not be read
 * — which is a different fact from an empty list and is reported as such.
 */
export function resolveTimezoneField(input: {
  bound?: string | null;
  browserTimezone?: string | null;
  supported: readonly string[] | null;
}): TimezoneFieldResolution {
  const value = firstNonBlank(input.bound, input.browserTimezone, TIMEZONE_FALLBACK);
  const offered = Array.isArray(input.supported) ? input.supported : [];
  const degraded = input.supported === null || offered.length === 0;

  // The value joins the list rather than the list being trusted to hold it:
  // that is the invariant, stated as construction rather than as a check.
  const options = [...new Set([...offered, value])].sort();

  return {
    value,
    options,
    degraded,
    control: options.length > COMBOBOX_OPTION_THRESHOLD ? "combobox" : "select",
  };
}

/**
 * The platform's zone list, or `null` when it could not be read. `null` — not a
 * one-entry list — so the caller can tell "the browser offers only UTC" from
 * "the browser told us nothing", and say so.
 */
export function readSupportedTimezones(): string[] | null {
  try {
    const supportedValuesOf = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf;
    if (typeof supportedValuesOf !== "function") return null;
    const zones = supportedValuesOf.call(Intl, "timeZone");
    if (!Array.isArray(zones) || zones.length === 0) return null;
    return zones;
  } catch {
    return null;
  }
}

/** The browser's own resolved zone, or the last-resort zone. */
export function readBrowserTimezone(): string {
  try {
    return firstNonBlank(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return TIMEZONE_FALLBACK;
  }
}
