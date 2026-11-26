/**
 * THE SIDEBAR TOGGLE STANDS IN FRONT OF THE BREADCRUMB (owner's decision of
 * 2026-11-26, superseding the cinatra#2934 reading).
 *
 * #2934 moved the toggle and its divider to the right-hand cluster so the
 * trail began at the drawing's 32px gutter. The owner has decided otherwise:
 * the toggle leads the top bar, in front of the breadcrumb, as it was before,
 * and there is NO divider between them. The row still carries only the
 * standard edge gutters (px-5, then sm:px-8).
 *
 * WHY THIS IS ASSERTED ON THE SOURCE. The offset is a layout fact, and jsdom
 * has no layout to measure. What CAN be pinned mechanically is the ORDER:
 * the one toggle first, the trail directly after it, no divider, and the
 * right-hand cluster holding neither.
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

describe("the top bar leads with the toggle, then the trail", () => {
  it("the row carries only the standard edge gutters the drawing names", () => {
    const row = topbarRow();
    const className = /className="([^"]*)"/.exec(row)?.[1] ?? "";
    expect(className).toContain("px-5");
    expect(className).toContain("sm:px-8");
    // Nothing may widen the left inset beyond that gutter.
    expect(className).not.toMatch(/\b(pl-|ml-|sm:pl-|sm:ml-)/);
  });

  it("the toggle is the row's first element, directly followed by the trail, with no divider", () => {
    const row = topbarRow();
    const toggle = row.indexOf("<SidebarTrigger");
    const trail = row.indexOf("<Breadcrumb");
    expect(toggle).toBeGreaterThan(-1);
    expect(trail).toBeGreaterThan(toggle);
    const ahead = row.slice(0, trail);
    // Nothing between the gutter and the toggle, and no divider anywhere
    // between the toggle and the trail.
    const tags = ahead.match(/<[A-Z][A-Za-z]*[^>]*>/g) ?? [];
    expect(tags).toHaveLength(1);
    expect(tags[0]?.startsWith("<SidebarTrigger")).toBe(true);
    expect(ahead).not.toContain("<Separator");
    // It is not hidden at any width.
    expect(tags[0] ?? "").not.toMatch(/\bhidden\b|max-sm:hidden|sm:hidden/);
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
 * THE MOBILE LEFT EDGE, and THE ONE DECISION POINT.
 *
 * The trail is `hidden sm:flex`, so below `sm` the toggle is alone at the
 * row's left gutter and the right-hand cluster (`ml-auto`) stays right-aligned.
 *
 * And the tab title: the shell must reach the guard through the one function
 * that applies it to BOTH inputs, never by preferring the published label
 * itself - a published label can be the short-id placeholder.
 */
describe("the left edge below sm, and the single title decision point", () => {
  it("draws the sidebar toggle once, outside the right-hand cluster", () => {
    // ONE element carries the sidebar-trigger slot at every width. Two
    // mounts, each hidden by a class at the other's widths, are both in the
    // document, and a strict locator on that slot resolves to two.
    const mounts = source.match(/<SidebarTrigger\b/g) ?? [];
    expect(mounts).toHaveLength(1);
    const row = topbarRow();
    expect(row).toContain("<SidebarTrigger");
    // The right-hand cluster keeps to the right edge and holds neither the
    // toggle nor a vertical divider.
    const marker = source.indexOf('data-testid="app-shell-topbar-right"');
    expect(marker).toBeGreaterThan(-1);
    const open = source.lastIndexOf("<", marker);
    const openEnd = source.indexOf(">", marker);
    const clusterTag = source.slice(open, openEnd + 1);
    const clusterClasses = (/className="([^"]*)"/.exec(clusterTag)?.[1] ?? "").split(/\s+/);
    expect(clusterClasses).toContain("ml-auto");
    expect(clusterClasses).not.toContain("max-sm:flex-1");
    const cluster = source.slice(openEnd);
    expect(cluster.indexOf("<SidebarTrigger")).toBe(-1);
    expect(source).not.toContain('<Separator orientation="vertical"');
    // The trail itself is still the sm-and-up element named top-bar-left.
    expect(row).toContain('data-testid="app-shell-topbar-left"');
  });

  it("decides the agent-instance tab title through the single guarded helper", () => {
    // FORWARD RESOLUTION (main merged): the agent-instance reading is now the
    // TRAIL's own leaf, read under every scope base, and the guard this slice
    // added stands in front of it. What must never come back is a published
    // label preferred ahead of that guard.
    expect(source).toContain("agentInstanceTabLabel(pathname, breadcrumbSegments)");
    expect(source).toContain("documentTitleLabelForAgentInstance(agentLabel, breadcrumbSegments)");
    expect(source).not.toContain("agentLabel ?? documentTitleLabelFromTrail");
  });
});
