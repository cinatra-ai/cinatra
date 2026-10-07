// @vitest-environment jsdom
//
// THE REVIEW FLOOR IS NEVER BLANK BENEATH ITS DIAGNOSTIC (cinatra#3319).
//
// `specs/app-artifact-review.html` §V: "The floor is never a blank. Whenever a
// target does not resolve to a type renderer, it renders the floor — a
// sanitized, telemetry-safe one-line diagnostic (package · slot · reason, never
// a raw error or manifest value) — so the surface never shows an empty panel
// where a target should be." And, in the same paragraph, the two shapes this
// file drives:
//
//   "A type-level floor — the type's renderer is installed but absent from this
//    build (needs a rebuild), or the type resolves to no renderer — still has an
//    authorized representation, so its diagnostic sits above the generic
//    read-only structured-data view of that representation."
//
//   "An artifact-level floor — the artifact is unknown or tombstoned,
//    read-refused for this reviewer, or its pinned revision is no longer a
//    member — has nothing to show, so it renders the diagnostic alone (no
//    representation content, because there is no authorized representation to
//    render)."
//
// The second picture round's review-gate cell graded the first shape on both
// palettes: the panel drew the `Floor` chip and the mono `structured data`
// label over an EMPTY region, because the panel handed the mount a null
// fallback node for every target.
//
// WHAT THIS FILE DRIVES: the panel's fallback argument and the view it now
// builds, through the REAL mount — the floor node and its diagnostic composer
// are the shipped ones and are not replaced. The pinned-capture pair is
// replaced because it is additive context with its own suite, exactly as the
// sibling overflow file replaces it. The mount is an async server component, so
// the tree is rendered through the streaming server renderer, which resolves it.

import { describe, expect, it, vi } from "vitest";
import { renderToReadableStream } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock(
  "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-pinned-capture",
  () => ({ ReviewPinnedCapture: () => null }),
);

import { resolveArtifactDisplayMount } from "@/app/artifacts/[id]/renderer-resolution";
import { ReviewTargetPanel } from "@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel";

/** The pinned representation this target's decision binds. */
const PINNED_PROPS = {
  propsApiVersion: 2,
  artifact: {
    id: "artifact-1",
    title: "Login loop on SSO",
    objectType: "@acme/support:case",
    mime: "application/vnd.acme.case+json",
    size: 412,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ownerLevel: "organization",
    visibility: "organization",
    sourceUrl: null,
  },
  representation: { revisionId: "rev-1", mime: "application/vnd.acme.case+json" },
  urls: { preview: null, download: null },
  identity: { kind: "extension", extension: "@acme/support" },
  actions: { download: null, openInSource: null },
  content: {
    kind: "object",
    channelVersion: 1,
    source: "snapshot",
    representationRevisionId: "rev-1",
    objectType: "@acme/support:case",
    data: { subject: "Login loop on SSO", priority: "high" },
    digest: "d".repeat(64),
    byteLength: 64,
    projectedByteLength: 64,
    cap: 256 * 1024,
  },
  edit: { kind: "read-only", channelVersion: 1, reason: "read-only-surface" },
};

type Prepared = Parameters<typeof ReviewTargetPanel>[0]["prepared"];

/** §V's FIRST shape: the type's renderer is installed but absent from this
 *  build, so the target still has an authorized representation. */
const TYPE_LEVEL_FLOOR = {
  target: { artifactId: "artifact-1", representationRevisionId: "rev-1" },
  props: PINNED_PROPS,
  mount: {
    kind: "floor",
    slot: "detail",
    packageName: "@acme/support",
    reason: "requires-rebuild",
  },
} as unknown as Prepared;

/** §V's OTHER shape: an unknown or tombstoned target, which has no authorized
 *  representation at all. */
const ARTIFACT_LEVEL_FLOOR = {
  target: { artifactId: "artifact-9", representationRevisionId: null },
  props: null,
  mount: {
    kind: "floor",
    slot: "detail",
    packageName: null,
    reason: "unknown-or-tombstoned",
  },
} as unknown as Prepared;

