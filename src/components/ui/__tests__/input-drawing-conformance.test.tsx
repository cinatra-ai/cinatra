// @vitest-environment jsdom
//
// Input — the graded checklist for the components drawing's "Input / Textarea"
// section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/input-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "surface-strong"
//   "line-strong border"
//   "7px radius"
//   "focus = ring indigo"
//   "Always pure white background. Border is the strong navy hairline. Focus
//    ring picks up --ring (indigo). Use InputGroup for compound inputs with
//    addons."
//
// NO DEPARTURE FOUND. Every clause of the section is met by the primitive as
// it stands, and this file is the record of that grading. The three clauses
// that name a rendered VALUE (the ground, the hairline, the focus ring) are
// re-read as computed styles on the live boot in both palettes by
// tests/e2e/design/conformance/primitive-wave-leg1.spec.ts — a token-carried
// value cannot be graded outside the palette the surface renders in. What this
// file pins is the RECIPE that produces those values.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Input } from "@/components/ui/input";

afterEach(cleanup);

function renderInput(props: React.ComponentProps<"input"> = {}) {
  const { container } = render(<Input aria-label="Campaign name" {...props} />);
  return container.querySelector('[data-slot="input"]') as HTMLElement;
}

describe('clause: "surface-strong" / "Always pure white background"', () => {
  it("paints the field on the strong surface, never on the page paper", () => {
    // --surface-strong is #ffffff in both light themes; the clause's "pure
    // white" is that token, not a literal hex at the call site.
    const el = renderInput();
    expect(el.className).toContain("bg-surface-strong");
    expect(el.className).not.toMatch(/(^|\s)bg-background(\s|$)/);
  });

  it("keeps the disabled field off the interactive white", () => {
    // design-system rule 8 — "White means interactive". A disabled field must
    // not keep the white ground that advertises interactivity.
    const el = renderInput({ disabled: true });
    expect(el.className).toContain("disabled:bg-input-fill/50");
  });
});

describe('clause: "line-strong border" / "Border is the strong navy hairline"', () => {
  it("draws the border from the control hairline token, not the row hairline", () => {
    // --input resolves through --line-control to --line-strong (#15213a), the
    // solid navy; --border resolves to --line, the 14%-alpha row hairline.
    // The clause names the STRONG one.
    const el = renderInput();
    expect(el.className).toContain("border-input");
    expect(el.className).not.toMatch(/(^|\s)border-border(\s|$)/);
  });

  it("swaps the hairline to the destructive stroke when the field is invalid", () => {
    const el = renderInput({ "aria-invalid": true } as React.ComponentProps<"input">);
    expect(el.getAttribute("aria-invalid")).toBe("true");
    expect(el.className).toContain("aria-invalid:border-destructive");
  });
});

describe('clause: "7px radius"', () => {
  it("draws the stated 7px corner, not a scale step that happens to be near it", () => {
    // The clause names an exact pixel value, so the primitive carries it as an
    // arbitrary value rather than rounding onto --radius (10px).
    const el = renderInput();
    expect(el.className).toContain("rounded-[7px]");
  });
});

describe('clause: "focus = ring indigo" / "Focus ring picks up --ring (indigo)"', () => {
  it("raises the indigo ring token on focus, never a browser outline", () => {
    const el = renderInput();
    expect(el.className).toContain("focus-visible:ring-ring/50");
    expect(el.className).toContain("focus-visible:border-ring");
    // The native outline is suppressed so the ring is the only focus mark.
    expect(el.className).toContain("outline-none");
  });

  it("shows the invalid field a destructive ring instead of the indigo one", () => {
    const el = renderInput({ "aria-invalid": true } as React.ComponentProps<"input">);
    expect(el.className).toContain("aria-invalid:ring-destructive/20");
  });
});

describe('clause: "Use InputGroup for compound inputs with addons"', () => {
  // NOT APPLICABLE at this primitive, with the reason: the sentence directs the
  // CALLER to a sibling component; it states no rule the Input itself can carry.
  // The chrome parity it implies is graded on InputGroup, in
  // input-group-drawing-conformance.test.tsx.
  it.skip(
    "not applicable at this primitive: the sentence directs the caller to InputGroup; the chrome parity it implies is graded on InputGroup",
    () => {},
  );
});
