// @vitest-environment jsdom
//
// StatusPill — the two roster pills the marketplace approval states added
// (cinatra#4296): Withdrawn and Reset. The application drawing's pill roster
// draws both as idle pills, each with its own arrow:
//
//   <span class="pill idle"><svg …><path d="M9 14 4 9l5-5"/>
//     <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>Withdrawn</span>
//   <span class="pill idle"><svg …><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
//     <path d="M3 3v5h5"/></svg>Reset</span>
//
// "A new idle pill with an undo arrow; no one has to act." and "A new idle pill
// with a back-to-start arrow" (the drawing's marketplace approval states block).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";

afterEach(cleanup);

function renderPill(status: StatusPillStatus, label?: string) {
  const { container } = render(<StatusPill status={status}>{label}</StatusPill>);
  return container.firstElementChild as HTMLElement;
}

const DRAWN: Array<{ status: StatusPillStatus; label: string; paths: string[] }> = [
  {
    status: "withdrawn",
    label: "Withdrawn",
    paths: ["M9 14 4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"],
  },
  {
    status: "reset",
    label: "Reset",
    paths: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  },
];

describe("the Withdrawn and Reset roster pills", () => {
  it.each(DRAWN)("draws '$status' in the idle pill's muted ink, like the drawing's `pill idle`", ({ status }) => {
    const idle = renderPill("idle").className;
    cleanup();
    const cls = renderPill(status).className;
    expect(cls).toContain("text-muted-foreground");
    expect(cls).toContain("bg-transparent");
    // `pill idle`'s border is the strong line (specs/app.html, the pill recipes).
    expect(cls.split(/\s+/)).toContain("border-line-strong");
    // The same recipe as the idle pill, so the two never drift apart.
    expect(cls).toBe(idle);
  });

  it.each(DRAWN)("leads '$status' with the drawn arrow, not the idle ring", ({ status, paths }) => {
    const pill = renderPill(status);
    const svg = pill.querySelector("svg");
    expect(svg, `${status} renders no glyph`).not.toBeNull();
    expect(pill.firstElementChild).toBe(svg);
    const drawn = Array.from(svg!.querySelectorAll("path")).map((p) => p.getAttribute("d"));
    expect(drawn).toEqual(paths);
    expect(svg!.querySelector("circle")).toBeNull();
  });

  it.each(DRAWN)("labels '$status' with the roster label by default", ({ status, label }) => {
    const pill = renderPill(status);
    expect(pill.textContent).toBe(label);
    expect(pill.getAttribute("data-status")).toBe(status);
  });
});
