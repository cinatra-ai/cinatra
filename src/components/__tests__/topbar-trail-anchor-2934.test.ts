/**
 * THE TRAIL SITS WHERE THE DRAWING PUTS IT (cinatra#2934, the SEVENTH graded
 * proof set).
 *
 * The previous leg made the words of the trail honest on a refused reading.
 * The seventh capture measured the trail's own box on pixels and found it in
 * the wrong PLACE: 92 CSS px inside the sidebar's inner edge, on the schedule
 * refusal, the run-page refusal and the not-found reading alike, in both
 * themes. The ratified drawing is explicit about that edge. It says the
 * top-bar's control row spans the full available width - the viewport minus
 * the persistent sidebar, the sidebar's inner edge being the left bound when
 * it is shown - carrying ONLY the standard edge gutters (px-5, then sm:px-8).
 * And it names the element that must sit there: "The breadcrumb is the
 * top-bar's left element and moves with the bar - it anchors at that far-left
 * edge; it does not ride the content stage."
 *
 * The built row put the sidebar toggle and its divider ahead of the trail, so
 * the trail began one toggle, one divider and two gaps inside the gutter - the
 * measured 92 rather than the drawn 32. That is not a property of the refusal;
 * the refusal renders inside the ordinary shell and the offending chrome is
 * the shell's. The refused readings are simply where it was finally measured.
 *
 * WHY THIS IS ASSERTED ON THE SOURCE. The offset is a layout fact, and jsdom
 * has no layout to measure - a render-based assertion here would prove nothing
 * that the picture does not already prove better. What CAN be pinned
 * mechanically, and is what actually regressed, is the ORDER: whether anything
 * at all is drawn between the row's gutter and the trail. The pixels are
 * measured in the capture; this keeps the arrangement from drifting back.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SHELL = path.join(process.cwd(), "src/components/app-shell.tsx");
const source = readFileSync(SHELL, "utf8");

/** The top-bar control row, from its own test id to the right-hand cluster. */
function topbarRow(): string {
  const start = source.indexOf('data-testid="app-shell-topbar-row"');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('data-testid="app-shell-topbar-right"', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("the top-bar's left element is the trail, at the standard gutter", () => {
  it("the row carries only the standard edge gutters the drawing names", () => {
    const row = topbarRow();
    const className = /className="([^"]*)"/.exec(row)?.[1] ?? "";
    expect(className).toContain("px-5");
    expect(className).toContain("sm:px-8");
    // Nothing may widen the left inset beyond that gutter.
    expect(className).not.toMatch(/\b(pl-|ml-|sm:pl-|sm:ml-)/);
  });

  it("nothing is drawn between the gutter and the trail", () => {
    const row = topbarRow();
    const trail = row.indexOf("<Breadcrumb");
    const toggle = row.indexOf("<SidebarTrigger");
    expect(trail).toBeGreaterThan(-1);
    // The toggle is no longer the row's left element; if it is drawn in the
    // row at all it comes after the trail, never before it.
    if (toggle > -1) expect(toggle).toBeGreaterThan(trail);
    // No separator, no spacer, no other element ahead of the trail either.
    const ahead = row.slice(0, trail);
    expect(ahead).not.toContain("<Separator");
    expect(/<[A-Z]/.test(ahead)).toBe(false);
  });

  it("the trail is the element the shell names as the top-bar's left one", () => {
    const row = topbarRow();
    const trail = row.indexOf("<Breadcrumb");
    const left = row.indexOf('data-testid="app-shell-topbar-left"');
    expect(left).toBeGreaterThan(trail);
    // …and it belongs to the trail's own tag, not to something before it.
    expect(row.slice(trail, left)).not.toContain(">");
  });
});
