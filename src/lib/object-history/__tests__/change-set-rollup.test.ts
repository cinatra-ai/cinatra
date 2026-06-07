import { describe, expect, it } from "vitest";

import { combineEffect } from "../change-set";
import type { HistoryEffect } from "../types";

describe("combineEffect", () => {
  it("returns the more severe class", () => {
    expect(combineEffect("reversible-internal", "compensating-action")).toBe(
      "compensating-action",
    );
    expect(combineEffect("reversible-internal", "irreversible-logged")).toBe(
      "irreversible-logged",
    );
    expect(combineEffect("compensating-action", "irreversible-logged")).toBe(
      "irreversible-logged",
    );
  });

  it("is commutative", () => {
    const pairs: Array<[HistoryEffect, HistoryEffect]> = [
      ["reversible-internal", "compensating-action"],
      ["reversible-internal", "irreversible-logged"],
      ["compensating-action", "irreversible-logged"],
    ];
    for (const [a, b] of pairs) {
      expect(combineEffect(a, b)).toBe(combineEffect(b, a));
    }
  });

  it("is idempotent on the same class", () => {
    expect(combineEffect("reversible-internal", "reversible-internal")).toBe(
      "reversible-internal",
    );
    expect(combineEffect("irreversible-logged", "irreversible-logged")).toBe(
      "irreversible-logged",
    );
  });
});
