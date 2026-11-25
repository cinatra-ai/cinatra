// THE RENDERER NAME TRAVELS BESIDE ITS HEADER (cinatra#3092).
//
// lifecycle-cards §XIII.7: the identity line "also names the one renderer both
// CMS extensions draw through". The header schema is strict, and a client
// built before the name existed refuses a header with an unknown key, and with
// it the whole answer. So the name rides beside the headers
// (`targetHeaderRenderers`), a key such a client ignores, and this build folds
// it back onto its header. A malformed name list refuses the answer, as a
// malformed header does.

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_TARGET_HEADER_MAX_TEXT,
  lifecycleTargetHeadersSchema,
  parseLifecycleResolveEnvelope,
  reviewTargetHeadersWire,
} from "../renderable-views/lifecycle-cards";

const PENDING = { state: "pending", canDecide: true, canComment: true } as const;
const PAGE = {
  title: "Pricing — 2026 plans",
  typeLabel: "CMS page",
  objectType: "@acme/cms-page:content-snapshot",
  revisionId: "rev_c410a7",
  facts: ["WordPress", "Team: Growth", "Private", "acme.example/pricing"],
};
const DASHBOARD = {
  title: "Pipeline health — Q3",
  typeLabel: "Dashboard",
  objectType: "@acme/dashboard:dashboard",
  revisionId: "rev_2e77",
  facts: ["Team: Growth", "Private", "application/json", "updated 8 minutes ago"],
};
const RENDERER = "@acme/cms-page:page-diff";

function parse(extra: Record<string, unknown>, state: Record<string, unknown> = PENDING) {
  return parseLifecycleResolveEnvelope("artifact_review_gate", {
    kind: "artifact_review_gate",
    state,
    body: null,
    ...extra,
  });
}

describe("the wire form of the headers", () => {
  it("sends each name beside its header, null where a display names none", () => {
    expect(reviewTargetHeadersWire([{ ...PAGE, drawnBy: RENDERER }, DASHBOARD])).toEqual({
      targetHeaders: [PAGE, DASHBOARD],
      targetHeaderRenderers: [RENDERER, null],
    });
  });

  it("sends exactly the answer it sent before the names when no display names one", () => {
    expect(reviewTargetHeadersWire([DASHBOARD])).toEqual({ targetHeaders: [DASHBOARD] });
    expect(Object.keys(reviewTargetHeadersWire([DASHBOARD]))).toEqual(["targetHeaders"]);
  });

  it("never sends a header an older client's strict schema refuses", () => {
    const wire = reviewTargetHeadersWire([{ ...PAGE, drawnBy: RENDERER }]);
    expect(lifecycleTargetHeadersSchema.safeParse(wire.targetHeaders).success).toBe(true);
    // The reason the name is not a header key: the strict schema refuses it.
    expect(lifecycleTargetHeadersSchema.safeParse([{ ...PAGE, drawnBy: RENDERER }]).success).toBe(false);
  });
});

describe("the parser folds the names back", () => {
  it("puts each name on its own header, and leaves a header without one as it was", () => {
    const answer = parse({ targetHeaders: [PAGE, DASHBOARD], targetHeaderRenderers: [RENDERER, null] });
    expect(answer?.targetHeaders?.[0]).toEqual({ ...PAGE, drawnBy: RENDERER });
    expect(answer?.targetHeaders?.[1]).toEqual(DASHBOARD);
    expect("drawnBy" in answer!.targetHeaders![1]!).toBe(false);
  });

  it("reads an answer without names exactly as before", () => {
    expect(parse({ targetHeaders: [DASHBOARD] })?.targetHeaders).toEqual([DASHBOARD]);
  });

  it("refuses a name list that is not one bounded, single-line text or null per header", () => {
    const refused: unknown[] = [
      "not a list",
      [RENDERER, null, null],
      [RENDERER],
      [42, null],
      ["", null],
      [" padded", null],
      ["a\nb", null],
      ["a · b", null],
      ["a‮b", null],
      ["r".repeat(LIFECYCLE_TARGET_HEADER_MAX_TEXT + 1), null],
    ];
    for (const names of refused) {
      expect(parse({ targetHeaders: [PAGE, DASHBOARD], targetHeaderRenderers: names }), JSON.stringify(names)).toBeNull();
    }
  });

  it("refuses names without headers, and names beside an absent state", () => {
    expect(parse({ targetHeaderRenderers: [RENDERER] })).toBeNull();
    expect(parse({ targetHeaderRenderers: [RENDERER] }, { state: "absent" })).toBeNull();
  });
});
