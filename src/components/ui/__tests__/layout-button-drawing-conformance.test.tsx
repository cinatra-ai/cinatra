// @vitest-environment jsdom
//
// LayoutButton — the graded checklist against the components drawing
// (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/layout-button-drawing-conformance.test.tsx
//
// THE DRAWING IS SILENT ON THIS PRIMITIVE, and this file is the record of that
// finding rather than a graded checklist.
//
// The "Button" section states "7 variants · 5 sizes · cva ... Primary, default,
// outline, secondary, destructive, ghost, link. Sizes: default, xs, sm, lg,
// icon (xs/sm/lg). Indigo primary, ink default border, destructive uses
// red-on-tint not solid red." Every one of those clauses is about the STYLED
// control, and every one is graded on `button.tsx`.
//
// LayoutButton is deliberately the opposite: a bare `<button>` that carries no
// control styling at all, so a free-form multi-line block (a notification row
// that is itself the click target) can be made keyboard- and screen-reader-
// operable without its typography being rewritten by `buttonVariants`. The
// drawing names no such component, and it should not: it is an accessibility
// carve-out, not a piece of chrome.
//
// What IS graded here is that the carve-out stays a carve-out.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { LayoutButton } from "@/components/ui/layout-button";

afterEach(cleanup);

function renderLayoutButton(props: React.ComponentProps<"button"> = {}) {
  const { container } = render(
    <LayoutButton {...props}>
      <span>Run #2,318 finished</span>
      <time>14:21</time>
    </LayoutButton>,
  );
  return container.querySelector('[data-slot="layout-button"]') as HTMLButtonElement;
}

describe("the drawing states no clause for this primitive", () => {
  // NOT APPLICABLE, with the reason: the Button section's clauses (7 variants,
  // 5 sizes, indigo primary, red-on-tint destructive) describe the styled
  // control and are graded on button.tsx. LayoutButton exists precisely to NOT
  // carry them.
  it.skip(
    "not applicable: the Button section's variant, size and colour clauses describe the styled control and are graded on button.tsx",
    () => {},
  );

  it("carries no control styling, which is the whole reason it is a separate primitive", () => {
    // The graded form of "the drawing is silent": if this ever acquired a
    // height, a font weight or a focus ring, it would become an ungoverned
    // second button chrome sitting beside the drawn one.
    expect(renderLayoutButton().className).toBe("");
  });

  it("passes the call site's classes through untouched", () => {
    expect(renderLayoutButton({ className: "w-full text-left" }).className).toBe(
      "w-full text-left",
    );
  });
});

describe("it is a real button, which is the reason it exists", () => {
  it("renders a button element so the block is focusable and operable by keyboard", () => {
    expect(renderLayoutButton().tagName.toLowerCase()).toBe("button");
  });

  it('defaults to type="button" so it cannot submit a surrounding form by accident', () => {
    expect(renderLayoutButton().type).toBe("button");
  });

  it("lets the call site override the type where a submit really is wanted", () => {
    expect(renderLayoutButton({ type: "submit" }).type).toBe("submit");
  });

  it("keeps its children's own typography rather than flattening it", () => {
    // This is the defect the primitive was extracted to avoid: routing these
    // rows through the styled Button rewrote body and timestamp weight.
    const el = renderLayoutButton();
    expect(el.querySelector("time")).not.toBeNull();
    expect(el.className).not.toContain("font-medium");
  });
});
