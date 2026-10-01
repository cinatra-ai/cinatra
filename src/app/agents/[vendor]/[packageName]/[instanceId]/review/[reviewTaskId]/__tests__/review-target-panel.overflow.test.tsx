// @vitest-environment jsdom
//
// THE PANEL DOES NOT CLIP THE WORK (the tenth proof round's grade on
// cinatra#3143, 2026-09-09 — counted defect 3: "the drawn bodies are CLIPPED
// with no visible scroll affordance. The json value tree's lines are cut hard at
// the panel's right edge ... and worse at the run page's narrower 768px column").
//
// The panel's frame used to carry `overflow-hidden`, so a representation wider
// than the panel was simply cut: the reader lost the right-hand columns of a
// structured-data reading and the ends of long lines, with nothing on screen to
// say anything had been cut and no way to reach it.
//
// `specs/app-artifact-review.html` §III gives the opposite reading — "a wide
// representation scrolls inside its own container rather than widening the
// page". The container is the representation slot, and it is the one element
// that may scroll: the frame around it draws the border and clips nothing, and
// the page it sits on never widens.
//
// jsdom implements no layout, so `scrollWidth` and `clientWidth` are both 0 on
// every element here and measuring them would assert nothing. What is measured
// instead is the contract that produces the equality in a browser: the frame
// clips nothing, and the slot is the scroll container.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The mount and the pinned-capture pair are rendered, not exercised, here —
// each carries its own suite.
vi.mock("@/app/artifacts/[id]/review-target-mount", () => ({
  ReviewTargetMount: () => null,
}));
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-pinned-capture",
  () => ({ ReviewPinnedCapture: () => null }),
);

import { ReviewTargetPanel } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel";

const PREPARED = {
  target: {
    artifactId: "artifact-1",
    representationRevisionId: "rev-000000000000001",
  },
  props: {
    artifact: {
      title: "Launch announcement",
      objectType: "@cinatra-ai/blog-post-artifact",
      ownerLevel: "Team",
      visibility: "Private",
      mime: "text/html",
      updatedAt: "8 min ago",
    },
  },
  mount: {
    kind: "floor",
    slot: "review",
    packageName: "@cinatra-ai/blog-post-artifact",
  },
} as unknown as Parameters<typeof ReviewTargetPanel>[0]["prepared"];

function panel(): { frame: Element; slot: Element } {
  document.body.innerHTML = renderToStaticMarkup(
    <ReviewTargetPanel prepared={PREPARED} orgId="org-1" capturePair={null} />,
  );
  const frame = document.body.querySelector("[data-conformance-id='review-target']");
  if (!frame) throw new Error("no target panel");
  const slot = frame.querySelector("[data-review-representation-slot]");
  if (!slot) throw new Error("no representation slot");
  return { frame, slot };
}

const classesOf = (el: Element): string[] => Array.from(el.classList);

describe("the representation is reachable, never cut", () => {
  it("the panel's frame clips nothing", () => {
    // `overflow-hidden` here is what cut the drawn bodies at the panel's edges.
    expect(classesOf(panel().frame)).not.toContain("overflow-hidden");
  });

  it("the representation slot is the container that scrolls", () => {
    const classes = classesOf(panel().slot);
    // "a wide representation scrolls inside its own container rather than
    // widening the page" — the slot scrolls horizontally...
    expect(classes).toContain("overflow-x-auto");
    // ...and it may shrink below its content, or the overflow moves back out to
    // the document and the page widens instead.
    expect(classes).toContain("min-w-0");
    // It is still the drawing's single region, with the padding it always had.
    expect(classes).toContain("p-4");
  });

  it("nothing between the frame and the slot clips either", () => {
    const { frame, slot } = panel();
    for (const el of [frame, ...Array.from(frame.querySelectorAll("*"))]) {
      if (el === slot || slot.contains(el)) continue;
      expect(classesOf(el)).not.toContain("overflow-hidden");
    }
  });
});
