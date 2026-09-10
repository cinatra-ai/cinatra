// @vitest-environment jsdom
//
// Textarea — the graded checklist for the components drawing's
// "Input / Textarea" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/textarea-drawing-conformance.test.tsx
//
// The section governs Input and Textarea together; its clauses, quoted verbatim:
//
//   "surface-strong"
//   "line-strong border"
//   "7px radius"
//   "focus = ring indigo"
//   "Always pure white background. Border is the strong navy hairline. Focus
//    ring picks up --ring (indigo)."
//
// NO DEPARTURE FOUND. The section states one chrome for both controls, so this
// file grades the SAME four clauses at the textarea seam and additionally pins
// that the two controls do not drift apart — a chrome stated once and
// implemented twice is exactly where a silent divergence appears.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

afterEach(cleanup);

function renderTextarea(props: React.ComponentProps<"textarea"> = {}) {
  const { container } = render(<Textarea aria-label="Notes" {...props} />);
  return container.querySelector('[data-slot="textarea"]') as HTMLElement;
}

function renderInputEl() {
  const { container } = render(<Input aria-label="Name" />);
  return container.querySelector('[data-slot="input"]') as HTMLElement;
}

describe('clause: "surface-strong" / "Always pure white background"', () => {
  it("paints the textarea on the strong surface", () => {
    expect(renderTextarea().className).toContain("bg-surface-strong");
  });
});

describe('clause: "line-strong border" / "the strong navy hairline"', () => {
  it("draws the border from the control hairline token", () => {
    expect(renderTextarea().className).toContain("border-input");
  });
});

describe('clause: "7px radius"', () => {
  it("draws the stated 7px corner", () => {
    expect(renderTextarea().className).toContain("rounded-[7px]");
  });
});

describe('clause: "focus = ring indigo"', () => {
  it("raises the indigo ring token on focus and suppresses the native outline", () => {
    const el = renderTextarea();
    expect(el.className).toContain("focus-visible:ring-ring/50");
    expect(el.className).toContain("outline-none");
  });
});

describe('the section states ONE chrome for both controls', () => {
  it("keeps the textarea's ground, hairline, radius and ring identical to the input's", () => {
    // The drawing draws Input and Textarea in a single section under a single
    // chrome line. Grading them independently would let one drift while both
    // still passed their own file, so the parity itself is a graded item.
    const ta = renderTextarea().className;
    const input = renderInputEl().className;
    for (const token of [
      "bg-surface-strong",
      "border-input",
      "rounded-[7px]",
      "focus-visible:ring-ring/50",
      "focus-visible:border-ring",
      "aria-invalid:border-destructive",
    ]) {
      expect(ta, `textarea is missing ${token}`).toContain(token);
      expect(input, `input is missing ${token}`).toContain(token);
    }
  });
});
