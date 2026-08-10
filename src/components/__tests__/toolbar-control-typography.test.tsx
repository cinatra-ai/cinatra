/**
 * Toolbar controls declare their own line-height, and it is `normal`
 * (design-system §Toolbar; owner review on cinatra#2474 PR5, PR #2638).
 *
 * WHY THIS IS PINNED. The spec's §Toolbar example sets every control's type
 * with the `font` SHORTHAND — `font:500 12.5px var(--font-sans)` — and the
 * shorthand resets `line-height` to `normal`. The primitive reproduced only the
 * font-SIZE (`text-[12.5px]`), so Tailwind preflight's `html { line-height:
 * 1.5 }` cascaded in and every toolbar control computed `line-height: 18.75px`.
 *
 * That is not cosmetic. With a NUMERIC line-height Chromium seats the label's
 * text box asymmetrically inside the control, while an icon — an ordinary 14px
 * flex item — is centred exactly. Measured on the real dashboard toolbar at
 * 1600x1000@2x, identically on all nine controls in both modes AND on
 * /notifications (a surface this PR never touches):
 *
 *   label text box vs control centre   -0.875px  ->  0.000px
 *   label cap band vs toolbar midline  -0.922px  ->  -0.047px
 *   icon ink vs label cap band         +0.922px  ->  +0.047px
 *
 * i.e. every icon read ~0.9px low against its own label, and the labels read
 * ~0.9px high against the toolbar's top and bottom — exactly what the owner
 * reported. A revert re-introduces it silently: nothing else in the tree
 * observes this class, so a class pin is the cheapest true guard, and the
 * rendered numbers above are what it stands in for.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Toolbar,
  ToolbarButton,
  ToolbarChild,
  ToolbarSearchGroup,
  ToolbarSearchInput,
} from "../ui/toolbar";

/** Tailwind's arbitrary-value utility for `line-height: normal`. */
const LEADING_NORMAL = "leading-[normal]";

describe("toolbar control typography", () => {
  it("gives every primary-bar button the spec's `line-height: normal`", () => {
    const html = renderToStaticMarkup(
      <Toolbar aria-label="Bar">
        <ToolbarButton>Add text</ToolbarButton>
        <ToolbarButton active>Grid</ToolbarButton>
        <ToolbarButton disabled>Delete</ToolbarButton>
      </Toolbar>,
    );
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button).toContain(LEADING_NORMAL);
  });

  it("carries it into child toolbars, where the control shrinks to 30px", () => {
    const html = renderToStaticMarkup(
      <ToolbarChild level={2} aria-label="Sub controls">
        <ToolbarButton>Rename</ToolbarButton>
      </ToolbarChild>,
    );
    expect(html).toContain(LEADING_NORMAL);
    // The level context still owns the height; the two are independent.
    expect(html).toContain("h-[30px]");
  });

  it("carries it through the asChild path onto the rendered child", () => {
    // asChild does not render a <button>: it CLONES the child and merges the
    // control classes onto it. That is the path the toolbar's page actions take
    // (`<ToolbarButton asChild><Link/></ToolbarButton>`), so a regression here
    // would leave those links mis-set while every plain button looked right.
    // The child's element type is irrelevant to the merge, so this uses a
    // <span> rather than a raw <a> — the repo's design-system gate reserves
    // anchors for the shadcn Link pattern, and the assertion does not need one.
    const html = renderToStaticMarkup(
      <ToolbarButton asChild>
        <span data-probe="child">Run agent</span>
      </ToolbarButton>,
    );
    expect(html).not.toContain("<button");
    expect(html).toMatch(/<span[^>]*class="[^"]*leading-\[normal\]/);
  });

  it("gives the search pill the same declaration, which its input inherits", () => {
    // Preflight sets `font: inherit` on <input>, so declaring the line-height
    // on the pill is what reaches the value and the placeholder.
    const html = renderToStaticMarkup(
      <Toolbar aria-label="Bar">
        <ToolbarSearchGroup>
          <ToolbarSearchInput placeholder="Search by name…" />
        </ToolbarSearchGroup>
      </Toolbar>,
    );
    expect(html).toMatch(/<label[^>]*class="[^"]*leading-\[normal\]/);
  });

  it("does not put a numeric leading utility anywhere on a control", () => {
    // `leading-none` / `leading-normal` (Tailwind's 1.5) would both reopen the
    // defect — only the arbitrary `normal` keyword produces a symmetric box.
    const html = renderToStaticMarkup(
      <Toolbar aria-label="Bar">
        <ToolbarButton>Add portlet</ToolbarButton>
        <ToolbarSearchGroup>
          <ToolbarSearchInput placeholder="Search…" />
        </ToolbarSearchGroup>
      </Toolbar>,
    );
    expect(html).not.toMatch(/\bleading-(none|tight|snug|normal|relaxed|loose|\d)/);
  });
});
