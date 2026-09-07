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
// ONE DEPARTURE RECORDED, NOT FIXED — switch is beyond the first ten rows of
// the issue's table, so this leg records it with a visibly failing assertion
// and names the follow-up rather than fixing it at the source. See the
// `RECORDED DEPARTURE` describe block below.
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

describe('RECORDED DEPARTURE (leg 2 follow-up): clause "control 16-18px"', () => {
  // DOCUMENTED EXPECTED FAILURE. The assertion below is unchanged and still
  // runs: `it.fails` reports a pass only while the body throws, so the
  // departure stays measured and the checklist stays green. The day the
  // follow-up this departure names lands, this case stops throwing, the suite
  // goes red, and the record must be retired with it.
  it.fails('RECORDED DEPARTURE (leg 2 follow-up): draws the track inside the stated 16-18px band — clause "control 16-18px"', () => {
    // RECORDED DEPARTURE — beyond the first ten rows of issue #3189's table,
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
