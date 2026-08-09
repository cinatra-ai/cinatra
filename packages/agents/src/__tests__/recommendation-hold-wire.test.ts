/**
 * cinatra#2568 (epic #2564 S4) — the recommendation hold ON THE RUN WIRE.
 *
 * The hold already existed as a park; this slice makes it visible on the one
 * wire every surface reads. These tests pin the three properties the rest of
 * the slice depends on:
 *
 *   - the ref is OPAQUE, bounded, tamper-evident and DOMAIN-SEPARATED from the
 *     S1 gate ref (a gate ref must not decode as a hold ref, or the reverse);
 *   - the typed interrupt carries a ref and NOTHING else, and is a conforming
 *     AG-UI event so an unaware external client can still parse the frame;
 *   - the LIVE-STATE SNAPSHOT reads the PARK, never the log — a released hold
 *     synthesizes nothing, and a re-parked run synthesizes its CURRENT hold.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const recommendSkillsForAgentTask = vi.fn();
const resolveOrgPolicyRule = vi.fn();
const getAssignedSkillIdsForAgent = vi.fn();
const maybeParkCheckpoint = vi.fn();
const sweepParks = vi.fn();
const readContinuationParksForRun = vi.fn();
const resolveAssignedSkillsActorForRun = vi.fn();
const publishAgUiEvent = vi.fn();

vi.mock("@cinatra-ai/skills/recommendation-server", () => ({
  recommendSkillsForAgentTask: (...a: unknown[]) => recommendSkillsForAgentTask(...a),
}));
vi.mock("../lifecycle-policy-store", () => ({
  resolveOrgPolicyRule: (...a: unknown[]) => resolveOrgPolicyRule(...a),
  POLICY_ARTIFACT_TYPE_WILDCARD: "*",
}));
vi.mock("@/lib/agents-store", () => ({
  getAssignedSkillIdsForAgent: (...a: unknown[]) => getAssignedSkillIdsForAgent(...a),
}));
vi.mock("@/lib/agent-run-actor-resolve", () => ({
  resolveAssignedSkillsActorForRun: (...a: unknown[]) => resolveAssignedSkillsActorForRun(...a),
}));
vi.mock("../lifecycle-continuation-park-store", () => ({
  maybeParkCheckpoint: (...a: unknown[]) => maybeParkCheckpoint(...a),
  sweepParks: (...a: unknown[]) => sweepParks(...a),
  readContinuationParksForRun: (...a: unknown[]) => readContinuationParksForRun(...a),
}));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({
  publishAgUiEvent: (...a: unknown[]) => publishAgUiEvent(...a),
}));

import { isAgUiEvent } from "@cinatra-ai/agent-ui-protocol/stream";
import { readLifecycleInterruptInteraction } from "@cinatra-ai/agent-ui-protocol/renderable-views";

import {
  RECOMMENDATION_HOLD_RENDERER_ID,
  buildRecommendationHoldInterrupt,
  buildRecommendationHoldResume,
  decodeRecommendationHoldRef,
  deriveRecommendationHoldInterrupt,
  encodeRecommendationHoldRef,
  maybeHoldRunForRecommendation,
  readRecommendationHoldFromEvent,
  recommendationHoldEventId,
  recommendationHoldThreadId,
} from "../recommendation-hold";
import {
  decodeLifecycleGateRef,
  encodeLifecycleGateRef,
} from "@/lib/lifecycle/lifecycle-card-refetch";

const SECRET = "s4-hold-wire-test-secret";
let priorSecret: string | undefined;
let priorFence: string | undefined;

beforeEach(() => {
  priorSecret = process.env.BETTER_AUTH_SECRET;
  priorFence = process.env.CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW;
  process.env.BETTER_AUTH_SECRET = SECRET;
  publishAgUiEvent.mockResolvedValue(undefined);
});

afterEach(() => {
  if (priorSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = priorSecret;
  if (priorFence === undefined) delete process.env.CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW;
  else process.env.CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW = priorFence;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The ref codec
// ---------------------------------------------------------------------------

describe("the hold ref — opaque, bounded, tamper-evident, domain-separated", () => {
  it("round-trips the run and the hold instance", () => {
    const ref = encodeRecommendationHoldRef({ runId: "run-1", holdId: "park-1" });
    expect(ref).toBeTruthy();
    expect(decodeRecommendationHoldRef(ref as string)).toEqual({
      runId: "run-1",
      holdId: "park-1",
    });
  });

  it("is OPAQUE — neither identifier is readable off the ref", () => {
    const ref = encodeRecommendationHoldRef({
      runId: "run-secret-id",
      holdId: "park-secret-id",
    }) as string;
    expect(ref).not.toContain("run-secret-id");
    expect(ref).not.toContain("park-secret-id");
    expect(Buffer.from(ref, "base64url").toString("utf8")).not.toContain("run-secret");
  });

  it("stays inside the wire bound so a truncated envelope cannot mint a card", () => {
    const ref = encodeRecommendationHoldRef({
      runId: "r".repeat(120),
      holdId: "p".repeat(120),
    }) as string;
    expect(ref.length).toBeLessThanOrEqual(512);
  });

  it("refuses to mint without an app secret (fail-closed, no half-ref)", () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(encodeRecommendationHoldRef({ runId: "run-1", holdId: "park-1" })).toBeNull();
  });

  it("does not decode under a DIFFERENT secret (a rotated key retires refs)", () => {
    const ref = encodeRecommendationHoldRef({ runId: "run-1", holdId: "park-1" }) as string;
    process.env.BETTER_AUTH_SECRET = "some-other-secret";
    expect(decodeRecommendationHoldRef(ref)).toBeNull();
  });

  it("rejects a TAMPERED ref", () => {
    const ref = encodeRecommendationHoldRef({ runId: "run-1", holdId: "park-1" }) as string;
    const flipped = `${ref.slice(0, -2)}${ref.slice(-2) === "AA" ? "AB" : "AA"}`;
    expect(decodeRecommendationHoldRef(flipped)).toBeNull();
  });

  it("rejects garbage and non-base64url shapes without throwing", () => {
    expect(decodeRecommendationHoldRef("")).toBeNull();
    expect(decodeRecommendationHoldRef("not a ref!!")).toBeNull();
    expect(decodeRecommendationHoldRef("x".repeat(1000))).toBeNull();
  });

  it("is DOMAIN-SEPARATED from the S1 gate ref — neither decodes as the other", () => {
    // Same instance, same app secret: the only thing keeping a gate ref from
    // being replayed as a hold ref (or the reverse) is the domain separation.
    const gateRef = encodeLifecycleGateRef({ runId: "run-1", reviewTaskId: "gate-1" });
    expect(gateRef).toBeTruthy();
    expect(decodeRecommendationHoldRef(gateRef as string)).toBeNull();

    const holdRef = encodeRecommendationHoldRef({ runId: "run-1", holdId: "park-1" }) as string;
    expect(decodeLifecycleGateRef(holdRef)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The typed interrupt
// ---------------------------------------------------------------------------

describe("the typed hold INTERRUPT — a ref and nothing else", () => {
  it("is a conforming AG-UI event carrying the declared interaction kind", () => {
    const event = buildRecommendationHoldInterrupt({
      runId: "run-1",
      threadId: "tpl-1",
      holdId: "park-1",
    });
    expect(event).not.toBeNull();
    expect(isAgUiEvent(event)).toBe(true);
    expect(event!.type).toBe("INTERRUPT");
    expect(event!.xRenderer).toBe(RECOMMENDATION_HOLD_RENDERER_ID);
    expect(readLifecycleInterruptInteraction(event)).toMatchObject({
      kind: "recommendation_hold",
      schemaVersion: 1,
    });
  });

  it("carries NO content — empty schema, empty values, no candidate data", () => {
    const event = buildRecommendationHoldInterrupt({
      runId: "run-1",
      threadId: "tpl-1",
      holdId: "park-1",
    })!;
    expect(event.schema).toEqual({});
    expect(event.values).toEqual({});
    // The whole frame must not carry the hold's identifiers in the clear.
    expect(JSON.stringify(event)).not.toContain("park-1");
  });

  it("names the hold's stable per-run gate identity, not a review-task row", () => {
    const event = buildRecommendationHoldInterrupt({
      runId: "run-1",
      threadId: "tpl-1",
      holdId: "park-1",
    })!;
    expect(event.reviewTaskId).toBe(recommendationHoldEventId("run-1"));
    expect(event.reviewTaskId).toBe("recommendation:run-start:run-1");
  });

  it("mints NOTHING when no ref can be produced (a card that cannot refetch)", () => {
    delete process.env.BETTER_AUTH_SECRET;
    expect(
      buildRecommendationHoldInterrupt({ runId: "run-1", threadId: "t", holdId: "p" }),
    ).toBeNull();
  });

  it("the paired RESUME names the same gate identity", () => {
    const resume = buildRecommendationHoldResume({ runId: "run-1", threadId: "tpl-1" });
    expect(isAgUiEvent(resume)).toBe(true);
    expect(resume.reviewTaskId).toBe(recommendationHoldEventId("run-1"));
  });

  it("threads on the run's template, exactly like the execution adapter", () => {
    expect(recommendationHoldThreadId({ id: "run-1", templateId: "tpl-1" })).toBe("tpl-1");
    expect(recommendationHoldThreadId({ id: "run-1", templateId: null })).toBe("run-1");
    expect(recommendationHoldThreadId({ id: "run-1" })).toBe("run-1");
  });
});

describe("readRecommendationHoldFromEvent — the stale/foreign discriminator", () => {
  it("reads the hold identity off this run's own hold interrupt", () => {
    const event = buildRecommendationHoldInterrupt({
      runId: "run-1",
      threadId: "tpl-1",
      holdId: "park-7",
    })!;
    expect(readRecommendationHoldFromEvent(event, "run-1")).toEqual({
      runId: "run-1",
      holdId: "park-7",
    });
  });

  it("REJECTS a hold ref minted for another run (a cross-run replay)", () => {
    const event = buildRecommendationHoldInterrupt({
      runId: "run-other",
      threadId: "tpl-1",
      holdId: "park-7",
    })!;
    expect(readRecommendationHoldFromEvent(event, "run-1")).toBeNull();
  });

  it("returns null for an ordinary review-task interrupt", () => {
    expect(
      readRecommendationHoldFromEvent(
        {
          type: "INTERRUPT",
          threadId: "t",
          runId: "run-1",
          schema: {},
          xRenderer: "some-renderer",
          values: {},
          reviewTaskId: "rt-1",
        },
        "run-1",
      ),
    ).toBeNull();
  });

  it("returns null when the discriminator is present but the ref is forged", () => {
    expect(
      readRecommendationHoldFromEvent(
        {
          type: "INTERRUPT",
          threadId: "t",
          runId: "run-1",
          schema: {},
          xRenderer: RECOMMENDATION_HOLD_RENDERER_ID,
          values: {},
          reviewTaskId: "x",
          interaction: { kind: "recommendation_hold", schemaVersion: 1, ref: "forged" },
        },
        "run-1",
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The live-state snapshot
// ---------------------------------------------------------------------------

describe("deriveRecommendationHoldInterrupt — the PARK is the authority", () => {
  it("synthesizes the CURRENT hold for a parked run", async () => {
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-current", checkpoint: "recommendation", status: "parked" },
    ]);
    const event = await deriveRecommendationHoldInterrupt({
      runId: "run-1",
      threadId: "tpl-1",
    });
    expect(readRecommendationHoldFromEvent(event, "run-1")).toEqual({
      runId: "run-1",
      holdId: "park-current",
    });
  });

  it("synthesizes NOTHING once the hold is released — however old the log is", async () => {
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-1", checkpoint: "recommendation", status: "released" },
    ]);
    expect(
      await deriveRecommendationHoldInterrupt({ runId: "run-1", threadId: "tpl-1" }),
    ).toBeNull();
  });

  it("synthesizes nothing when the run was never held", async () => {
    readContinuationParksForRun.mockResolvedValue([]);
    expect(
      await deriveRecommendationHoldInterrupt({ runId: "run-1", threadId: "tpl-1" }),
    ).toBeNull();
  });

  it("a RE-PARKED run resolves to its NEW hold, not the decided one", async () => {
    // The park store returns the run's live recommendation park; the previous
    // hold's frames may still sit in the durable log. The snapshot follows the
    // park, so the identity a late joiner reconstructs is the current one.
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-2", checkpoint: "recommendation", status: "parked" },
    ]);
    const event = await deriveRecommendationHoldInterrupt({
      runId: "run-1",
      threadId: "tpl-1",
    });
    expect(readRecommendationHoldFromEvent(event, "run-1")?.holdId).toBe("park-2");
  });

  it("degrades to null (no card) when the park read throws", async () => {
    readContinuationParksForRun.mockRejectedValue(new Error("store down"));
    expect(
      await deriveRecommendationHoldInterrupt({ runId: "run-1", threadId: "tpl-1" }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The producer: announce a NEW hold, never a re-announced one
// ---------------------------------------------------------------------------

describe("maybeHoldRunForRecommendation — announces the hold it creates", () => {
  const run = {
    id: "run-1",
    orgId: "org-1",
    humanPresent: true as const,
    inputParams: { prompt: "write a post" },
    runBy: "user-1",
    templateId: "tpl-1",
  };
  const template = { packageName: "@acme/agent", lifecycleConfig: null };

  beforeEach(() => {
    readContinuationParksForRun.mockResolvedValue([]);
    resolveOrgPolicyRule.mockResolvedValue({ bound: "silent" });
    resolveAssignedSkillsActorForRun.mockResolvedValue(undefined);
    getAssignedSkillIdsForAgent.mockResolvedValue(["s1"]);
    recommendSkillsForAgentTask.mockResolvedValue([
      {
        skillId: "s1",
        skillRevisionId: "s1@rev1",
        name: "Skill One",
        score: 0.9,
        rank: 1,
        recommended: true,
        scoredFeatures: [],
      },
    ]);
    maybeParkCheckpoint.mockResolvedValue({ parked: true, parkId: "park-new" });
  });

  it("publishes the typed interrupt for a NEWLY created park", async () => {
    const res = await maybeHoldRunForRecommendation({ run, template });
    expect(res.held).toBe(true);
    expect(publishAgUiEvent).toHaveBeenCalledTimes(1);
    const [runId, event] = publishAgUiEvent.mock.calls[0];
    expect(runId).toBe("run-1");
    expect(readRecommendationHoldFromEvent(event, "run-1")).toEqual({
      runId: "run-1",
      holdId: "park-new",
    });
    expect((event as { threadId: string }).threadId).toBe("tpl-1");
  });

  it("does NOT re-announce a hold the human is already looking at", async () => {
    readContinuationParksForRun.mockResolvedValue([
      { id: "park-live", checkpoint: "recommendation", status: "parked" },
    ]);
    const res = await maybeHoldRunForRecommendation({ run, template });
    expect(res).toMatchObject({ held: true, parkId: "park-live" });
    expect(publishAgUiEvent).not.toHaveBeenCalled();
  });

  it("announces nothing for a HEADLESS run — it never parks (regression)", async () => {
    const res = await maybeHoldRunForRecommendation({
      run: { ...run, humanPresent: false },
      template,
    });
    expect(res.held).toBe(false);
    expect(maybeParkCheckpoint).not.toHaveBeenCalled();
    expect(publishAgUiEvent).not.toHaveBeenCalled();
  });

  it("a wire failure never fails the hold — the park still holds the run", async () => {
    publishAgUiEvent.mockRejectedValue(new Error("redis down"));
    const res = await maybeHoldRunForRecommendation({ run, template });
    expect(res).toMatchObject({ held: true, parkId: "park-new" });
  });
});
