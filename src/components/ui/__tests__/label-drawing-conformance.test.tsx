// @vitest-environment jsdom
//
// Label — the graded checklist for the components drawing's
// "Form / Field / Label" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/label-drawing-conformance.test.tsx
//
// The clauses this primitive is answerable for, quoted verbatim:
//
//   "Label · 12px · 600"
//   "labels above inputs"
//
// NO DEPARTURE FOUND. The two remaining clauses of the section ("Helper · 11px
// · muted", "gap 4-8px", "error swaps helper red") are carried by Form and
// Field, and are graded in form-drawing-conformance.test.tsx and
// field-drawing-conformance.test.tsx respectively.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Label } from "@/components/ui/label";

afterEach(cleanup);

function renderLabel() {
  const { container } = render(<Label htmlFor="campaign">Campaign name</Label>);
  return container.querySelector('[data-slot="label"]') as HTMLElement;
}

describe('clause: "Label · 12px · 600"', () => {
  it("sets the label at the 12px step", () => {
    // `text-xs` is 0.75rem = 12px. The computed font-size is re-read on the
    // boot ("label type", primitive-wave-leg1.spec.ts).
    expect(renderLabel().className).toContain("text-xs");
  });

  it("sets the label at weight 600", () => {
    // `font-semibold` is the 600 step; `font-medium` (500) and `font-bold`
    // (700) are the two neighbours a refactor would most likely land on.
    const cls = renderLabel().className;
    expect(cls).toContain("font-semibold");
    expect(cls).not.toMatch(/(^|\s)font-(medium|bold)(\s|$)/);
  });
});

describe('clause: "labels above inputs"', () => {
  it("binds the label to its control so the pairing is real, not just visual", () => {
    // "Above" is a layout the CONTAINER owns (graded on Field / FormItem), but
    // the binding that makes the pairing meaningful is the label's own job.
    expect(renderLabel().getAttribute("for")).toBe("campaign");
  });

  // NOT APPLICABLE at this primitive, with the reason: the vertical ORDER of
  // label and input is set by the container that stacks them (FieldContent /
  // FormItem), never by the label. It is graded there.
  it.skip(
    "not applicable at this primitive: the label/input stacking order belongs to the container, graded on Field and Form",
    () => {},
  );
});

describe("the label carries its control's disabled state", () => {
  it("dims with the control rather than staying at full strength beside it", () => {
    // Not a sentence of the section, but the form the section's "labels above
    // inputs" pairing makes: a label that stays sharp beside a dimmed control
    // reads as still-actionable. Recorded here as the pairing's own assertion.
    const cls = renderLabel().className;
    expect(cls).toContain("peer-disabled:opacity-50");
    expect(cls).toContain("group-data-[disabled=true]:opacity-50");
  });
});
