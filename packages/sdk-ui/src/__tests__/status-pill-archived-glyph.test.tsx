// @vitest-environment jsdom
//
// The SDK's copy of StatusPill draws Archived with the archive box, as the
// status-pills roster in specs/app.html does (cinatra#4444):
//   <path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/>
// No other state's glyph changes from what main draws.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { StatusPill, type StatusPillStatus } from "../status-pill";

afterEach(cleanup);

const CROSS = ["path:M18 6 6 18", "path:m6 6 12 12"];
// Declined leads with the roster's trash can and Scheduled with its calendar of
// three strokes, as main draws them since cinatra#4442.
const TRASH = [
  "path:M3 6h18",
  "path:M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  "path:M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
];

function shapes(status: StatusPillStatus): string[] {
  const { container } = render(<StatusPill status={status}>Label</StatusPill>);
  const svg = container.querySelector("svg");
  return [...(svg?.children ?? [])].map((shape) => {
    const key = shape.getAttribute("d") ?? shape.getAttribute("points") ?? `${shape.getAttribute("x") ?? shape.getAttribute("cx")},${shape.getAttribute("y") ?? shape.getAttribute("cy")}`;
    return `${shape.tagName.toLowerCase()}:${key}`;
  });
}

describe("SDK StatusPill glyphs", () => {
  it("draws Archived with the roster's archive box, not the cross", () => {
    expect(shapes("archived")).toEqual(["path:M21 8v13H3V8", "path:M1 3h22v5H1z"]);
  });

  it.each<[StatusPillStatus, string[]]>([
    ["running", ["polygon:6 3 20 12 6 21 6 3"]],
    ["approved", ["path:M20 6 9 17l-5-5"]],
    ["hold", ["rect:6,4", "rect:14,4"]],
    ["needs-review", ["circle:12,12", "path:M12 8v4", "path:M12 16h.01"]],
    ["scheduled", ["rect:3,6", "path:M16 2v4", "path:M8 2v4"]],
    ["queued", ["circle:12,12", "path:M12 7v5l3 2"]],
    ["idle", ["circle:12,12"]],
    ["failed", CROSS],
    ["declined", TRASH],
  ])("keeps the glyph of %s", (status, expected) => {
    expect(shapes(status)).toEqual(expected);
  });
});
