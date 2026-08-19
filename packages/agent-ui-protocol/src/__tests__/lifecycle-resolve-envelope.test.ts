// The per-kind RESOLVE ENVELOPE (epic S9, slice S9c).
//
// A lifecycle card asks for one kind and must be able to trust that it got an
// answer to THAT question. This suite pins the contract that makes the trust
// checkable: each kind round-trips its own authorized body, an unknown or
// undeclared kind fails closed, `absent` carries no body on any path, and the
// recommendation hold is structurally outside this envelope.

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_CARD_CARRIAGE,
  LIFECYCLE_DATA_PART_VIEW_TYPES,
  LIFECYCLE_INTERRUPT_KINDS,
  VERIFICATION_SUMMARY_MAX_FIELD_DIFF,
  VERIFICATION_SUMMARY_MAX_SCOPE_PATHS,
  VERIFICATION_SUMMARY_PATH_MAX_LENGTH,
  VERIFICATION_SUMMARY_VALUE_MAX_LENGTH,
  VERIFICATION_SUMMARY_VIEW_VERSION,
  parseLifecycleResolveEnvelope,
  verificationSummaryBodySchema,
  type LifecycleCardBodyByKind,
  type LifecycleDataPartViewType,
  type LifecycleResolveEnvelope,
  type VerificationSummaryBody,
} from "../renderable-views/lifecycle-cards";
import {
  TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION,
  type TriggerScheduleProposalViewBody,
} from "../renderable-views/trigger-schedule-proposal-view";

const VERIFICATION_BODY: VerificationSummaryBody = {
  version: VERIFICATION_SUMMARY_VIEW_VERSION,
  outcome: "drifted",
  reviewedRevisionId: "rev-base",
  repairedRevisionId: "rev-fixed",
  scopePaths: ["content.title", "content.body"],
  fieldDiff: [
    { field: "content.title", before: "old", after: "new" },
    { field: "content.slug", before: null, after: "new-slug" },
  ],
};

const SCHEDULE_PENDING_BODY: TriggerScheduleProposalViewBody = {
  phase: "proposal",
  version: TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION,
  agentName: "Weekly digest",
  schedule: { kind: "scheduled", runAt: "2026-09-01T09:00", timezone: "Europe/Berlin" },
  durationCopy: "About 45s – 3.4 hr.",
  canConfirm: true,
  restrictedReason: null,
};

const SCHEDULE_SETTLED_BODY: TriggerScheduleProposalViewBody = {
  phase: "settled",
  version: TRIGGER_SCHEDULE_PROPOSAL_VIEW_VERSION,
  agentName: "Weekly digest",
  runId: "run-1",
  triggerType: "recurring",
  scheduleCopy: "Every weekday at 9:00 AM",
  timezone: "Europe/Berlin",
  gatedSteps: [],
  released: false,
  canCancel: true,
  canRelease: false,
  arming: false,
};

// ---------------------------------------------------------------------------
// Each kind round-trips its OWN body
// ---------------------------------------------------------------------------