async function panel(prepared: Prepared): Promise<Element> {
  const tree = ReviewTargetPanel({
    prepared,
    orgId: "org-1",
    capturePair: null,
  }) as ReactElement;
  const stream = await renderToReadableStream(tree);
  document.body.innerHTML = await new Response(stream).text();
  const frame = document.body.querySelector("[data-conformance-id='review-target']");
  if (!frame) throw new Error("no target panel in the rendered document");
  return frame;
}

const FLOOR = "[data-review-target-floor]";
const VIEW = "[data-conformance-id='artifact-render-fallback']";

describe("a type-level floor draws its diagnostic OVER the representation (cinatra#3319)", () => {
  // ONE CASE, because §V words one reading: the three-segment sentence AND the
  // view beneath it. Splitting the sentence off would leave an arm that is green
  // before the cut (the prepared target already carries its package here — the
  // resolver's own null is a separate road) and would prove nothing about the
  // blank region the round graded.
  it("the diagnostic carries package, slot and reason, and the structured-data view sits BENEATH it", async () => {
    const floor = (await panel(TYPE_LEVEL_FLOOR)).querySelector(FLOOR);
    expect(floor, "the floor region").not.toBeNull();
    const line = floor?.querySelector("p[role='status']") ?? null;
    expect(line?.textContent).toBe(
      'review target unavailable — package "@acme/support", slot "detail", reason "requires-rebuild"',
    );
    const view = floor?.querySelector(VIEW) ?? null;
    expect(view, "the structured-data view beneath the diagnostic").not.toBeNull();
    if (!line || !view) throw new Error("the floor drew no diagnostic or no view");
    // Beneath, not merely present: the diagnostic precedes it in the document.
    expect(
      line.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("that view carries the pinned representation's own values", async () => {
    const view = (await panel(TYPE_LEVEL_FLOOR)).querySelector(VIEW);
    const text = view?.textContent ?? "";
    expect(text).toContain("@acme/support:case");
    expect(text).toContain("structured data");
    expect(text).toContain("Login loop on SSO");
    expect(text).toContain("priority");
    expect(text).toContain("high");
  });
});

describe("an artifact-level floor renders the diagnostic ALONE (cinatra#3319)", () => {
  // GREEN BEFORE AND AFTER, deliberately: this arm pins what must NOT change.
  // §V gives a target with no authorized representation nothing to show, so the
  // panel passes no node at all rather than an empty frame.
  it("draws the diagnostic and no representation content", async () => {
    const frame = await panel(ARTIFACT_LEVEL_FLOOR);
    const floor = frame.querySelector(FLOOR);
    expect(floor, "the floor region").not.toBeNull();
    expect(floor?.querySelector("p[role='status']")?.textContent).toBe(
      'review target unavailable — slot "detail", reason "unknown-or-tombstoned"',
    );
    expect(frame.querySelector(VIEW), "no structured-data view").toBeNull();
    expect(frame.textContent).not.toContain("Login loop on SSO");
  });
});

describe("the package the RESOLVER answers reaches the rendered diagnostic (cinatra#3319)", () => {
  // THE WHOLE ROAD, NOT ITS HALVES. The resolver's terminal arm is where the
  // package segment was lost, and the sentence a reviewer reads is drawn three
  // files later. This case takes the descriptor the REAL resolver answers for a
  // row nothing claims and renders THAT through the panel, so a package dropped
  // anywhere between the two reads as a red here rather than as a green in both
  // halves. (Codex convergence round, 2026-09-18.)
  it("draws the resolver's own package in the floor's three-segment sentence", async () => {
    const mount = await resolveArtifactDisplayMount({
      orgId: "org_3319_review_floor",
      baseType: "@acme/support:case",
      identity: { kind: "no-primary" },
      mime: "application/vnd.cinatra.nothing-claims-this",
      propsApiVersion: 2,
    });
    expect(mount.kind).toBe("floor");

    const prepared = {
      target: { artifactId: "artifact-1", representationRevisionId: "rev-1" },
      props: PINNED_PROPS,
      mount,
    } as unknown as Prepared;

    const floor = (await panel(prepared)).querySelector(FLOOR);
    expect(floor?.querySelector("p[role='status']")?.textContent).toBe(
      'review target unavailable — package "@acme/support", slot "detail", reason "no-display"',
    );
    expect(floor?.querySelector(VIEW), "the view beneath it").not.toBeNull();
  });
});
