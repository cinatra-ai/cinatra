// The BOUNDARY of the per-kind resolve envelope (epic S9, slice S9c).
//
// The envelope carries the three DATA_PART kinds. The recommendation hold is the
// fourth lifecycle kind and it is deliberately OUTSIDE: it is the sole typed
// INTERRUPT — the run is blocked on the answer — so it never travels on the
// DATA_PART resolve, and its state is resolved by its own hold action against
// the run.
//
// The protocol suite pins that boundary in types and at the parser. What is
// pinned HERE is the wiring: the hold's carriage still reaches its own resolver,
// and it does not quietly acquire the card resolve path as a second one. Two
// resolvers for one question are two answers free to disagree.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_CARD_CARRIAGE,
  LIFECYCLE_DATA_PART_VIEW_TYPES,
  LIFECYCLE_INTERRUPT_KINDS,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

import { LIFECYCLE_VIEW_RESOLVE_PATH } from "../lifecycle-card-runtime";

function readSource(relative: string): string {
  return readFileSync(path.join(__dirname, "..", relative), "utf8");
}

describe("the recommendation hold stays outside the DATA_PART resolve envelope", () => {
  it("is carried as an INTERRUPT, so it is not a resolve-envelope kind", () => {
    // AMENDED BY cinatra#2930 (lifecycle-b W3): the carriage record is two
    // axes now. `represent` is the one this boundary has always been about —
    // an INTERRUPT kind has no resolve envelope — and it is unchanged. The
    // second axis says where the card's truth lives, and for this kind it is
    // the run's own row, which is what the injected delivery mounts from.
    expect(LIFECYCLE_CARD_CARRIAGE.recommendation_hold.represent).toBe("interrupt");
    expect(LIFECYCLE_CARD_CARRIAGE.recommendation_hold.canonical).toBe("run_state");
    // cinatra#2928 added a second interrupt kind (`agent_hitl_screen`). What
    // this case is about is that an INTERRUPT kind is outside the data-part
    // resolve envelope, so it asserts membership rather than the set size.
    expect(LIFECYCLE_INTERRUPT_KINDS).toContain("recommendation_hold");
    expect(LIFECYCLE_DATA_PART_VIEW_TYPES).not.toContain("recommendation_hold");
  });

  it("its carriage resolves through its OWN hold action", () => {
    const source = readSource("run-recommendation-chip-row.tsx");
    expect(source).toContain("getRunRecommendationHoldStateAction");
  });

  it("its carriage never reaches the card resolve endpoint or the envelope parser", () => {
    const source = readSource("run-recommendation-chip-row.tsx");
    expect(source).not.toContain(LIFECYCLE_VIEW_RESOLVE_PATH);
    expect(source).not.toContain("parseLifecycleResolveEnvelope");
    // The generic card hook is named in prose there (it explains a shared
    // request-guard shape); what must never appear is a CALL to it.
    expect(source).not.toMatch(/useLifecycleCardResolve\s*[(<]/);
  });

  it("the card hook only ever asks for a DATA_PART kind", () => {
    const source = readSource("lifecycle-card-runtime.tsx");
    expect(source).toContain("K extends LifecycleDataPartViewType");
    expect(source).not.toContain("recommendation_hold");
  });
});
