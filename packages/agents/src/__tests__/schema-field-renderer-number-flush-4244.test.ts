// @vitest-environment jsdom
/**
 * cinatra#4244 - how a number field reads its typed text, on the schema-drawn
 * gate of the run page and everywhere else.
 *
 * Asserted at the function level: whether a test DOM keeps text such as
 * `1e309` in a number input depends on its value sanitization, so a DOM test
 * of it could pass without ever reaching the reading.
 *
 *  - ON A GATE (inside `GateContinueHoldContext`): text that is no finite
 *    number is an error ("Enter a valid number.") and its flush hands over
 *    `undefined`, which also clears a value flushed on an earlier press. So a
 *    nested number is left out, never sent stale or as `null`.
 *  - EVERYWHERE ELSE (setup gates, grouped setup forms): exactly as on main -
 *    only text that is not a number at all (NaN) is an error and is not
 *    handed over; `1e309` is handed over as it parses.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/schema-field-renderer-number-flush-4244.test.ts
 */
import { describe, expect, it } from "vitest";

import * as renderer from "../schema-field-renderer";

type Flush = { emit: false } | { emit: true; value: number | undefined };
type Helpers = {
  numberFlushValue: (text: string, kind: "number" | "integer", onGate: boolean) => Flush;
  numberFieldError: (text: string, kind: "number" | "integer", onGate: boolean) => string | null;
};

function helpers(): Helpers {
  const mod = renderer as unknown as Partial<Helpers>;
  if (typeof mod.numberFlushValue !== "function" || typeof mod.numberFieldError !== "function") {
    throw new Error("numberFlushValue / numberFieldError are not exported");
  }
  return mod as Helpers;
}

describe("number field reading on a gate (cinatra#4244)", () => {
  it("hands over undefined for text that is no finite number, clearing an earlier value", () => {
    const { numberFlushValue } = helpers();
    expect(numberFlushValue("5", "number", true)).toEqual({ emit: true, value: 5 });
    for (const text of ["1e309", "-1e309", "abc"]) {
      expect(numberFlushValue(text, "number", true), text).toEqual({ emit: true, value: undefined });
    }
    expect(numberFlushValue("", "number", true)).toEqual({ emit: true, value: undefined });
  });

  it("shows the number error for text that is no finite number", () => {
    const { numberFieldError } = helpers();
    expect(numberFieldError("1e309", "number", true)).toBe("Enter a valid number.");
    expect(numberFieldError("abc", "number", true)).toBe("Enter a valid number.");
    expect(numberFieldError("5", "number", true)).toBeNull();
    expect(numberFieldError("", "number", true)).toBeNull();
  });
});

describe("number field reading everywhere else is main's (cinatra#4244)", () => {
  it("hands over what parses and nothing for NaN, as on main", () => {
    const { numberFlushValue } = helpers();
    expect(numberFlushValue("5", "number", false)).toEqual({ emit: true, value: 5 });
    expect(numberFlushValue("1e309", "number", false)).toEqual({ emit: true, value: Infinity });
    expect(numberFlushValue("abc", "number", false)).toEqual({ emit: false });
    expect(numberFlushValue("", "number", false)).toEqual({ emit: true, value: undefined });
    expect(numberFlushValue("7.9", "integer", false)).toEqual({ emit: true, value: 7 });
  });

  it("shows the number error only for NaN, as on main", () => {
    const { numberFieldError } = helpers();
    expect(numberFieldError("1e309", "number", false)).toBeNull();
    expect(numberFieldError("abc", "number", false)).toBe("Enter a valid number.");
    expect(numberFieldError("5", "number", false)).toBeNull();
  });
});
