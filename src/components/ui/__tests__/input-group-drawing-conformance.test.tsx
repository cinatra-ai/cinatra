// @vitest-environment jsdom
//
// InputGroup — the graded checklist for the components drawing's
// "Input / Textarea" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/input-group-drawing-conformance.test.tsx
//
// The clause that names this primitive, quoted verbatim:
//
//   "Use InputGroup for compound inputs with addons."
//
// and the chrome clauses it inherits by being the compound form of the same
// control:
//
//   "surface-strong"
//   "line-strong border"
//   "7px radius"
//   "focus = ring indigo"
//
// NO DEPARTURE FOUND. The drawing gives InputGroup no chrome of its own — it
// names it only as the compound form of Input — so the graded rule is that the
// group presents the SAME chrome the section states for the control, with the
// focus ring moved to the group (the addon and the control sit inside one
// bordered box, so a ring on the inner input would draw a box inside a box).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";

afterEach(cleanup);

function renderGroup() {
  const { container } = render(
    <InputGroup>
      <InputGroupAddon align="inline-start">
        <InputGroupText>https://</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput aria-label="Domain" />
    </InputGroup>,
  );
  return {
    group: container.querySelector('[data-slot="input-group"]') as HTMLElement,
    control: container.querySelector(
      '[data-slot="input-group-control"]',
    ) as HTMLElement,
    addon: container.querySelector(
      '[data-slot="input-group-addon"]',
    ) as HTMLElement,
  };
}

describe('clause: "surface-strong" / "line-strong border" / "7px radius"', () => {
  it("presents the section's chrome on the GROUP, so the compound control reads as one field", () => {
    const { group } = renderGroup();
    expect(group.className).toContain("bg-surface-strong");
    expect(group.className).toContain("border-input");
    expect(group.className).toContain("rounded-[7px]");
  });

  it("carries the same three chrome tokens the plain Input carries", () => {
    // The drawing states ONE chrome for the control; the compound form is not
    // licensed to invent a second.
    const { group } = renderGroup();
    const { container } = render(<Input aria-label="Plain" />);
    const plain = container.querySelector('[data-slot="input"]') as HTMLElement;
    for (const token of ["bg-surface-strong", "border-input", "rounded-[7px]"]) {
      expect(group.className, `group is missing ${token}`).toContain(token);
      expect(plain.className, `input is missing ${token}`).toContain(token);
    }
  });

  it("neutralises the inner control's chrome so the box is drawn exactly once", () => {
    // The inner control is the shared Input, so it still CARRIES the section's
    // chrome classes; what matters is the effective form. `border-0` zeroes the
    // border width (making the inherited `border-input` colour inert),
    // `rounded-none` drops the 7px corner, and `bg-transparent` lets the
    // group's own surface-strong ground show through. Grading the neutralisers
    // is grading the rendered box; grading the absence of `border-input` would
    // only pin how the neutralisation happens to be spelled.
    const { control } = renderGroup();
    expect(control.className).toContain("border-0");
    expect(control.className).toContain("rounded-none");
    expect(control.className).toContain("bg-transparent");
    expect(control.className).toContain("focus-visible:ring-0");
  });
});

describe('clause: "focus = ring indigo"', () => {
  it("raises the indigo ring on the GROUP when the inner control takes focus", () => {
    const { group } = renderGroup();
    expect(group.className).toContain(
      "has-[[data-slot=input-group-control]:focus-visible]:ring-ring/50",
    );
    expect(group.className).toContain(
      "has-[[data-slot=input-group-control]:focus-visible]:border-ring",
    );
  });

  it("moves the invalid stroke to the group as well, for the same reason", () => {
    const { group } = renderGroup();
    expect(group.className).toContain(
      "has-[[data-slot][aria-invalid=true]]:border-destructive",
    );
  });
});

describe('clause: "Use InputGroup for compound inputs with addons"', () => {
  it("places an inline-start addon before the control in the reading order", () => {
    const { group, addon, control } = renderGroup();
    expect(addon.getAttribute("data-align")).toBe("inline-start");
    const nodes = Array.from(group.querySelectorAll("[data-slot]"));
    expect(nodes.indexOf(addon)).toBeLessThan(nodes.indexOf(control));
  });

  it("keeps the addon non-interactive-looking — it is chrome, not a control", () => {
    const { addon } = renderGroup();
    expect(addon.className).toContain("text-muted-foreground");
    expect(addon.className).toContain("select-none");
  });
});
