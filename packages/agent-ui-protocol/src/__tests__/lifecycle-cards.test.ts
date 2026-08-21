// The lifecycle CARD registry — spec conformance + wire invariants
// (cinatra#2565, epic #2564 S1).
// Design: design@6c20871b4108176c1d0193f19ecd2947f6c6355f
// `specs/app-lifecycle-cards.html` at that commit.

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_CARD_CARRIAGE,
  LIFECYCLE_CARD_HOSTS,
  LIFECYCLE_CARD_KINDS,
  LIFECYCLE_CARD_STATES,
  LIFECYCLE_DATA_PART_VIEW_TYPES,
  LIFECYCLE_DECIDER_NAME_MAX_LENGTH,
  LIFECYCLE_REVIEW_CARD_STATES,
  LIFECYCLE_SETTLED_OUTCOMES,
  LIFECYCLE_SUGGESTION_ID_MAX_LENGTH,
  LIFECYCLE_SUGGESTION_LABEL_MAX_LENGTH,
  LIFECYCLE_SUGGESTION_MESSAGE_MAX_LENGTH,
  LIFECYCLE_VIEW_REF_MAX_LENGTH,
  LIFECYCLE_VIEW_SCHEMA_VERSION,
  LIFECYCLE_SUGGESTION_VALUE_MAX_LENGTH,
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

