// @vitest-environment jsdom
/**
 * THE PLACEHOLDER IS THE CARD'S NAME AND THE CENTRED ARC (cinatra#3046).
 *
 * The drawing at the contract's pin, cards §II, names the second half of it by
 * what it is NOT: "the card frame, and a spinning icon … It names no status,
 * reports no result and draws nothing to press."
 *
 * THE PROSE AND THE DRAWN EXAMPLE, RECONCILED. The same section's worked example
 * is markup, and it draws the card's own fixed name above a centred arc band.
 * An earlier reading of the prose took "names no status" as "no text at all" and
 * pinned an empty frame; the drawn example settles it, because what the prose
 * forbids is a STATUS word, a RESULT and a CONTROL, and the card's own name is
 * none of the three. This pin is re-taken against the drawn example.
 *
 * The shipped placeholder carried the `ReviewGateLoading` bar motif inside its
 * frame — five bars in the shape of a header and a body. It was carried as a
 * stated deviation on the first graded round ("the frame also draws SKELETON
 * BARS, which §II does not put there"), and a skeleton is a REPORT: it says the
 * review has arrived and is being painted, which is the claim about progress the
 * placeholder is defined by not making.
 *
 *   pnpm --filter @cinatra-ai/agents exec vitest run \
 *     src/__tests__/review-gate-placeholder-drawing.test.tsx
 */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => cleanup());

const PLACEHOLDER = '[data-conformance-id="review-gate-placeholder"]';

describe("ReviewGatePlaceholder", () => {
  it("draws the card name and a spinning icon, and reports nothing", async () => {
    const { ReviewGatePlaceholder } = await import("../review-gate-states");
    render(<ReviewGatePlaceholder />);
    const el = document.querySelector(PLACEHOLDER);
    expect(el).not.toBeNull();
    const root = el as HTMLElement;

    // THE SPINNING ICON — the design system's own, by its animation class.
    expect(root.querySelectorAll("svg.animate-spin").length).toBe(1);

    // THE CARD'S OWN NAME, the one the drawn example puts at its head. It is
    // fixed and identical on every run, so it reports nothing about this one.
    expect(root.textContent?.trim()).toBe("Agentic Run Progress");
    // ...and it is the card's name, NOT the run-progress arm's heading, which is
    // the h2 the panel draws over a status badge.
    expect(root.querySelectorAll("h1, h2, h3, h4, h5, h6").length).toBe(0);

    // IT REPORTS NO RESULT. The bar skeleton is a report and is gone.
    expect(root.querySelector('[data-conformance-id="review-gate-loading"]')).toBeNull();

    // IT NAMES NO STATUS: no badge, no pill, no status word beside the name.
    expect(root.querySelector('[data-conformance-id="review-gate-placeholder-frame"]')).toBeNull();
    expect(root.getAttribute("aria-busy")).toBe("true");

    // AND IT DRAWS NOTHING TO PRESS.
    expect(root.querySelectorAll("button, a, input, select, textarea").length).toBe(0);
    expect(root.querySelectorAll("[data-action]").length).toBe(0);
  });
});