describe("each kind round-trips the body it is authorized to carry", () => {
  it("artifact_review_gate carries state and NO body", () => {
    const wire = {
      kind: "artifact_review_gate",
      state: { state: "pending", canDecide: true, canComment: true },
      body: null,
    };
    const parsed = parseLifecycleResolveEnvelope("artifact_review_gate", wire);
    expect(parsed).toEqual(wire);
    // The type map says so too: a review body is `null`, not a shape.
    const declared: LifecycleCardBodyByKind["artifact_review_gate"] = null;
    expect(declared).toBeNull();
  });

  it("verification_summary round-trips its §VII reading beside `advisory`", () => {
    const wire = {
      kind: "verification_summary",
      state: { state: "advisory" },
      body: VERIFICATION_BODY,
    };
    const parsed = parseLifecycleResolveEnvelope("verification_summary", wire);
    expect(parsed).not.toBeNull();
    expect(parsed!.state).toEqual({ state: "advisory" });
    expect(parsed!.body).toEqual(VERIFICATION_BODY);
    // Through JSON, which is the trip the wire actually takes.
    expect(
      parseLifecycleResolveEnvelope(
        "verification_summary",
        JSON.parse(JSON.stringify(wire)),
      ),
    ).toEqual(wire);
  });

  it("trigger_schedule_proposal round-trips both §VI phases", () => {
    for (const [state, body] of [
      [{ state: "pending", canDecide: true, canComment: false }, SCHEDULE_PENDING_BODY],
      [{ state: "settled" }, SCHEDULE_SETTLED_BODY],
    ] as const) {
      const wire = { kind: "trigger_schedule_proposal", state, body };
      expect(
        parseLifecycleResolveEnvelope(
          "trigger_schedule_proposal",
          JSON.parse(JSON.stringify(wire)),
        ),
      ).toEqual(wire);
    }
  });

  it("every DATA_PART kind has an envelope arm — the registry is total", () => {
    // A kind added to the closed set without an arm here would parse to nothing,
    // so the card would never draw. The assertion is that no kind is missing.
    for (const kind of LIFECYCLE_DATA_PART_VIEW_TYPES) {
      const parsed = parseLifecycleResolveEnvelope(kind, {
        kind,
        state: { state: "absent" },
        body: null,
      });
      expect(parsed, kind).not.toBeNull();
      expect(parsed!.kind).toBe(kind);
    }
  });
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

describe("an unknown or undeclared kind fails closed", () => {
  it("refuses a kind that is not a declared DATA_PART view type", () => {
    expect(
      parseLifecycleResolveEnvelope("something_new" as LifecycleDataPartViewType, {
        kind: "something_new",
        state: { state: "pending", canDecide: true, canComment: true },
        body: null,
      }),
    ).toBeNull();
  });

  it("refuses an answer to a DIFFERENT kind than the one asked for", () => {
    expect(
      parseLifecycleResolveEnvelope("artifact_review_gate", {
        kind: "verification_summary",
        state: { state: "advisory" },
        body: VERIFICATION_BODY,
      }),
    ).toBeNull();
  });

  it("refuses a missing, non-string or non-object envelope", () => {
    for (const raw of [
      null,
      undefined,
      42,
      "artifact_review_gate",
      [],
      {},
      { state: { state: "settled" } },
      { kind: "artifact_review_gate" },
    ]) {
      expect(
        parseLifecycleResolveEnvelope("artifact_review_gate", raw),
      ).toBeNull();
    }
  });

  it("refuses a state the ladder does not define", () => {
    for (const state of [
      { state: "approved" },
      { state: "pending", canDecide: false, canComment: true },
      { state: "restricted", canDecide: false, canComment: true },
      "pending",
      null,
    ]) {
      expect(
        parseLifecycleResolveEnvelope("artifact_review_gate", {
          kind: "artifact_review_gate",
          state,
          body: null,
        }),
      ).toBeNull();
    }
  });

  it("refuses a body that does not validate against its kind's schema", () => {
    expect(
      parseLifecycleResolveEnvelope("verification_summary", {
        kind: "verification_summary",
        state: { state: "advisory" },
        body: { ...VERIFICATION_BODY, outcome: "who-knows" },
      }),
    ).toBeNull();
    // Strictness is the "nothing extra rides the wire" guarantee.
    expect(
      parseLifecycleResolveEnvelope("verification_summary", {
        kind: "verification_summary",
        state: { state: "advisory" },
        body: { ...VERIFICATION_BODY, artifactId: "art-1" },
      }),
    ).toBeNull();
  });

  it("refuses a body OVER the contract's ceilings", () => {
    const over = {
      ...VERIFICATION_BODY,
      scopePaths: Array.from(
        { length: VERIFICATION_SUMMARY_MAX_SCOPE_PATHS + 1 },
        () => "p",
      ),
    };
    expect(verificationSummaryBodySchema.safeParse(over).success).toBe(false);
    expect(
      parseLifecycleResolveEnvelope("verification_summary", {
        kind: "verification_summary",
        state: { state: "advisory" },
        body: over,
      }),
    ).toBeNull();

    for (const body of [
      {
        ...VERIFICATION_BODY,
        fieldDiff: Array.from(
          { length: VERIFICATION_SUMMARY_MAX_FIELD_DIFF + 1 },
          () => ({ field: "f", before: null, after: null }),
        ),
      },
      {
        ...VERIFICATION_BODY,
        scopePaths: ["p".repeat(VERIFICATION_SUMMARY_PATH_MAX_LENGTH + 1)],
      },
      {
        ...VERIFICATION_BODY,
        fieldDiff: [
          {
            field: "f",
            before: "b".repeat(VERIFICATION_SUMMARY_VALUE_MAX_LENGTH + 1),
            after: null,
          },
        ],
      },
    ]) {
      expect(
        parseLifecycleResolveEnvelope("verification_summary", {
          kind: "verification_summary",
          state: { state: "advisory" },
          body,
        }),
      ).toBeNull();
    }
  });

  it("refuses a body-carrying kind whose body is missing", () => {
    for (const body of [null, undefined]) {
      expect(
        parseLifecycleResolveEnvelope("verification_summary", {
          kind: "verification_summary",
          state: { state: "advisory" },
          body,
        }),
      ).toBeNull();
      expect(
        parseLifecycleResolveEnvelope("trigger_schedule_proposal", {
          kind: "trigger_schedule_proposal",
          state: { state: "settled" },
          body,
        }),
      ).toBeNull();
    }
  });

  it("refuses a body on the kind that carries none", () => {
    expect(
      parseLifecycleResolveEnvelope("artifact_review_gate", {
        kind: "artifact_review_gate",
        state: { state: "settled" },
        body: VERIFICATION_BODY,
      }),
    ).toBeNull();
  });

  it("never throws, whatever the payload does", () => {
    const hostile = {
      get kind(): string {
        throw new Error("hostile");
      },
    };
    expect(() =>
      parseLifecycleResolveEnvelope("artifact_review_gate", hostile),
    ).not.toThrow();
    expect(parseLifecycleResolveEnvelope("artifact_review_gate", hostile)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// `absent` privacy
// ---------------------------------------------------------------------------

describe("`absent` reveals nothing about the target", () => {
  it("parses for every kind, and carries no body", () => {
    for (const kind of LIFECYCLE_DATA_PART_VIEW_TYPES) {
      const parsed = parseLifecycleResolveEnvelope(kind, {
        kind,
        state: { state: "absent" },
        body: null,
      });
      expect(parsed, kind).toEqual({ kind, state: { state: "absent" }, body: null });
      // The body key may also be omitted entirely — same answer, byte for byte.
      expect(
        parseLifecycleResolveEnvelope(kind, { kind, state: { state: "absent" } }),
        kind,
      ).toEqual({ kind, state: { state: "absent" }, body: null });
    }
  });

  it("REFUSES an `absent` that arrives with a body", () => {
    // A dropped body would be forgiving; a refusal is honest. A producer that
    // attached one is a producer whose other answers cannot be trusted either.
    expect(
      parseLifecycleResolveEnvelope("verification_summary", {
        kind: "verification_summary",
        state: { state: "absent" },
        body: VERIFICATION_BODY,
      }),
    ).toBeNull();
    expect(
      parseLifecycleResolveEnvelope("trigger_schedule_proposal", {
        kind: "trigger_schedule_proposal",
        state: { state: "absent" },
        body: SCHEDULE_SETTLED_BODY,
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The recommendation hold is OUTSIDE this envelope
// ---------------------------------------------------------------------------

describe("the recommendation hold stays outside the DATA_PART envelope", () => {
  it("is the sole typed-interrupt kind, so it never rides this resolve", () => {
    expect(LIFECYCLE_CARD_CARRIAGE.recommendation_hold).toBe("interrupt");
    expect(LIFECYCLE_INTERRUPT_KINDS).toEqual(["recommendation_hold"]);
    expect(LIFECYCLE_DATA_PART_VIEW_TYPES).not.toContain("recommendation_hold");
  });

  it("has no envelope arm — asking for it fails closed", () => {
    expect(
      parseLifecycleResolveEnvelope(
        "recommendation_hold" as unknown as LifecycleDataPartViewType,
        {
          kind: "recommendation_hold",
          state: { state: "pending", canDecide: true, canComment: false },
          body: null,
        },
      ),
    ).toBeNull();
  });

  it("is absent from the envelope's kind union at the TYPE level", () => {
    // A `kind` the envelope does not declare does not compile as one. The
    // assignment below is the compile-time half of the runtime check above.
    const kinds: LifecycleResolveEnvelope["kind"][] = [
      "artifact_review_gate",
      "verification_summary",
      "trigger_schedule_proposal",
    ];
    expect(kinds).toEqual([...LIFECYCLE_DATA_PART_VIEW_TYPES]);
    // @ts-expect-error — the hold is not a DATA_PART envelope kind.
    const forbidden: LifecycleResolveEnvelope["kind"] = "recommendation_hold";
    expect(forbidden).toBe("recommendation_hold");
  });

  // -------------------------------------------------------------------------
  // The explicit REJECTION fixture
  // -------------------------------------------------------------------------
  //
  // Being unrouted is not the same as being refused. A kind that no arm happens
  // to handle today can start being handled by accident tomorrow; a kind the
  // parse REFUSES stays refused until somebody deletes the refusal. The hold is
  // the second kind, and these are the four ways an envelope could try to claim
  // it.

  it("REFUSES an envelope claiming the hold, whatever kind was asked for", () => {
    const claiming = {
      kind: "recommendation_hold",
      state: { state: "pending", canDecide: true, canComment: false },
      body: null,
    };
    // Asked for as itself.
    expect(
      parseLifecycleResolveEnvelope(
        "recommendation_hold" as unknown as LifecycleDataPartViewType,
        claiming,
      ),
    ).toBeNull();
    // Asked for as any DECLARED kind — the hold cannot ride in on another
    // kind's request, which is the shape a confused producer would take.
    for (const asked of LIFECYCLE_DATA_PART_VIEW_TYPES) {
      expect(parseLifecycleResolveEnvelope(asked, claiming), asked).toBeNull();
    }
  });

  it("REFUSES the hold on every state the ladder defines, and with any body", () => {
    // The refusal is on the KIND. It does not depend on the state being
    // undrawable, or on the body being absent — an `absent` hold and a hold
    // carrying somebody else's authorized body are refused alike.
    const states = [
      { state: "loading" },
      { state: "pending", canDecide: true, canComment: false },
      { state: "restricted", canDecide: false, canComment: false, reason: "no" },
      { state: "settled" },
      { state: "advisory" },
      { state: "absent" },
    ];
    for (const state of states) {
      for (const body of [null, undefined, VERIFICATION_BODY, SCHEDULE_SETTLED_BODY]) {
        expect(
          parseLifecycleResolveEnvelope(
            "recommendation_hold" as unknown as LifecycleDataPartViewType,
            { kind: "recommendation_hold", state, body },
          ),
          `${state.state}`,
        ).toBeNull();
      }
    }
  });

  it("has NO body schema of its own — the registry cannot grow one by accident", () => {
    // The registry is keyed by the DATA_PART kinds, so the hold has no entry to
    // fill. If a later slice adds one, this fails and names the slice that must
    // instead be extending the hold's own resolver.
    const declared = [...LIFECYCLE_DATA_PART_VIEW_TYPES].sort();
    expect(declared).toEqual([
      "artifact_review_gate",
      "trigger_schedule_proposal",
      "verification_summary",
    ]);
    expect(declared).not.toContain("recommendation_hold");
  });
});
