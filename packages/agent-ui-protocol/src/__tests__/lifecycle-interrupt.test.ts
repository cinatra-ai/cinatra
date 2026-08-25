// ---------------------------------------------------------------------------
// The TYPED LIFECYCLE INTERRUPT discriminator (cinatra#2568, epic #2564 S4).
//
// S1 declared `recommendation_hold` as the one interaction whose carriage is
// `interrupt`. These tests pin the three properties the rest of the slice
// stands on:
//
//   1. the kind set is DERIVED from S1's carriage table, so a later kind that
//      declares `interrupt` cannot be silently left off the wire;
//   2. the discriminator is ADDITIVE AND OPTIONAL — an interrupt without it is
//      still a valid AG-UI event and the contract version does not move (that
//      is what "handshake-compatible" has to mean, not a promise in a comment);
//   3. the parse seam is total: every malformed / forged / forward-versioned
//      payload answers `null`, so a consumer degrades to today's behaviour
//      rather than mis-routing.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_CARD_CARRIAGE,
  LIFECYCLE_CARD_KINDS,
  LIFECYCLE_INTERACTION_SCHEMA_VERSION,
  LIFECYCLE_INTERRUPT_KINDS,
  LIFECYCLE_INTERRUPT_RENDERER_IDS,
  LIFECYCLE_VIEW_REF_MAX_LENGTH,
  declaresLifecycleInteraction,
  isLifecycleInterruptKind,
  lifecycleInterruptInteractionSchema,
  readLifecycleInterruptInteraction,
} from "../renderable-views/lifecycle-cards";
import { isAgUiEvent } from "../conformance";
import { ASSISTANT_STREAM_CONTRACT_VERSION } from "../contract";

const REF = "opaque-ref-bytes";

function interruptEvent(extra: Record<string, unknown> = {}) {
  return {
    type: "INTERRUPT",
    threadId: "tpl-1",
    runId: "run-1",
    schema: {},
    xRenderer: "@cinatra-ai/lifecycle:recommendation-hold",
    values: {},
    reviewTaskId: "recommendation:run-start:run-1",
    ...extra,
  };
}

function holdInteraction(over: Record<string, unknown> = {}) {
  return {
    kind: "recommendation_hold",
    schemaVersion: LIFECYCLE_INTERACTION_SCHEMA_VERSION,
    ref: REF,
    ...over,
  };
}

