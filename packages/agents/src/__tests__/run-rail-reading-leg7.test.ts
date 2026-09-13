/**
 * THE RUN RAIL, AS DRAWN (cinatra#3080, PR #3100, fix leg 7).
 *
 * TWO THINGS THE EIGHTH PROOF ROUND MEASURED.
 *
 * THE SETTLED ROW. It drew two un-joined spans — "Review" then a title-case
 * "Continued" — against the rail the ratified review drawing draws, whose
 * settled rows read "Review · the post · continued" and "Review · featured image
 * · continued": one sentence, middot-joined, the settled word lowercase.
 *
 * THE STICKY COLUMN. The round reported that fix leg 6's sticky rail column
 * "never rendered" on a one-step run and that only the rail PANEL was on screen.
 * Both mounts of that column carry the same class; the one on the branch without
 * gate steps carried no marker at all, so it could not be named in a frame. It
 * carries the frame's own `data-run-step-rail-column` marker now — an attribute,
 * not a conformance id, so the route's closed anchor set is untouched.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(path.join(PACKAGE_ROOT, rel), "utf8");
const RAIL_ENTRY = read("src/run-step-rail-extra-entry.tsx");
const INSTANCE_SCREENS = read("src/instance-screens.tsx");
const RUN_SURFACE_RAIL = read("src/run-surface-rail.tsx");

describe("the rail's settled review row", () => {
  it("joins the settled word onto the label with a middot", () => {
    expect(RAIL_ENTRY).toContain("{` · ${settledWord.toLowerCase()}`}");
  });

  it("does not draw the word as a spaced-out badge any more", () => {
    expect(RAIL_ENTRY).not.toMatch(/data-rail-gate-settled=\{settledWord\}\s*>\s*\{settledWord\}/);
    expect(RAIL_ENTRY).not.toContain('className="ms-1.5 text-badge-2xs tracking-wide text-muted-foreground"');
  });
});

describe("the sticky rail column", () => {
  it("is marked on BOTH mounts, so a frame can measure the one it drew", () => {
    const marks = (src: string) => (src.match(/data-run-step-rail-column=""/g) ?? []).length;
    expect(marks(RUN_SURFACE_RAIL)).toBe(1);
    expect(marks(INSTANCE_SCREENS)).toBe(1);
  });

  it("both mounts take the ONE column class, so there is one rail and not two", () => {
    expect(RUN_SURFACE_RAIL).toContain("className={RUN_SURFACE_RAIL_COLUMN_CLASS}");
    expect(INSTANCE_SCREENS).toContain("className={RUN_SURFACE_RAIL_COLUMN_CLASS}");
  });
});
