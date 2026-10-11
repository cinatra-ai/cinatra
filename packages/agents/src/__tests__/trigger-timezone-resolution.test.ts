/**
 * The timezone field's own resolution — the missing invariant (cinatra#3142 §1).
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/trigger-timezone-resolution.test.ts
 *
 * The schedule step drew both Timezone controls empty. The mechanism was not a
 * missing placeholder alone: the bound VALUE and the OPTION LIST were resolved
 * independently, with nothing tying them together. The browser's resolved zone
 * went to the value; `Intl.supportedValuesOf("timeZone")` went to the list
 * inside a `try` whose `catch` returned the single entry `["UTC"]`. When that
 * call was unavailable the list collapsed to one entry while the value stayed
 * whatever the browser resolved, no option matched, and the trigger had nothing
 * to draw. `??` does not coalesce `""`, so an empty bound value took the same
 * path.
 *
 * This suite pins the invariant on the pure resolver, which is where an
 * invariant can be stated once instead of re-argued at each of the two call
 * sites: THE VALUE HANDED TO THE CONTROL IS ALWAYS A MEMBER OF THE OPTION LIST
 * IT RENDERS, for every input the two resolvers can produce — including the
 * degraded list. And the degrade is no longer silent: it is carried out of the
 * resolver as a flag the render surfaces, so "it silently falls back" cannot
 * pass.
 */
import { describe, expect, it } from "vitest";

import {
  COMBOBOX_OPTION_THRESHOLD,
  TIMEZONE_FALLBACK,
  resolveTimezoneField,
} from "../trigger-timezone";

/** A stand-in for the browser's full IANA set — far past the drawing's ~8. */
const FULL_SET = [
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

/** Every input the two resolvers can produce, healthy list and degraded. */
const BOUND_VALUES: Array<string | null | undefined> = [
  undefined,
  null,
  "",
  "   ",
  "Europe/Berlin",
  "Antarctica/Troll", // a real zone this browser's list does not carry
];

const BROWSER_ZONES = ["Europe/Berlin", "Antarctica/Troll", "", "UTC"];

const SUPPORTED_LISTS: Array<{ label: string; supported: string[] | null }> = [
  { label: "the browser's full zone set", supported: FULL_SET },
  { label: "a degraded (unavailable) zone list", supported: null },
  { label: "an empty zone list", supported: [] },
];

describe("the bound value is always a member of the option list beneath it", () => {
  for (const { label, supported } of SUPPORTED_LISTS) {
    for (const bound of BOUND_VALUES) {
      for (const browserTimezone of BROWSER_ZONES) {
        it(
          `with ${label}, bound=${JSON.stringify(bound)}, browser=${JSON.stringify(
            browserTimezone,
          )}`,
          () => {
            const field = resolveTimezoneField({
              bound,
              browserTimezone,
              supported,
            });

            expect(
              field.value,
              "the value handed to the control must never be blank",
            ).not.toBe("");
            expect(field.value.trim()).toBe(field.value);
            expect(
              field.options,
              `the value ${field.value} is not among the ${field.options.length} ` +
                "options rendered beneath it — the control draws empty",
            ).toContain(field.value);
            expect(
              new Set(field.options).size,
              "an option list with duplicates renders the same zone twice",
            ).toBe(field.options.length);
          },
        );
      }
    }
  }
});

describe("an empty bound value is coalesced, which `??` never did", () => {
  it('a bound "" falls through to the browser zone, not through to the control', () => {
    const field = resolveTimezoneField({
      bound: "",
      browserTimezone: "Europe/Berlin",
      supported: FULL_SET,
    });
    expect(field.value).toBe("Europe/Berlin");
  });

  it("a blank browser zone falls through to the last-resort zone", () => {
    const field = resolveTimezoneField({
      bound: "",
      browserTimezone: "",
      supported: FULL_SET,
    });
    expect(field.value).toBe(TIMEZONE_FALLBACK);
  });

  it("a bound zone the browser's list does not carry is offered anyway", () => {
    const field = resolveTimezoneField({
      bound: "Antarctica/Troll",
      browserTimezone: "Europe/Berlin",
      supported: FULL_SET,
    });
    expect(field.value).toBe("Antarctica/Troll");
    expect(field.options).toContain("Antarctica/Troll");
    expect(field.options).toContain("Europe/Berlin");
  });
});

describe("the degrade is observable, never silent", () => {
  it("an unavailable zone list is reported as degraded", () => {
    const field = resolveTimezoneField({
      bound: "Europe/Berlin",
      browserTimezone: "Europe/Berlin",
      supported: null,
    });
    expect(field.degraded).toBe(true);
  });

  it("an empty zone list is reported as degraded too", () => {
    const field = resolveTimezoneField({
      bound: null,
      browserTimezone: "Europe/Berlin",
      supported: [],
    });
    expect(field.degraded).toBe(true);
  });

  it("a healthy zone list is not reported as degraded", () => {
    const field = resolveTimezoneField({
      bound: null,
      browserTimezone: "Europe/Berlin",
      supported: FULL_SET,
    });
    expect(field.degraded).toBe(false);
  });

  it("the degraded resolution differs from the healthy one in more than its list length", () => {
    const healthy = resolveTimezoneField({
      bound: "Europe/Berlin",
      browserTimezone: "Europe/Berlin",
      supported: FULL_SET,
    });
    const degraded = resolveTimezoneField({
      bound: "Europe/Berlin",
      browserTimezone: "Europe/Berlin",
      supported: null,
    });
    expect(degraded.degraded).not.toBe(healthy.degraded);
    expect(degraded.value).toBe(healthy.value);
  });
});

describe('"Reach for it over Select whenever the option count passes ~8"', () => {
  it("the browser's full zone set asks for the type-to-filter combobox", () => {
    const field = resolveTimezoneField({
      bound: null,
      browserTimezone: "Europe/Berlin",
      supported: FULL_SET,
    });
    expect(field.options.length).toBeGreaterThan(COMBOBOX_OPTION_THRESHOLD);
    expect(field.control).toBe("combobox");
  });

  it("a short list stays on the plain select", () => {
    const field = resolveTimezoneField({
      bound: null,
      browserTimezone: "Europe/Berlin",
      supported: ["Europe/Berlin", "UTC"],
    });
    expect(field.options.length).toBeLessThanOrEqual(COMBOBOX_OPTION_THRESHOLD);
    expect(field.control).toBe("select");
  });

  it("the degraded list stays on the plain select", () => {
    const field = resolveTimezoneField({
      bound: null,
      browserTimezone: "Europe/Berlin",
      supported: null,
    });
    expect(field.control).toBe("select");
  });

  it("the threshold is the drawing's ~8, stated once", () => {
    expect(COMBOBOX_OPTION_THRESHOLD).toBe(8);
    const atThreshold = resolveTimezoneField({
      bound: "z1",
      browserTimezone: "z1",
      supported: ["z1", "z2", "z3", "z4", "z5", "z6", "z7", "z8"],
    });
    expect(atThreshold.options).toHaveLength(8);
    expect(atThreshold.control).toBe("select");

    const pastThreshold = resolveTimezoneField({
      bound: "z1",
      browserTimezone: "z1",
      supported: ["z1", "z2", "z3", "z4", "z5", "z6", "z7", "z8", "z9"],
    });
    expect(pastThreshold.options).toHaveLength(9);
    expect(pastThreshold.control).toBe("combobox");
  });
});
