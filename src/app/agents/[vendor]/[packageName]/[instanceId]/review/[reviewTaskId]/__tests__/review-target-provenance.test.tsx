// @vitest-environment jsdom
//
// THE TARGET DRAWS THE WORK AND NOTHING ABOUT ITSELF (cinatra#3080).
//
// The ratified drawing fixes this twice. `specs/app-artifact-review.html` §V:
// the renderer resolution "is NOT put on screen: a display shows the work and
// nothing about itself — no renderer name, no package identity, no provenance
// line — because the reader is deciding on the work, not on what drew it", and
// its two renderer-tier examples draw a build-time target and a runtime one
// "the same way, because nothing on either target says which resolved it".
// §V.1 says it again for the markdown display: the display's header is "the two
// tabs, and the saving indicator below, and nothing else — no renderer chip and
// no provenance line, here or on any other surface this display is drawn".
//
// THE ONE THAT DOES SPEAK IS THE FLOOR, "and only because a reader must be told
// a render failed" — the drawing's floor example draws a `Floor` mark over
// `structured data` above the sanitized one-line diagnostic. That reading is
// kept: this suite pins its presence as tightly as it pins the other two's
// absence, so removing the forbidden row can never be widened into removing the
// failure state's own honest reading.
//
// ONE PANEL, THREE SURFACES. `ReviewTargetPanel` is the only implementation of
// the target ladder in the repository, and the run page, the review page and
// the conversation's card all reach it through the same island, so a reading
// proven here is the reading all three draw.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The mount and the capture pair carry their own suites; stubbed so this one
// does not drag the renderer-resolution graph in behind the panel's markup.
vi.mock("@/app/artifacts/[id]/review-target-mount", () => ({
  ReviewTargetMount: () => null,
}));
vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-pinned-capture",
  () => ({ ReviewPinnedCapture: () => null }),
);

import { ReviewTargetPanel } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel";

type Prepared = Parameters<typeof ReviewTargetPanel>[0]["prepared"];

function preparedWith(mount: Record<string, unknown>): Prepared {
  return {
    target: {
      artifactId: "artifact-1",
      representationRevisionId: "rev-000000000000001",
    },
    props: {
      artifact: {
        title: "How Teams Adopt New Connectors",
        objectType: "@cinatra-ai/blog-post-artifact",
        ownerLevel: "Organization",
        visibility: "Private",
        mime: "text/markdown",
        updatedAt: "8 min ago",
      },
    },
    mount,
  } as unknown as Prepared;
}

const render = (mount: Record<string, unknown>): string =>
  renderToStaticMarkup(
    <ReviewTargetPanel prepared={preparedWith(mount)} orgId="org-1" capturePair={null} />,
  );

const BUILD_MAP = {
  kind: "build-map",
  slot: "detail",
  packageName: "@cinatra-ai/blog-post-artifact",
};
const RUNTIME = {
  kind: "runtime",
  slot: "detail",
  packageName: "@acme/support",
  descriptor: { tuple: "acme" },
};
const FORM = { kind: "form", form: "markdown", slot: "detail", packageName: null };
const FLOOR = {
  kind: "floor",
  slot: "detail",
  packageName: "@acme/support",
  reason: "requires-rebuild",
};

describe("§V — a resolved renderer says nothing about itself on the target", () => {
  it("draws no resolution line for a BUILD-TIME renderer", () => {
    const html = render(BUILD_MAP);
    expect(html).not.toMatch(/build-time/);
    expect(html).not.toMatch(/data-conformance-id="review-provenance-native"/);
  });

  it("draws no resolution line and no package identity for a RUNTIME renderer", () => {
    const html = render(RUNTIME);
    expect(html).not.toMatch(/runtime · /);
    expect(html).not.toMatch(/@acme\/support/);
    expect(html).not.toMatch(/data-conformance-id="review-provenance-marketplace"/);
  });

  it("names the type ONCE — in the header, never again beneath it", () => {
    // The header's own type tag is §IV's and stays; the forbidden row drew the
    // same words a second time, immediately under it. One occurrence is the
    // header's; two was the defect.
    const html = render(BUILD_MAP);
    expect(html.split("Blog Post Artifact").length - 1).toBe(1);
  });

  it("draws nothing above the work for the host's own text rendering", () => {
    const html = render(FORM);
    expect(html).not.toMatch(/data-conformance-id="review-provenance/);
    expect(html).not.toMatch(/data-conformance-id="review-target-floor"/);
  });
});

describe("§V — the floor still speaks, because a reader must be told a render failed", () => {
  it("keeps the floor's own mark and its structured-data reading", () => {
    const html = render(FLOOR);
    expect(html).toMatch(/data-conformance-id="review-target-floor"/);
    expect(html).toMatch(/Floor/);
    expect(html).toMatch(/structured data/);
  });

  it("does not name the failing package on the floor's own mark", () => {
    // The sanitized package · slot · reason diagnostic is the MOUNT's, drawn
    // inside the failure state itself; the panel's mark above it carries no
    // package identity of its own.
    const html = render(FLOOR);
    expect(html).not.toMatch(/@acme\/support/);
  });
});
