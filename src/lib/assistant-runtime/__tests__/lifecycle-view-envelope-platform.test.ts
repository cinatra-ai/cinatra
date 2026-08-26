// THE PLATFORM PRODUCER, BESIDE THE PULL TOOLS (cinatra#2930, epic #2926 W3).
//
// The plan: "`recognizeLifecycleViewEnvelope` … admits the platform producer
// beside the pull tools" and "The 'show me' tools the model can call stay as a
// second way to bring a card back into view, recorded as exactly that."
//
// So the two things pinned here are: the platform's tuple is admitted and comes
// back as `platform_injected`, and the tools keep working and come back as
// `tool_represented`. The refusal surface is unchanged — a widened producer set
// that also widened the refusal set would be a forging primitive.

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_PLATFORM_PRODUCER_ACT,
  LIFECYCLE_PLATFORM_PRODUCER_LABEL,
  LIFECYCLE_PRODUCER_SERVER_LABEL,
  buildLifecycleViewEnvelope,
  recognizeLifecycleViewEnvelope,
} from "../lifecycle-view-envelope";

const GATE = buildLifecycleViewEnvelope({
  viewType: "artifact_review_gate",
  ref: "gate-ref-1",
})!;

describe("the platform producer", () => {
  it("is admitted, and its delivery is recorded as an injection", () => {
    const seen = recognizeLifecycleViewEnvelope({
      serverLabel: LIFECYCLE_PLATFORM_PRODUCER_LABEL,
      toolName: LIFECYCLE_PLATFORM_PRODUCER_ACT,
      result: GATE,
      admitPlatformProducer: true,
    });
    expect(seen).toEqual({
      viewType: "artifact_review_gate",
      schemaVersion: 1,
      ref: "gate-ref-1",
      provenance: "platform_injected",
    });
  });

  it("mints for every run-carried view type the outbox can inject", () => {
    for (const viewType of [
      "artifact_review_gate",
      "verification_summary",
      "trigger_schedule_proposal",
    ] as const) {
      const envelope = buildLifecycleViewEnvelope({ viewType, ref: `${viewType}-ref` })!;
      const seen = recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PLATFORM_PRODUCER_LABEL,
        toolName: LIFECYCLE_PLATFORM_PRODUCER_ACT,
        result: envelope,
        admitPlatformProducer: true,
      });
      expect(seen?.provenance).toBe("platform_injected");
    }
  });

  it("refuses the platform label with any other act", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PLATFORM_PRODUCER_LABEL,
        toolName: "artifact_review_gate_render",
        result: GATE,
        admitPlatformProducer: true,
      }),
    ).toBeNull();
  });

  it("refuses the platform ACT presented by an MCP server label", () => {
    // The two tuples cannot overlap, and this is the direction that matters: a
    // connector that could name the act would be able to forge an injection.
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: LIFECYCLE_PLATFORM_PRODUCER_ACT,
        result: GATE,
        admitPlatformProducer: true,
      }),
    ).toBeNull();
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: "acme-connector",
        toolName: LIFECYCLE_PLATFORM_PRODUCER_ACT,
        result: GATE,
        admitPlatformProducer: true,
      }),
    ).toBeNull();
  });

  it("refuses a label that only NORMALIZES to the platform's", () => {
    for (const label of [
      " cinatra:platform ",
      "Cinatra:Platform",
      "cinatra:platform-",
      "cinatra",
    ]) {
      expect(
        recognizeLifecycleViewEnvelope({
          serverLabel: label,
          toolName: LIFECYCLE_PLATFORM_PRODUCER_ACT,
          result: GATE,
          admitPlatformProducer: true,
        }),
      ).toBeNull();
    }
  });
});

describe("the platform tuple is NOT admitted by default", () => {
  // THE ONE THAT MATTERS (a convergence review, finding 4). These are two public
  // strings, and a tool result is model-visible and model-influenced. If the
  // recognizer minted an injection for whoever presented them, the property
  // "a model cannot forge a platform card" would be a fact about somebody
  // else's ingress rules rather than about this boundary. The sink never opts
  // in, so this is the shape every tool result is judged under.
  it("refuses the platform tuple when the caller did not opt in", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PLATFORM_PRODUCER_LABEL,
        toolName: LIFECYCLE_PLATFORM_PRODUCER_ACT,
        result: GATE,
      }),
    ).toBeNull();
  });

  it("refuses it with an explicit false, too", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PLATFORM_PRODUCER_LABEL,
        toolName: LIFECYCLE_PLATFORM_PRODUCER_ACT,
        result: GATE,
        admitPlatformProducer: false,
      }),
    ).toBeNull();
  });

  it("still admits the PULL TOOLS without any opt-in — they are unchanged", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: "artifact_review_gate_render",
        result: GATE,
      })?.provenance,
    ).toBe("tool_represented");
  });
});

describe("the pull tools, kept and recorded as re-presentation", () => {
  it("still mint, and come back as `tool_represented`", () => {
    const cases: Array<[string, string]> = [
      ["artifact_review_gate", "artifact_review_gate_render"],
      ["artifact_review_gate", "artifact_review_gates_list"],
      ["verification_summary", "verification_record_render"],
      ["trigger_schedule_proposal", "schedule_proposal_render"],
    ];
    for (const [viewType, toolName] of cases) {
      const envelope = buildLifecycleViewEnvelope({
        viewType: viewType as "artifact_review_gate",
        ref: "r-1",
      })!;
      const seen = recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName,
        result: envelope,
      });
      expect(seen).not.toBeNull();
      expect(seen?.provenance).toBe("tool_represented");
    }
  });

  it("keeps the per-viewType allowlist — a tool cannot mint another kind's card", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: "verification_record_render",
        result: GATE,
      }),
    ).toBeNull();
  });
});
