// @vitest-environment jsdom
//
// Toggle — the graded checklist for the components drawing's
// "Toggle / Toggle group" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/toggle-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "on = indigo tint + ink"
//   "off = transparent + slate"
//   "7px radius"
//   "A two-state button. Pressed state is the indigo soft-tint with
//    ink/indigo content; rest is transparent with slate content."
//   "Use for view modes and inline formatting, not for settings that take
//    immediate effect (use Switch)."
//
// LEG 2 (this file's current state). Leg 1 recorded one departure here as a
// documented expected failure — the 7px corner. Leg 2 FIXES it in the primitive
// and retires the record: the assertion is unchanged, not relaxed, and now
// runs as a plain regression test that fails on leg 1's head. See the
// `FIXED IN LEG 2` block, which keeps leg 1's measured reading verbatim.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Toggle } from "@/components/ui/toggle";

afterEach(cleanup);

function renderToggle(pressed = false) {
  const { container } = render(
    <Toggle pressed={pressed} onPressedChange={() => {}} aria-label="Board">
      Board
    </Toggle>,
  );
  return container.querySelector('[data-slot="toggle"]') as HTMLElement;
}

describe('clause: "on = indigo tint + ink" / "the indigo soft-tint with ink/indigo content"', () => {
  it("grounds the pressed toggle in a soft indigo TINT, not a solid indigo fill", () => {
    // "Tint" is graded as an alpha: `bg-primary/10`. A solid `bg-primary`
    // would make the toggle read as a primary button.
    const el = renderToggle(true);
    expect(el.getAttribute("data-state")).toBe("on");
    expect(el.className).toContain("data-[state=on]:bg-primary/10");
    expect(el.className).not.toMatch(/data-\[state=on\]:bg-primary(\s|$)/);
  });

  it("sets the pressed content in the indigo", () => {
    expect(renderToggle(true).className).toContain("data-[state=on]:text-primary");
  });

  it("carries the same pair on aria-pressed, so a plain button call site matches", () => {
    const cls = renderToggle(true).className;
    expect(cls).toContain("aria-pressed:bg-primary/10");
    expect(cls).toContain("aria-pressed:text-primary");
  });
});

describe('clause: "off = transparent + slate" / "rest is transparent with slate content"', () => {
  it("leaves the resting toggle without a ground of its own", () => {
    const el = renderToggle(false);
    expect(el.getAttribute("data-state")).toBe("off");
    // The default variant sets no base background at all; the only ground it
    // ever gains is the hover tint and the pressed tint.
    expect(el.className).not.toMatch(/(^|\s)bg-(?!transparent)/);
  });

  it("FIXED IN LEG 2: gives the resting toggle the slate content the clause names", () => {
    // MEASURED BEFORE: the recipe stated the pressed colour
    // (`data-[state=on]:text-primary`) and the hover colour
    // (`hover:text-foreground`) and NOTHING for the resting state, so a
    // resting toggle simply inherited whatever colour its surroundings
    // happened to carry — ink inside a card, muted inside a toolbar. The
    // clause names one colour for that state in two places: the chrome line's
    // "off = transparent + slate" and the prose's "rest is transparent with
    // slate content". Slate is `--muted-foreground`, the token the section's
    // own example paints its resting segments with (`color: var(--muted)`).
    //
    // The resting colour is stated unprefixed, so the pressed and hover
    // colours — both carried on variants, and so at a higher specificity —
    // still win in their own states. Read live in both palettes by
    // tests/e2e/design/conformance/primitive-wave-leg2.spec.ts.
    const el = renderToggle(false);
    expect(el.className.split(/\s+/)).toContain("text-muted-foreground");
    expect(el.className).toContain("data-[state=on]:text-primary");
  });
});

describe('clause: "A two-state button"', () => {
  it("announces its two states to assistive tech", () => {
    expect(renderToggle(true).getAttribute("aria-pressed")).toBe("true");
    cleanup();
    expect(renderToggle(false).getAttribute("aria-pressed")).toBe("false");
  });

  it("is a button, not a checkbox", () => {
    expect(renderToggle().tagName.toLowerCase()).toBe("button");
  });
});

describe('clause: "not for settings that take immediate effect (use Switch)"', () => {
  // NOT APPLICABLE at this primitive, with the reason: this is a call-site
  // choice between two primitives, exactly as its mirror sentence in the
  // "Checkbox / Radio / Switch" section is. The toggle cannot police why it
  // was chosen.
  it.skip(
    "not applicable at this primitive: toggle-vs-switch is a call-site choice the primitive cannot police",
    () => {},
  );
});

describe('FIXED IN LEG 2: clause "7px radius"', () => {
  // DEPARTURE RETIRED IN LEG 2. Leg 1 recorded this clause as a documented
  // expected failure and spelled out, in the MEASURED and FOLLOW-UP notes
  // below, the exact value the fix had to reach. Leg 2 applies that fix in the
  // primitive itself, so the SAME assertion — unchanged, not relaxed — now runs
  // as a plain regression test: it fails on leg 1's head and passes here, and
  // that is what retires the record. Leg 1's own reading is kept verbatim below
  // so the checklist still says what was wrong and why the value is this one.
  it('FIXED IN LEG 2: draws the stated 7px corner — clause "7px radius"', () => {
    // LEG 1'S READING, KEPT VERBATIM — beyond the first ten rows of issue #3189's table,
    // so it is recorded here rather than fixed.
    //
    // MEASURED: the toggle draws `rounded-lg`, which resolves through
    // --radius-lg to --radius = 0.625rem = 10px — 3px above the value the
    // clause names. The section states 7px, and the same 7px appears in the
    // "Input / Textarea" section, where the primitive spells it exactly
    // (`rounded-[7px]`). So the drawing's 7px is a real, repeated value and
    // this is a genuine drift rather than a scale-step reading.
    //
    // FOLLOW-UP: leg 2 takes the toggle base to `rounded-[7px]`, and must take
    // ToggleGroup's segment corners with it — toggle-group.tsx re-rounds the
    // first and last segments (`first:rounded-l-lg`, `last:rounded-r-lg`) and
    // picks `rounded-lg` vs `rounded-[min(var(--radius-md),10px)]` by size, so
    // fixing only the base would leave a group whose ends disagree with its
    // middle. Graded together in toggle-group-drawing-conformance.test.tsx.
    expect(renderToggle().className).toContain("rounded-[7px]");
  });
});
