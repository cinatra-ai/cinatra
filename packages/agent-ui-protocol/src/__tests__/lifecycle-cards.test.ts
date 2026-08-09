// The lifecycle CARD registry — spec conformance + wire invariants
// (cinatra#2565, epic #2564 S1).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` at that commit.

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_CARD_CARRIAGE,
  LIFECYCLE_CARD_HOSTS,
  LIFECYCLE_CARD_KINDS,
  LIFECYCLE_CARD_PRESENCE,
  LIFECYCLE_CARD_STATES,
  LIFECYCLE_DATA_PART_VIEW_TYPES,
  LIFECYCLE_REVIEW_CARD_STATES,
  LIFECYCLE_VIEW_REF_MAX_LENGTH,
  LIFECYCLE_VIEW_SCHEMA_VERSION,
  isLifecycleDataPartViewType,
  lifecycleCardStateSchema,
  lifecycleViewTypesForHost,
} from "../renderable-views/lifecycle-cards";
import {
  KNOWN_RENDERABLE_VIEW_TYPES,
  parseRenderableView,
} from "../renderable-views/index";

describe("the registry is one card per interaction kind (§IX)", () => {
  it("declares exactly the four interaction kinds the spec's matrix rows fix", () => {
    expect([...LIFECYCLE_CARD_KINDS].sort()).toEqual([
      "artifact_review_gate",
      "recommendation_hold",
      "trigger_schedule_proposal",
      "verification_summary",
    ]);
  });

  it("every kind declares how it reaches a surface, and only the hold is an interrupt", () => {
    for (const kind of LIFECYCLE_CARD_KINDS) {
      expect(["data_part", "interrupt"]).toContain(LIFECYCLE_CARD_CARRIAGE[kind]);
    }
    const interrupts = LIFECYCLE_CARD_KINDS.filter(
      (k) => LIFECYCLE_CARD_CARRIAGE[k] === "interrupt",
    );
    expect(interrupts).toEqual(["recommendation_hold"]);
  });

  it("every DATA_PART kind is registered in the renderable-view schema registry", () => {
    for (const viewType of LIFECYCLE_DATA_PART_VIEW_TYPES) {
      expect(KNOWN_RENDERABLE_VIEW_TYPES).toContain(viewType);
      expect(isLifecycleDataPartViewType(viewType)).toBe(true);
    }
    // The interrupt-carried kind is deliberately NOT a registered view.
    expect(KNOWN_RENDERABLE_VIEW_TYPES).not.toContain("recommendation_hold");
    expect(isLifecycleDataPartViewType("recommendation_hold")).toBe(false);
  });
});

describe("the presence matrix (§IX)", () => {
  it("review and verification appear on EVERY host", () => {
    for (const host of LIFECYCLE_CARD_HOSTS) {
      expect(LIFECYCLE_CARD_PRESENCE.artifact_review_gate[host]).toBe(true);
      expect(LIFECYCLE_CARD_PRESENCE.verification_summary[host]).toBe(true);
    }
  });

  it("recommendation and schedule proposal are first-party only — never the widget", () => {
    expect(LIFECYCLE_CARD_PRESENCE.recommendation_hold.site_widget).toBe(false);
    expect(LIFECYCLE_CARD_PRESENCE.trigger_schedule_proposal.site_widget).toBe(false);
    for (const host of ["chat_thread", "run_card", "page_gate_region"] as const) {
      expect(LIFECYCLE_CARD_PRESENCE.recommendation_hold[host]).toBe(true);
      expect(LIFECYCLE_CARD_PRESENCE.trigger_schedule_proposal[host]).toBe(true);
    }
  });

  it("lifecycleViewTypesForHost projects the matrix onto the DATA_PART kinds", () => {
    expect([...lifecycleViewTypesForHost("chat_thread")].sort()).toEqual([
      "artifact_review_gate",
      "trigger_schedule_proposal",
      "verification_summary",
    ]);
    expect([...lifecycleViewTypesForHost("site_widget")].sort()).toEqual([
      "artifact_review_gate",
      "verification_summary",
    ]);
  });
});

describe("the card states (§IV)", () => {
  it("carries all five review states", () => {
    for (const state of LIFECYCLE_REVIEW_CARD_STATES) {
      expect(LIFECYCLE_CARD_STATES).toContain(state);
    }
  });

  it("keeps `restricted` and `absent` distinct — a withheld card is never a disabled one", () => {
    const restricted = lifecycleCardStateSchema.safeParse({
      state: "restricted",
      canDecide: false,
      canComment: true,
      reason: "Approving needs approve access on this run.",
    });
    expect(restricted.success).toBe(true);
    expect(lifecycleCardStateSchema.safeParse({ state: "absent" }).success).toBe(true);
  });

  it("`pending` cannot claim canDecide:false (that is what `restricted` is for)", () => {
    expect(
      lifecycleCardStateSchema.safeParse({
        state: "pending",
        canDecide: false,
        canComment: true,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown state and any extra field", () => {
    expect(lifecycleCardStateSchema.safeParse({ state: "approved" }).success).toBe(false);
    expect(
      lifecycleCardStateSchema.safeParse({ state: "settled", winner: "alice" }).success,
    ).toBe(false);
  });
});

describe("the wire payload is a ref and nothing else", () => {
  const ok = {
    viewType: "artifact_review_gate",
    schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
    ref: "ref-abc",
  };

  it("parses a well-formed ref-only payload for each lifecycle viewType", () => {
    for (const viewType of LIFECYCLE_DATA_PART_VIEW_TYPES) {
      expect(parseRenderableView({ ...ok, viewType })).toEqual({ ...ok, viewType });
    }
  });

  it("REFUSES a payload carrying content alongside the ref", () => {
    expect(parseRenderableView({ ...ok, title: "Q3 email" })).toBeNull();
    expect(parseRenderableView({ ...ok, state: "pending" })).toBeNull();
  });

  it("REFUSES an oversized ref (the truncation bound)", () => {
    expect(
      parseRenderableView({ ...ok, ref: "r".repeat(LIFECYCLE_VIEW_REF_MAX_LENGTH + 1) }),
    ).toBeNull();
    expect(
      parseRenderableView({ ...ok, ref: "r".repeat(LIFECYCLE_VIEW_REF_MAX_LENGTH) }),
    ).not.toBeNull();
  });

  it("REFUSES an empty ref and a forward schemaVersion", () => {
    expect(parseRenderableView({ ...ok, ref: "" })).toBeNull();
    expect(parseRenderableView({ ...ok, schemaVersion: 2 })).toBeNull();
  });
});
