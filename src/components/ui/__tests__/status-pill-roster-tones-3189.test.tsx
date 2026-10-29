// @vitest-environment jsdom
//
// StatusPill: Scheduled and Queued in the families the roster draws them in
// (cinatra#3189, G4 status pills).
//
//   pnpm exec vitest run src/components/ui/__tests__/status-pill-roster-tones-3189.test.tsx
//
// The components drawing (Badge / Pill) says: "Anything that stands for a run,
// approval or lifecycle state takes the status pill and its fixed roster (V),
// so one state is never drawn two ways on two screens." The roster
// (specs/app.html, `data-conformance-id="status-pills"`) draws:
//
//   Scheduled  `pill approved` (sea-green) on a 6% ground, a calendar of three
//              strokes: rect 3,6 18x15, M16 2v4, M8 2v4
//   Queued     `pill running` (indigo) on an 8% ground
//
//   Declined   a trash can (M3 6h18, M8 6V4..., M19 6v14...), apart from
//              Failed's cross
//
// Both StatusPill copies are read: the application's and the SDK's ABI copy
// (packages/sdk-ui), which the SDK exports to extensions.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { StatusPill as AppPill } from "@/components/ui/status-pill";
import { StatusPill as SdkPill } from "../../../../packages/sdk-ui/src/status-pill";

afterEach(cleanup);

type Pill = typeof AppPill | typeof SdkPill;
const COPIES: Array<[string, Pill]> = [
  ["the application's StatusPill", AppPill],
  ["the SDK's StatusPill", SdkPill],
];

function pill(Component: Pill, status: string): HTMLElement {
  const { container } = render(
    <Component status={status as never}>Label</Component>,
  );
  const el = container.querySelector(`[data-status="${status}"]`) as HTMLElement | null;
  if (!el) throw new Error(`no [data-status="${status}"] pill rendered`);
  return el;
}

function tokens(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

describe.each(COPIES)("%s: the roster's families for Scheduled and Queued", (_name, Component) => {
  it("draws Scheduled in the sea-green family on its 6% ground", () => {
    const t = tokens(pill(Component, "scheduled"));
    expect(t).toEqual(expect.arrayContaining(["text-success", "bg-success/6", "border-success/30"]));
    expect(t.filter((x) => /^(text|bg|border)-(primary|muted)/.test(x))).toEqual([]);
  });

  it("draws Queued in the indigo family on its 8% ground", () => {
    const t = tokens(pill(Component, "queued"));
    expect(t).toEqual(expect.arrayContaining(["text-primary", "bg-primary/8", "border-primary/30"]));
    expect(t.filter((x) => /^(text|bg|border)-(muted|success)/.test(x))).toEqual([]);
  });

  it("leads Scheduled with the roster's calendar of exactly three strokes", () => {
    const svg = pill(Component, "scheduled").querySelector("svg");
    expect(svg).not.toBeNull();
    const parts = Array.from(svg!.children).map((c) =>
      c.tagName.toLowerCase() === "rect"
        ? `rect ${c.getAttribute("x")},${c.getAttribute("y")} ${c.getAttribute("width")}x${c.getAttribute("height")}`
        : `${c.tagName.toLowerCase()} ${c.getAttribute("d")}`,
    );
    expect(parts).toEqual(["rect 3,6 18x15", "path M16 2v4", "path M8 2v4"]);
  });

  it("keeps the Queued clock glyph", () => {
    const d = Array.from(pill(Component, "queued").querySelectorAll("svg path")).map((p) => p.getAttribute("d"));
    expect(d).toContain("M12 7v5l3 2");
  });
});

// The roster draws Declined with a trash can and Failed with the cross. The
// application's copy draws them apart since cinatra#4296; the SDK's copy is
// read here.
describe("the SDK's StatusPill: Declined and Failed are drawn apart", () => {
  const paths = (status: string) =>
    Array.from(pill(SdkPill, status).querySelectorAll("svg path")).map((p) => p.getAttribute("d"));

  it("leads Declined with the roster's trash can", () => {
    expect(paths("declined")).toEqual([
      "M3 6h18",
      "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
      "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
    ]);
  });

  it("keeps Failed on the cross", () => {
    expect(paths("failed")).toEqual(["M18 6 6 18", "m6 6 12 12"]);
  });
});

// The SDK copy's other eight states keep their families: only Scheduled and
// Queued move. (The application copy's other states are graded by
// status-pill-drawing-conformance.test.tsx.)
describe("the SDK's StatusPill: the eight states this change does not touch", () => {
  const KEPT: Array<[string, string[]]> = [
    ["running", ["text-primary", "bg-primary/10", "border-primary/30"]],
    ["approved", ["text-success", "bg-success/10", "border-success/30"]],
    ["hold", ["text-warning", "bg-warning/15", "border-warning/30"]],
    ["needs-review", ["text-warning", "bg-warning/15", "border-warning/40"]],
    ["idle", ["text-muted-foreground", "bg-transparent", "border-line"]],
    ["archived", ["text-muted-foreground", "bg-transparent", "border-line", "opacity-70"]],
    ["failed", ["text-destructive-foreground", "bg-destructive", "border-destructive"]],
    ["declined", ["text-destructive-foreground", "bg-destructive", "border-destructive"]],
  ];
  it.each(KEPT)("keeps '%s' in its family", (status, expected) => {
    expect(tokens(pill(SdkPill, status))).toEqual(expect.arrayContaining(expected));
  });
});