describe("the interrupt-carried kind set is derived, not hand-listed", () => {
  it("is exactly the kinds S1's carriage table marks `interrupt`", () => {
    const expected = LIFECYCLE_CARD_KINDS.filter(
      (kind) => LIFECYCLE_CARD_CARRIAGE[kind] === "interrupt",
    );
    expect([...LIFECYCLE_INTERRUPT_KINDS]).toEqual(expected);
    // Two kinds today, for the one reason: the run WAITS on the answer, which
    // is why neither can be a fire-and-forget DATA_PART. The hold parks the run
    // before it starts; the HITL screen parks it mid-flight (cinatra#2928).
    expect([...LIFECYCLE_INTERRUPT_KINDS].sort()).toEqual([
      "agent_hitl_screen",
      "recommendation_hold",
    ]);
  });

  it("every interrupt-carried kind declares a renderer id", () => {
    for (const kind of LIFECYCLE_INTERRUPT_KINDS) {
      expect(LIFECYCLE_INTERRUPT_RENDERER_IDS[kind]).toMatch(/^@cinatra-ai\//);
    }
  });

  it("a DATA_PART kind is never accepted as an interrupt kind", () => {
    expect(isLifecycleInterruptKind("artifact_review_gate")).toBe(false);
    expect(isLifecycleInterruptKind("recommendation_hold")).toBe(true);
    expect(isLifecycleInterruptKind(undefined)).toBe(false);
  });
});

describe("handshake compatibility — additive and optional", () => {
  it("an INTERRUPT WITHOUT the discriminator is still a valid AG-UI event", () => {
    expect(isAgUiEvent(interruptEvent())).toBe(true);
  });

  it("an INTERRUPT WITH the discriminator is a valid AG-UI event", () => {
    expect(isAgUiEvent(interruptEvent({ interaction: holdInteraction() }))).toBe(
      true,
    );
  });

  it("a RESUME accepts the same optional pairing discriminator", () => {
    const resume = {
      type: "RESUME",
      threadId: "tpl-1",
      runId: "run-1",
      reviewTaskId: "recommendation:run-start:run-1",
    };
    expect(isAgUiEvent(resume)).toBe(true);
    expect(isAgUiEvent({ ...resume, interaction: holdInteraction() })).toBe(true);
    expect(isAgUiEvent({ ...resume, interaction: "nope" })).toBe(false);
  });

  it("a non-object `interaction` is rejected by the envelope check", () => {
    expect(isAgUiEvent(interruptEvent({ interaction: "recommendation_hold" }))).toBe(
      false,
    );
    expect(isAgUiEvent(interruptEvent({ interaction: [] }))).toBe(false);
  });

  it("the contract version does NOT move for an additive optional field", () => {
    // Pinned deliberately: bumping the contract here would force every
    // negotiated stream to re-negotiate for a field that changes nothing for a
    // client that ignores it.
    expect(ASSISTANT_STREAM_CONTRACT_VERSION).toBe("1.0.0");
  });

  it("the interaction versions on the SAME line as the view payloads", () => {
    expect(LIFECYCLE_INTERACTION_SCHEMA_VERSION).toBe(1);
  });
});

describe("readLifecycleInterruptInteraction — the one parse seam", () => {
  it("returns the typed interaction for a well-formed hold interrupt", () => {
    const parsed = readLifecycleInterruptInteraction(
      interruptEvent({ interaction: holdInteraction() }),
    );
    expect(parsed).toEqual({
      kind: "recommendation_hold",
      schemaVersion: 1,
      ref: REF,
    });
  });

  it("returns null for an ordinary review-task gate (no discriminator)", () => {
    expect(readLifecycleInterruptInteraction(interruptEvent())).toBeNull();
  });

  it("returns null for an UNKNOWN kind — a forged kind mints no routing", () => {
    expect(
      readLifecycleInterruptInteraction(
        interruptEvent({ interaction: holdInteraction({ kind: "artifact_review_gate" }) }),
      ),
    ).toBeNull();
    expect(
      readLifecycleInterruptInteraction(
        interruptEvent({ interaction: holdInteraction({ kind: "totally_made_up" }) }),
      ),
    ).toBeNull();
  });

  it("returns null for a FORWARD schemaVersion (fail-closed, never guessed)", () => {
    expect(
      readLifecycleInterruptInteraction(
        interruptEvent({ interaction: holdInteraction({ schemaVersion: 2 }) }),
      ),
    ).toBeNull();
  });

  it("rejects EXTRA keys — no state may ride the wire alongside the ref", () => {
    expect(
      readLifecycleInterruptInteraction(
        interruptEvent({
          interaction: holdInteraction({ candidateSkills: ["a", "b"], canDecide: true }),
        }),
      ),
    ).toBeNull();
  });

  it("rejects an empty or oversized ref", () => {
    expect(
      readLifecycleInterruptInteraction(
        interruptEvent({ interaction: holdInteraction({ ref: "" }) }),
      ),
    ).toBeNull();
    expect(
      readLifecycleInterruptInteraction(
        interruptEvent({
          interaction: holdInteraction({
            ref: "x".repeat(LIFECYCLE_VIEW_REF_MAX_LENGTH + 1),
          }),
        }),
      ),
    ).toBeNull();
  });

  it("never throws on hostile input", () => {
    const hostile = {
      get interaction() {
        throw new Error("boom");
      },
    };
    expect(readLifecycleInterruptInteraction(hostile)).toBeNull();
    expect(readLifecycleInterruptInteraction(null)).toBeNull();
    expect(readLifecycleInterruptInteraction([])).toBeNull();
    expect(readLifecycleInterruptInteraction("INTERRUPT")).toBeNull();
  });

  it("PRESENCE is a separate, weaker question from VALIDITY", () => {
    // The rule the whole slice leans on: anything that DECLARES an interaction
    // leaves the review-task path, even when this build cannot parse it.
    // Otherwise a forward version or a forged payload fails OPEN into the
    // approval path and draws a floor for something that has none.
    const unparseable = interruptEvent({
      interaction: holdInteraction({ schemaVersion: 99 }),
    });
    expect(declaresLifecycleInteraction(unparseable)).toBe(true);
    expect(readLifecycleInterruptInteraction(unparseable)).toBeNull();

    expect(declaresLifecycleInteraction(interruptEvent())).toBe(false);
    expect(declaresLifecycleInteraction(interruptEvent({ interaction: "x" }))).toBe(false);
    expect(declaresLifecycleInteraction(null)).toBe(false);
  });

  it("a hostile shape counts as a declaration, never as a review task", () => {
    const hostile = {
      get interaction() {
        throw new Error("boom");
      },
    };
    expect(declaresLifecycleInteraction(hostile)).toBe(true);
  });

  it("the schema itself is strict about the ref bound", () => {
    expect(
      lifecycleInterruptInteractionSchema.safeParse(
        holdInteraction({ ref: "x".repeat(LIFECYCLE_VIEW_REF_MAX_LENGTH) }),
      ).success,
    ).toBe(true);
  });
});