describe("SURFACE PARITY — every host draws every card (owner ruling 2026-08-11)", () => {
  it("advertises the SAME lifecycle view set for the widget as for first-party chat", () => {
    // The corrected #2577 deliverable, stated as an equality rather than as two
    // lists that happen to match today: whatever first-party chat resolves, the
    // widget resolves. A reduction would have to break this line.
    expect([...lifecycleViewTypesForHost("site_widget")].sort()).toEqual(
      [...lifecycleViewTypesForHost("chat_thread")].sort(),
    );
  });

  it("gives EVERY host the whole DATA_PART set — no per-surface subset survives", () => {
    const whole = [...LIFECYCLE_DATA_PART_VIEW_TYPES].sort();
    expect(whole).toEqual([
      "artifact_review_gate",
      "trigger_schedule_proposal",
      "verification_summary",
    ]);
    for (const host of LIFECYCLE_CARD_HOSTS) {
      expect([...lifecycleViewTypesForHost(host)].sort()).toEqual(whole);
    }
  });

  it("keeps the recommendation hold off the advertised set on EVERY host — carriage, not restriction", () => {
    // The one kind absent from every host's list, and for a reason that is not a
    // surface rule: it rides an INTERRUPT, so it has no advertised viewType
    // anywhere. Pinned so a future reader cannot mistake this absence for the
    // per-surface matrix that was removed.
    for (const host of LIFECYCLE_CARD_HOSTS) {
      expect(lifecycleViewTypesForHost(host)).not.toContain("recommendation_hold");
    }
    expect(LIFECYCLE_CARD_CARRIAGE.recommendation_hold).toBe("interrupt");
  });

  it("exports no per-(kind, host) presence table at all", async () => {
    // The negative control for the correction. A table whose cells are all true
    // is a place for a reduction to hide, so the module must not carry one.
    const mod: Record<string, unknown> = await import(
      "../renderable-views/lifecycle-cards"
    );
    expect(Object.keys(mod)).not.toContain("LIFECYCLE_CARD_PRESENCE");
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

  it("projects a producer row into a chip, CARRYING §VIII's before/after pair", () => {
    const chips = projectLifecycleSuggestions([
      { ...produced[0], before: "Re-connecting on Q3 priorities  ", value: "Re-connecting on Q3 priorities" },
    ]);
    expect(chips).toEqual([
      {
        id: "s1",
        label: "subject",
        op: "replace",
        message: "Not canonical.",
        before: "Re-connecting on Q3 priorities  ",
        after: "Re-connecting on Q3 priorities",
      },
    ]);
  });

  it("a row with NO values projects the label + class chip and nothing else", () => {
    // The negative control. A snapshot written before the pair existed, a
    // `remove` (no one value), and an `add` of the empty string all land here —
    // absence is not a signal, and an empty panel would claim a blank change.
    expect(projectLifecycleSuggestions([produced[1]])).toEqual([
      {
        id: "s2",
        label: "items · 0 · bcc",
        op: "remove",
        message: "Every disclosed field is empty.",
      },
    ]);
    expect(
      projectLifecycleSuggestions([{ ...produced[0], before: "   ", value: "" }])[0],
    ).toEqual({ id: "s1", label: "subject", op: "replace", message: "Not canonical." });
  });

  it("CLAMPS an over-long side rather than dropping the panel", () => {
    const long = "x".repeat(LIFECYCLE_SUGGESTION_VALUE_MAX_LENGTH + 200);
    const [chip] = projectLifecycleSuggestions([{ ...produced[0], before: long, value: long }]);
    expect(chip.before).toHaveLength(LIFECYCLE_SUGGESTION_VALUE_MAX_LENGTH);
    expect(chip.after?.endsWith("…")).toBe(true);
    expect(lifecycleSuggestionSchema.safeParse(chip).success).toBe(true);
  });

  it("the schema REFUSES a side past the bound, and an empty one", () => {
    const base = { id: "s", label: "l", op: "replace" as const, message: "m" };
    expect(
      lifecycleSuggestionSchema.safeParse({
        ...base,
        before: "x".repeat(LIFECYCLE_SUGGESTION_VALUE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(lifecycleSuggestionSchema.safeParse({ ...base, after: "" }).success).toBe(false);
    // …and ROUND-TRIPS a legal pair unchanged.
    const pair = { ...base, before: "now", after: "next" };
    expect(lifecycleSuggestionSchema.parse(pair)).toEqual(pair);
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

// ---------------------------------------------------------------------------
// The SETTLED READING (cinatra#2855; plan §4.2)
// ---------------------------------------------------------------------------

describe("a settled card carries its recorded outcome and decider", () => {
  it("declares exactly the three outcomes a RESOLVED gate row can hold", () => {
    // `approve` / `reject` from the decision core's terminal CAS,
    // `changes_requested` from the prompt-window path. A `comment` never
    // resolves a gate, so it is not an outcome a settled card can carry — and a
    // fourth value appearing here without a store that writes it would be the
    // card inventing a reading.
    expect([...LIFECYCLE_SETTLED_OUTCOMES]).toEqual([
      "approved",
      "rejected",
      "changes_requested",
    ]);
  });

  it("round-trips an outcome with its decider", () => {
    const state = {
      state: "settled",
      outcome: "approved",
      decidedByName: "Dana Okonkwo",
    };
    expect(lifecycleCardStateSchema.parse(state)).toEqual(state);
  });

  it("round-trips every outcome, with and without a decider", () => {
    for (const outcome of LIFECYCLE_SETTLED_OUTCOMES) {
      expect(lifecycleCardStateSchema.parse({ state: "settled", outcome })).toEqual({
        state: "settled",
        outcome,
      });
      expect(
        lifecycleCardStateSchema.parse({
          state: "settled",
          outcome,
          decidedByName: "R. Vale",
        }),
      ).toEqual({ state: "settled", outcome, decidedByName: "R. Vale" });
    }
  });

  it("keeps the outcome OPTIONAL — a record that predates it is still legal", () => {
    // The bare settled state is what a gate resolved before the outcome
    // travelled resolves to, and it is what a disposition this build cannot
    // read degrades to. Both must parse, because both draw the generic reading
    // the card has always drawn.
    expect(lifecycleCardStateSchema.parse({ state: "settled" })).toEqual({
      state: "settled",
    });
  });

  it("carries the outcome alongside the recorded suggestion partition", () => {
    const state = {
      state: "settled",
      outcome: "rejected",
      decidedByName: "Dana Okonkwo",
      suggestions: [
        { id: "s1", label: "content.body", op: "replace", message: "m", mark: "accepted" },
      ],
    };
    expect(lifecycleCardStateSchema.safeParse(state).success).toBe(true);
  });

  it("FAILS CLOSED on an outcome outside the closed set", () => {
    // A refused parse leaves the card with no state at all, so it draws
    // nothing — the same posture it holds before the first resolve lands. A
    // card is never talked into naming an outcome this build cannot read.
    for (const outcome of ["commented", "closed", "APPROVED", "", null, 7]) {
      expect(
        lifecycleCardStateSchema.safeParse({ state: "settled", outcome }).success,
        `${String(outcome)}`,
      ).toBe(false);
    }
  });

  it("REFUSES a decider with no outcome beside it", () => {
    // It would name a person for a decision the card cannot state.
    expect(
      lifecycleCardStateSchema.safeParse({
        state: "settled",
        decidedByName: "Dana Okonkwo",
      }).success,
    ).toBe(false);
  });

  it("REFUSES an empty or over-long decider name", () => {
    expect(
      lifecycleCardStateSchema.safeParse({
        state: "settled",
        outcome: "approved",
        decidedByName: "",
      }).success,
    ).toBe(false);
    expect(
      lifecycleCardStateSchema.safeParse({
        state: "settled",
        outcome: "approved",
        decidedByName: "n".repeat(LIFECYCLE_DECIDER_NAME_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      lifecycleCardStateSchema.safeParse({
        state: "settled",
        outcome: "approved",
        decidedByName: "n".repeat(LIFECYCLE_DECIDER_NAME_MAX_LENGTH),
      }).success,
    ).toBe(true);
  });

  it("does not let the outcome onto a state that is not settled", () => {
    // Every other arm is `.strict()`, so an outcome smuggled onto a pending or
    // restricted card is refused rather than ignored.
    expect(
      lifecycleCardStateSchema.safeParse({
        state: "pending",
        canDecide: true,
        canComment: true,
        outcome: "approved",
      }).success,
    ).toBe(false);
    expect(
      lifecycleCardStateSchema.safeParse({
        state: "absent",
        outcome: "approved",
      }).success,
    ).toBe(false);
  });
});
