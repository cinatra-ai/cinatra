// @vitest-environment jsdom
//
// Switch — the graded checklist for the components drawing's
// "Checkbox / Radio / Switch" section (cinatra#3189, shared-primitives wave,
// leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/switch-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "control 16-18px"
//   "indigo when on"
//   "surface-muted when off"
//   "Single-select (radio), multi-select (checkbox), and instant-binary
//    (switch). Indigo for active state. Switches are reserved for
//    immediate-effect settings; checkboxes for confirmable form choices."
//
// LEG 2 (this file's current state). Leg 1 recorded one departure here as a
// documented expected failure — the 16-18px control band. Leg 2 FIXES it in the primitive
// and retires the record: the assertion is unchanged, not relaxed, and now
// runs as a plain regression test that fails on leg 1's head. See the
// `FIXED IN LEG 2` block, which keeps leg 1's measured reading verbatim.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Switch } from "@/components/ui/switch";

afterEach(cleanup);

function renderSwitch(checked = false) {
  const { container } = render(
    <Switch checked={checked} onCheckedChange={() => {}} aria-label="Live" />,
  );
  return {
    root: container.querySelector('[data-slot="switch"]') as HTMLElement,
    thumb: container.querySelector('[data-slot="switch-thumb"]') as HTMLElement,
  };
}

describe('clause: "indigo when on" / "Indigo for active state"', () => {
  it("fills the track with the primary indigo when the switch is on", () => {
    const { root } = renderSwitch(true);
    expect(root.getAttribute("data-state")).toBe("checked");
    expect(root.className).toContain("data-[state=checked]:bg-primary");
  });
});

describe('clause: "surface-muted when off"', () => {
  it("drops the track to the muted surface when the switch is off", () => {
    const { root } = renderSwitch(false);
    expect(root.getAttribute("data-state")).toBe("unchecked");
    expect(root.className).toContain("data-[state=unchecked]:bg-surface-muted");
  });
});

describe('clause: "instant-binary (switch)" / "reserved for immediate-effect settings"', () => {
  it("exposes the control as a switch to assistive tech, not a checkbox", () => {
    // "Instant-binary" is a semantic the role carries: a switch announces
    // on/off and takes effect immediately; a checkbox announces checked and
    // waits for a submit.
    const { root } = renderSwitch(true);
    expect(root.getAttribute("role")).toBe("switch");
    expect(root.getAttribute("aria-checked")).toBe("true");
  });

  // NOT APPLICABLE at this primitive, with the reason: "reserved for
  // immediate-effect settings; checkboxes for confirmable form choices" is a
  // rule for the CALL SITE choosing between two primitives. The switch cannot
  // assert that its caller chose it for the right reason.
  it.skip(
    "not applicable at this primitive: switch-vs-checkbox is a call-site choice the primitive cannot police",
    () => {},
  );
});

describe('FIXED IN LEG 2: clause "control 16-18px"', () => {
  // DEPARTURE RETIRED IN LEG 2. Leg 1 recorded this clause as a documented
  // expected failure and spelled out, in the MEASURED and FOLLOW-UP notes
  // below, the exact value the fix had to reach. Leg 2 applies that fix in the
  // primitive itself, so the SAME assertion — unchanged, not relaxed — now runs
  // as a plain regression test: it fails on leg 1's head and passes here, and
  // that is what retires the record. Leg 1's own reading is kept verbatim below
  // so the checklist still says what was wrong and why the value is this one.
  it('FIXED IN LEG 2: draws the track inside the stated 16-18px band — clause "control 16-18px"', () => {
    // LEG 1'S READING, KEPT VERBATIM — beyond the first ten rows of issue #3189's table,
    // so it is recorded here rather than fixed.
    //
    // MEASURED: the track is `h-[1.15rem]` = 18.4px, which is 0.4px above the
    // band's 18px ceiling. The thumb inside it is `size-4` = 16px, at the
    // band's floor, and the two sibling controls the same clause governs
    // (checkbox, radio) both draw `size-4` = 16px and sit inside the band.
    //
    // FOLLOW-UP: leg 2 takes the switch track to `h-[1.125rem]` (18px, the
    // band's ceiling) or to `h-4` (16px, matching its siblings), and re-reads
    // the thumb travel — `data-[state=checked]:translate-x-[calc(100%-2px)]`
    // is expressed against the track, so the offset moves with it. Severity is
    // low: 0.4px is not visible, but the clause names a band and the value
    // sits outside it, so it is recorded rather than waved through.
    const { root } = renderSwitch();
    expect(root.className).toMatch(/(^|\s)h-(4|\[1\.125rem\])(\s|$)/);
  });

  it("keeps the thumb at the band's floor", () => {
    // Passes today and is the pin that keeps the fix above from being taken by
    // shrinking the thumb instead of the track.
    const { thumb } = renderSwitch();
    expect(thumb.className).toContain("size-4");
  });
});
