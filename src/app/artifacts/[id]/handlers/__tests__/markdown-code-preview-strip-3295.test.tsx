// @vitest-environment jsdom
/**
 * THE MARKDOWN DISPLAY CARRIES THE DRAWN CODE / PREVIEW STRIP (cinatra#3007,
 * fix leg 17; cinatra#3295).
 *
 * The thirteenth graded reading measured the resolved review display in both
 * palettes and found no Code / Preview strip on it. The ratified drawing gives
 * the markdown display exactly that: "A kind written as text is drawn through
 * the markdown display on its Code and Preview tabs", over ONE panel — the
 * drawn strip is a `role="tablist"` of two tabs, Code and Preview, with Preview
 * selected, above a single body region. And the display's chrome TRAVELS: "the
 * same display is drawn, unchanged, wherever the artifact is read — the artifact
 * page here, the review step on the run page and the review card in a
 * conversation", so fixing it in the display fixes it on the settled card too.
 *
 * What stood here instead was two panels side by side, headed "Rendered" and
 * "Raw source" — two readings of the work at once, and neither a tab.
 *
 * THE DISPLAY IS THE HOST'S OWN. The markdown reading is the FORM-RENDERING
 * RUNG (`ReviewTargetMount`'s `form` arm), so this is host chrome and no
 * extension is touched by it — the core/extension border is not crossed here in
 * either direction.
 *
 *   pnpm exec vitest run \
 *     'src/app/artifacts/[id]/handlers/__tests__/markdown-code-preview-strip-3295.test.tsx'
 */
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { MarkdownCodePreview } from "../markdown-code-preview";

afterEach(() => cleanup());

const HTML = "<p>Teams pick a stack in an afternoon.</p>";
const RAW = "Teams pick a stack in an afternoon.";

function display(): HTMLElement {
  const { container } = render(<MarkdownCodePreview html={HTML} raw={RAW} />);
  const node = container.querySelector<HTMLElement>(
    '[data-conformance-id="markdown-display"]',
  );
  if (node === null) throw new Error("no markdown display was drawn");
  return node;
}

describe("the markdown display", () => {
  it("draws the drawn Code / Preview strip, with Preview the active reading", () => {
    const node = display();
    const strip = node.querySelector('[data-conformance-id="markdown-display-tabs"]');
    expect(strip, "the display draws no Code / Preview strip").not.toBeNull();
    const tabs = [...node.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => (t.textContent ?? "").trim())).toEqual(["Code", "Preview"]);
    const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect((selected[0]?.textContent ?? "").trim()).toBe("Preview");
  });

  it("shows ONE reading at a time, and the strip switches which one", () => {
    // MEASURED AS SHOWN, NOT AS MOUNTED. The drawing's rule is "Only the active
    // tab's view is shown ... They are never drawn side by side" — a rule about
    // what a reader SEES. The design system's tab strip keeps the inactive panel
    // mounted and `hidden` so a reading survives a switch, which is invisible to
    // a reader and is exactly the behaviour the drawing's "one press away" wants.
    // Counting mounted panels would therefore fail a conforming strip and pass a
    // hand-rolled one, so this counts the SHOWN panels instead.
    const shown = (node: HTMLElement) =>
      [...node.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter(
        (p) => !p.hasAttribute("hidden"),
      );

    const node = display();
    expect(shown(node), "the display shows more than one reading at once").toHaveLength(
      1,
    );
    expect(shown(node)[0]?.textContent ?? "").toContain(RAW);
    expect(shown(node)[0]?.querySelector("pre"), "Preview shows the source").toBeNull();

    const code = [...node.querySelectorAll('[role="tab"]')].find(
      (t) => (t.textContent ?? "").trim() === "Code",
    );
    expect(code).toBeDefined();
    // The design system's tab strip selects on POINTER-DOWN (its Radix
    // trigger), not on a synthesised click alone, so press it as a reader does.
    fireEvent.mouseDown(code as Element);
    fireEvent.click(code as Element);
    expect(shown(node), "the display shows more than one reading at once").toHaveLength(
      1,
    );
    expect(shown(node)[0]?.querySelector("pre"), "Code draws no source reading").not.toBeNull();
  });

  it("draws neither of the two headed panels it replaced", () => {
    const node = display();
    expect(node.textContent ?? "").not.toMatch(/Raw source/i);
    expect(node.textContent ?? "").not.toMatch(/(?:^|\W)Rendered(?:\W|$)/);
  });
});
