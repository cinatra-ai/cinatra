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
  LIFECYCLE_SUGGESTION_ID_MAX_LENGTH,
  LIFECYCLE_SUGGESTION_LABEL_MAX_LENGTH,
  LIFECYCLE_SUGGESTION_MESSAGE_MAX_LENGTH,
  LIFECYCLE_VIEW_REF_MAX_LENGTH,
  LIFECYCLE_VIEW_SCHEMA_VERSION,
  MAX_LIFECYCLE_SUGGESTIONS,
  isLifecycleDataPartViewType,
  lifecycleCardStateSchema,
  lifecycleSuggestionLabel,
  lifecycleSuggestionSchema,
  lifecycleViewTypesForHost,
  projectLifecycleSuggestions,
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

// ---------------------------------------------------------------------------
// §VIII — suggestion chips (cinatra#2572, epic #2564 S6c)
// ---------------------------------------------------------------------------

describe("§VIII the suggestion chip's wire shape", () => {
  const chip = {
    id: "sug-1",
    label: "items · 1 · subject",
    op: "replace" as const,
    message: "Not canonical.",
  };

  it("carries a label, an op and a reason — and REFUSES a proposed value", () => {
    expect(lifecycleSuggestionSchema.safeParse(chip).success).toBe(true);
    // The chip annotates the target beside it. A patch VALUE on the wire would
    // make the chip row a second, unauthorized projection of the document.
    expect(
      lifecycleSuggestionSchema.safeParse({ ...chip, value: "Q3 re-engagement" }).success,
    ).toBe(false);
  });

  it("accepts a RECORDED mark and refuses an unknown one", () => {
    expect(lifecycleSuggestionSchema.safeParse({ ...chip, mark: "accepted" }).success).toBe(true);
    expect(lifecycleSuggestionSchema.safeParse({ ...chip, mark: "dismissed" }).success).toBe(true);
    expect(lifecycleSuggestionSchema.safeParse({ ...chip, mark: "applied" }).success).toBe(false);
  });

  it("bounds the id, the label and the message", () => {
    expect(
      lifecycleSuggestionSchema.safeParse({
        ...chip,
        id: "x".repeat(LIFECYCLE_SUGGESTION_ID_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      lifecycleSuggestionSchema.safeParse({
        ...chip,
        label: "x".repeat(LIFECYCLE_SUGGESTION_LABEL_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      lifecycleSuggestionSchema.safeParse({
        ...chip,
        message: "x".repeat(LIFECYCLE_SUGGESTION_MESSAGE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("refuses an op outside the producer's vocabulary", () => {
    expect(lifecycleSuggestionSchema.safeParse({ ...chip, op: "delete" }).success).toBe(false);
  });
});

describe("§VIII the chips ride only the states that can carry a mark", () => {
  const chip = { id: "s1", label: "subject", op: "replace" as const, message: "Not canonical." };

  it("pending / restricted / settled accept them", () => {
    expect(
      lifecycleCardStateSchema.safeParse({
        state: "pending",
        canDecide: true,
        canComment: true,
        suggestions: [chip],
      }).success,
    ).toBe(true);
    expect(
      lifecycleCardStateSchema.safeParse({
        state: "restricted",
        canDecide: false,
        canComment: true,
        reason: "Approving or rejecting needs approve access on this run.",
        suggestions: [chip],
      }).success,
    ).toBe(true);
    expect(
      lifecycleCardStateSchema.safeParse({
        state: "settled",
        suggestions: [{ ...chip, mark: "accepted" }],
      }).success,
    ).toBe(true);
  });

  it("loading / advisory / absent CANNOT — a card with no floor has nowhere to put a mark", () => {
    for (const state of ["loading", "advisory", "absent"]) {
      expect(lifecycleCardStateSchema.safeParse({ state, suggestions: [chip] }).success).toBe(false);
    }
  });

  it("the pre-#2572 states still parse byte-identically (additive, optional)", () => {
    expect(
      lifecycleCardStateSchema.parse({ state: "pending", canDecide: true, canComment: false }),
    ).toEqual({ state: "pending", canDecide: true, canComment: false });
    expect(lifecycleCardStateSchema.parse({ state: "settled" })).toEqual({ state: "settled" });
  });

  it("bounds the number of chips a card may be told to draw", () => {
    const many = Array.from({ length: MAX_LIFECYCLE_SUGGESTIONS + 1 }, (_, i) => ({
      ...chip,
      id: `s${i}`,
    }));
    expect(
      lifecycleCardStateSchema.safeParse({
        state: "pending",
        canDecide: true,
        canComment: true,
        suggestions: many,
      }).success,
    ).toBe(false);
  });
});

describe("§VIII the label is the pointer, read the way the drawing joins it", () => {
  it("joins the pointer's segments with the drawing's middot", () => {
    expect(lifecycleSuggestionLabel("/items/1/subject")).toBe("items · 1 · subject");
    expect(lifecycleSuggestionLabel("/subject")).toBe("subject");
  });

  it("unescapes RFC 6901 (~1 → /, ~0 → ~)", () => {
    expect(lifecycleSuggestionLabel("/a~1b/c~0d")).toBe("a/b · c~d");
  });

  it("labels the whole-document pointer rather than drawing a blank chip", () => {
    expect(lifecycleSuggestionLabel("")).toBe("the whole document");
    expect(lifecycleSuggestionLabel("/")).toBe("the whole document");
  });

  it("truncates rather than letting a pathological pointer break the bound", () => {
    const label = lifecycleSuggestionLabel(`/${"x".repeat(500)}`);
    expect(label.length).toBeLessThanOrEqual(LIFECYCLE_SUGGESTION_LABEL_MAX_LENGTH);
    expect(lifecycleSuggestionSchema.safeParse({ id: "s", label, op: "add", message: "m" }).success).toBe(
      true,
    );
  });
});

describe("§VIII the projection", () => {
  const produced = [
    { id: "s1", fieldPath: "/subject", op: "replace", message: "Not canonical." },
    { id: "s2", fieldPath: "/items/0/bcc", op: "remove", message: "Every disclosed field is empty." },
  ];

  it("projects a producer row into a chip, and NEVER carries its value", () => {
    const chips = projectLifecycleSuggestions([
      { ...produced[0], value: "Q3 re-engagement" } as never,
    ]);
    expect(chips).toEqual([
      { id: "s1", label: "subject", op: "replace", message: "Not canonical." },
    ]);
    expect(JSON.stringify(chips)).not.toContain("Q3 re-engagement");
  });

  it("attaches ONLY the marks it was given — an unmarked id keeps none", () => {
    const chips = projectLifecycleSuggestions(
      produced,
      new Map([["s1", "accepted" as const]]),
    );
    expect(chips[0].mark).toBe("accepted");
    expect(chips[1].mark).toBeUndefined();
  });

  it("drops a row whose op is outside the vocabulary rather than drawing it", () => {
    expect(
      projectLifecycleSuggestions([{ id: "s", fieldPath: "/a", op: "merge", message: "m" }]),
    ).toEqual([]);
  });

  it("truncates to the card's ceiling in snapshot order", () => {
    const many = Array.from({ length: MAX_LIFECYCLE_SUGGESTIONS + 5 }, (_, i) => ({
      id: `s${i}`,
      fieldPath: "/a",
      op: "add",
      message: "m",
    }));
    const chips = projectLifecycleSuggestions(many);
    expect(chips).toHaveLength(MAX_LIFECYCLE_SUGGESTIONS);
    expect(chips[0].id).toBe("s0");
  });

  it("every projected chip satisfies the wire schema", () => {
    for (const chip of projectLifecycleSuggestions(produced)) {
      expect(lifecycleSuggestionSchema.safeParse(chip).success).toBe(true);
    }
  });
});
