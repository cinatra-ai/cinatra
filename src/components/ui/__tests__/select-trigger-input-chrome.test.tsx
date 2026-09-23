// @vitest-environment jsdom
//
// Select — the components drawing's "Trigger mirrors Input chrome" clause, the
// one sentence of that section this leg is answerable for (cinatra#3189,
// shared-primitives wave, leg 2).
//
//   pnpm exec vitest run src/components/ui/__tests__/select-trigger-input-chrome.test.tsx
//
// The clause, quoted verbatim from the section's chrome line and its prose:
//
//   "inherits input chrome"
//   "Trigger mirrors Input chrome."
//
// MEASURED before the fix, against `Input`'s own live classes:
//
//   ground   Input `bg-surface-strong` (pure white)  vs trigger `bg-transparent`
//   corner   Input `rounded-[7px]`                   vs trigger `rounded-md`
//   box      Input `h-8` (32px)                      vs trigger `h-9` (36px)
//   padding  Input `px-2.5 py-1`                     vs trigger `px-3 py-2`
//
// Four of the five chrome values the clause names disagreed, so the control the
// drawing calls a mirror of Input was drawing a different control.
//
// HOW THIS FILE STATES THE CLAUSE. Every expectation below reads the value off
// `Input`'s own rendered class list rather than restating a number. That is the
// clause as written: it does not name a corner or a ground, it names Input. A
// file full of literals would pass on the day Input moved and the mirror did
// not — which is the only failure this clause has.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";

afterEach(cleanup);

function classesOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function inputClasses(): string[] {
  const { container } = render(<Input aria-label="Mirror reference" />);
  return classesOf(container.querySelector('[data-slot="input"]')!);
}

function triggerClasses(size: "default" | "sm" = "default"): string[] {
  const { container } = render(
    <Select>
      <SelectTrigger size={size} aria-label="Mirror">
        <SelectValue placeholder="Most-used today" />
      </SelectTrigger>
    </Select>,
  );
  return classesOf(container.querySelector('[data-slot="select-trigger"]')!);
}

/** The chrome utilities the clause covers, picked out of a full class list. */
function chrome(classes: string[]) {
  const find = (re: RegExp) => classes.find((c) => re.test(c));
  return {
    ground: find(/^bg-(surface-strong|transparent|background|input-fill)/),
    corner: find(/^rounded-/),
    padX: find(/^px-/),
    padY: find(/^py-/),
  };
}

describe('clause: "Trigger mirrors Input chrome." / "inherits input chrome"', () => {
  it("mirrors Input's GROUND, whatever Input's ground is", () => {
    expect(chrome(triggerClasses()).ground).toBe(chrome(inputClasses()).ground);
  });

  it("mirrors Input's CORNER, whatever Input's corner is", () => {
    // Read as a mirror rather than as "7px": if Input's corner moves, the
    // trigger has to move with it, and a literal here would not say that.
    expect(chrome(triggerClasses()).corner).toBe(chrome(inputClasses()).corner);
  });

  it("mirrors Input's PADDING on both axes", () => {
    const trigger = chrome(triggerClasses());
    const input = chrome(inputClasses());
    expect(trigger.padX).toBe(input.padX);
    expect(trigger.padY).toBe(input.padY);
  });

  it("mirrors Input's BOX at the default size", () => {
    // The trigger states its height through a size-keyed variant rather than a
    // bare utility, so the mirror is read against Input's own bare `h-*`.
    const inputHeight = inputClasses().find((c) => /^h-\d/.test(c));
    expect(inputHeight).toBeTruthy();
    expect(triggerClasses()).toContain(`data-[size=default]:${inputHeight}`);
  });

  it("keeps the SMALL size exactly one step under the default, not level with it", () => {
    // The clause mirrors Input; it does not flatten the trigger's own two
    // sizes. 32px default, 28px small — the same step the button scale takes.
    const cls = triggerClasses("sm");
    expect(cls).toContain("data-[size=default]:h-8");
    expect(cls).toContain("data-[size=sm]:h-7");
  });
});
