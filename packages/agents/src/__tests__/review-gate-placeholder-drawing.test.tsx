// @vitest-environment jsdom
/**
 * THE PLACEHOLDER IS THE FRAME AND THE SPINNER, AND NOTHING ELSE (cinatra#3046).
 *
 * The drawing at the contract's pin, cards §II, names the second half of it by
 * what it is NOT: "the card frame, and a spinning icon … It names no status,
 * reports no result and draws nothing to press."
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
  it("draws a spinning icon, an empty frame, and reports nothing", async () => {
    const { ReviewGatePlaceholder } = await import("../review-gate-states");
    render(<ReviewGatePlaceholder />);
    const el = document.querySelector(PLACEHOLDER);
    expect(el).not.toBeNull();
    const root = el as HTMLElement;

    // THE SPINNING ICON — the design system's own, by its animation class.
    expect(root.querySelectorAll("svg.animate-spin").length).toBe(1);

    // THE CARD FRAME — the box the review screen will fill, empty.
    const frame = root.querySelector('[data-conformance-id="review-gate-placeholder-frame"]');
    expect(frame).not.toBeNull();
    expect((frame as HTMLElement).textContent).toBe("");

    // IT REPORTS NO RESULT. The bar skeleton is a report and is gone.
    expect(root.querySelector('[data-conformance-id="review-gate-loading"]')).toBeNull();

    // IT NAMES NO STATUS. The only words in the whole region are the accessible
    // name of a deliberately wordless busy region, which is not drawn copy.
    expect(root.textContent?.trim()).toBe("");
    expect(root.getAttribute("aria-busy")).toBe("true");

    // AND IT DRAWS NOTHING TO PRESS.
    expect(root.querySelectorAll("button, a, input, select, textarea").length).toBe(0);
    expect(root.querySelectorAll("[data-action]").length).toBe(0);
  });
});
