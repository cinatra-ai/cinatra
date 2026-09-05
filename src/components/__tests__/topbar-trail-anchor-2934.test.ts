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

  it("nothing is drawn between the gutter and the trail, where the trail is drawn", () => {
    const row = topbarRow();
    const trail = row.indexOf("<Breadcrumb");
    expect(trail).toBeGreaterThan(-1);
    const ahead = row.slice(0, trail);
    // No separator, no spacer ahead of the trail.
    expect(ahead).not.toContain("<Separator");
    // The ONLY element permitted ahead of it is one that is not rendered at
    // the widths where the trail is: the trail is `hidden sm:flex`, so an
    // `sm:hidden` element cannot ever push it. Anything else would.
    for (const tag of ahead.match(/<[A-Z][A-Za-z]*[^>]*>/g) ?? []) {
      expect(tag).toContain("sm:hidden");
    }
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

/**
 * THE MOBILE LEFT EDGE, and THE ONE DECISION POINT (convergence of fix leg 8).
 *
 * Moving the sidebar toggle out of the trail's way is right where the trail is
 * drawn — but the trail is `hidden sm:flex`, so below `sm` there is no trail to
 * make room for. Sending the toggle to the right-hand cluster at THOSE widths
 * would empty the row's left edge and move the primary navigation control to
 * the opposite side of the bar, which the drawing never asks for. So the
 * toggle stays at the left exactly where the trail is not drawn, and leads the
 * right cluster exactly where it is.
 *
 * And the tab title: the shell must reach the guard through the one function
 * that applies it to BOTH inputs, never by preferring the published label
 * itself — a published label can be the short-id placeholder.
 */
describe("the left edge below sm, and the single title decision point", () => {
  it("keeps the sidebar toggle at the left only where the trail is not drawn", () => {
    const row = topbarRow();
    const trail = row.indexOf("<Breadcrumb");
    const ahead = row.slice(0, trail);
    // Below sm the toggle is the left element; at sm and up it is gone from
    // the left, so the trail alone sits at the gutter.
    expect(ahead).toContain("<SidebarTrigger");
    expect(/<SidebarTrigger[^>]*sm:hidden/.test(ahead)).toBe(true);
    // …and it must not be joined by a divider that would inset it further.
    expect(ahead).not.toContain("<Separator");
    // The trail itself is still the sm-and-up left element.
    expect(row).toContain('data-testid="app-shell-topbar-left"');
  });

  it("decides the agent-instance tab title through the single guarded helper", () => {
    expect(source).toContain("documentTitleLabelForAgentInstance");
    // The published label must never be preferred ahead of the guard.
    expect(source).not.toContain("agentLabel ?? documentTitleLabelFromTrail");
    expect(source).not.toContain("`${agentLabel} | Cinatra`");
  });
});
