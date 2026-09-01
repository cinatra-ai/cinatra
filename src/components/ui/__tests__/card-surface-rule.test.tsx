// @vitest-environment jsdom
//
// Card vs its own section in the components drawing (cinatra#3189, audit leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/card-surface-rule.test.tsx
//
// Three clauses of that section had no expression in the primitive:
//
//   1. "Clickable cards (agent tiles, run rows, popovers, anything with hover
//      or focus) use --surface-strong per rule #8" — the primitive had no
//      interactive form at all, so every card drew the warm-cream ground and
//      the surfaces that wanted the white one hand-rolled their own div;
//   2. "1px line border" — the primitive drew a 1px box-shadow RING at
//      foreground/10, so its computed border-width was 0 and consumers that
//      passed a `border-*` colour got no stroke at all;
//
// Its "10-12px radius" clause was graded too and PASSES unchanged: under the
// palette the app actually runs, the card's corner computes to 12px, the top of
// the band. The assertion below is therefore a guard, not a fix — it pins that
// the card and the parts that round with it keep ONE corner token, so a change
// to the card's corner cannot leave its header, footer or images behind. The
// band itself is measured in the browser, where a token can be read.
//
// jsdom applies no stylesheet, so this asserts the class contract each clause
// produces; the computed background, border width and corner radius are
// measured in the real browser by
// tests/e2e/design/conformance/primitive-chrome.spec.ts.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

afterEach(cleanup);

function renderCard(props: Record<string, unknown> = {}) {
  const { container } = render(
    <Card {...props}>
      <CardHeader>
        <CardTitle>Marketing strategy</CardTitle>
      </CardHeader>
      <CardContent>Twelve drafts pending your read.</CardContent>
      <CardFooter>Footer</CardFooter>
    </Card>,
  );
  const el = container.querySelector('[data-slot="card"]');
  if (!el) throw new Error("Card rendered no [data-slot=card]");
  return { el, container };
}

describe("Card — components drawing, Card section", () => {
  it("draws a non-interactive card on the warm-cream surface", () => {
    const { el } = renderCard();
    expect(el.className).toContain("bg-card");
    expect(el.className).not.toContain("bg-surface-strong");
    expect(el.getAttribute("data-interactive")).toBeNull();
  });

  it("draws a clickable card on pure-white surface-strong, per rule #8", () => {
    const { el } = renderCard({ interactive: true });
    expect(el.getAttribute("data-interactive")).toBe("true");
    expect(el.className).toContain("bg-surface-strong");
  });

  it("lifts a clickable card 1px on hover, and never lifts a plain one", () => {
    const { el } = renderCard({ interactive: true });
    expect(el.className).toContain("hover:-translate-y-px");
    cleanup();
    expect(renderCard().el.className).not.toContain("hover:-translate-y-px");
  });

  it("closes the card with a 1px line border, not a ring", () => {
    const { el } = renderCard();
    const classes = Array.from(el.classList);
    expect(classes).toContain("border");
    expect(classes).toContain("border-border");
    expect(
      classes.filter((c) => c.startsWith("ring")),
      "a box-shadow ring computes border-width 0 — the drawing asks for a border",
    ).toEqual([]);
  });

  it("rounds the card and every part that rounds with it on one corner token", () => {
    const { el, container } = renderCard();
    const corner = Array.from(el.classList).find((c) => /^rounded-/.test(c));
    expect(corner, "the card must carry exactly one corner token").toBeDefined();
    const step = corner!.replace(/^rounded-/, "");
    for (const slot of ["card-header", "card-footer"]) {
      const part = container.querySelector(`[data-slot="${slot}"]`);
      const parts = Array.from(part?.classList ?? []).filter((c) =>
        /^rounded-[tb]-/.test(c),
      );
      for (const p of parts) {
        expect(
          p.replace(/^rounded-[tb]-/, ""),
          `${slot} rounds on ${p} while the card rounds on ${corner}`,
        ).toBe(step);
      }
    }
  });
});
