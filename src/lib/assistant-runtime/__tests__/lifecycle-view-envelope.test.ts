// The lifecycle typed-view PRODUCER contract (cinatra#2565, epic #2564 S1).
//
// Every property this file pins is a security property, not a formatting one:
// who may mint a card, what may ride the wire, and what a refusal may say. The
// sink-level integration (an envelope becoming a DATA_PART) lives in
// ag-ui-sink-adapter.test.ts; this file is the recognizer's own matrix.

import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_ENVELOPE_KEY,
  LIFECYCLE_ENVELOPE_MAX_LENGTH,
  LIFECYCLE_ENVELOPE_VERSION,
  LIFECYCLE_PRODUCER_SERVER_LABEL,
  LIFECYCLE_PRODUCER_TOOLS,
  LIFECYCLE_REFUSAL_RESULT,
  LIFECYCLE_REF_MAX_LENGTH,
  LIFECYCLE_VIEW_TYPES,
  buildLifecycleViewEnvelope,
  recognizeLifecycleViewEnvelope,
  LIFECYCLE_PLATFORM_PRODUCER_ACT,
  LIFECYCLE_PLATFORM_PRODUCER_LABEL,
  LIFECYCLE_PLATFORM_VIEW_TYPES,
} from "../lifecycle-view-envelope";
import {
  LIFECYCLE_PLATFORM_PRODUCER_ACT as AGENTS_LIFECYCLE_PLATFORM_PRODUCER_ACT,
  LIFECYCLE_PLATFORM_PRODUCER_LABEL as AGENTS_LIFECYCLE_PLATFORM_PRODUCER_LABEL,
} from "@cinatra-ai/agents/lifecycle-part-outbox";
import {
  LIFECYCLE_DATA_PART_VIEW_TYPES,
  LIFECYCLE_VIEW_REF_MAX_LENGTH,
} from "@cinatra-ai/agent-ui-protocol/renderable-views";

const REVIEW_TOOL = "artifact_review_gate_render";

function envelope(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    [LIFECYCLE_ENVELOPE_KEY]: LIFECYCLE_ENVELOPE_VERSION,
    viewType: "artifact_review_gate",
    ref: "ref-abc",
    ...overrides,
  });
}

describe("drift pins against the protocol registry", () => {
  it("the local viewType mirror equals the registered DATA_PART lifecycle types", () => {
    expect([...LIFECYCLE_VIEW_TYPES].sort()).toEqual(
      [...LIFECYCLE_DATA_PART_VIEW_TYPES].sort(),
    );
  });

  it("the local PLATFORM producer mirror equals the agents package's own (cinatra#2930)", () => {
    // This module is pure by design, so the platform tuple is mirrored rather
    // than imported — and a mirror nobody pins is a second source of truth. A
    // label that drifted apart here would silently stop admitting the platform's
    // own injections, and the cards would go back to arriving only when a model
    // asked for them.
    expect(LIFECYCLE_PLATFORM_PRODUCER_LABEL).toBe(
      AGENTS_LIFECYCLE_PLATFORM_PRODUCER_LABEL,
    );
    expect(LIFECYCLE_PLATFORM_PRODUCER_ACT).toBe(AGENTS_LIFECYCLE_PLATFORM_PRODUCER_ACT);
  });

  it("the PLATFORM viewType mirror equals the DATA_PART kinds it may inject (cinatra#2930)", () => {
    expect([...LIFECYCLE_PLATFORM_VIEW_TYPES].sort()).toEqual(
      [...LIFECYCLE_DATA_PART_VIEW_TYPES].sort(),
    );
  });

  it("the local ref bound equals the wire schema's ref bound", () => {
    expect(LIFECYCLE_REF_MAX_LENGTH).toBe(LIFECYCLE_VIEW_REF_MAX_LENGTH);
  });

  it("the envelope bound is STRICTLY below the runtime's 2,000-char result cap", () => {
    // runtime.ts: `result.length > 2000 ? result.slice(0, 2000) + "..."`. The
    // strict inequality is what makes a truncated result unparseable rather
    // than parseable-but-wrong.
    expect(LIFECYCLE_ENVELOPE_MAX_LENGTH).toBeLessThan(2000);
  });

  it("every viewType has a producer-tool entry (an unmintable one is empty, never missing)", () => {
    for (const viewType of LIFECYCLE_VIEW_TYPES) {
      expect(Array.isArray(LIFECYCLE_PRODUCER_TOOLS[viewType])).toBe(true);
    }
  });
});

describe("recognizeLifecycleViewEnvelope — the producer bind", () => {
  it("mints a DATA_PART payload for the allowlisted (server, tool) tuple", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: REVIEW_TOOL,
        result: envelope(),
      }),
      // AMENDED BY cinatra#2930 (lifecycle-b W3): the answer now carries WHICH
      // producer minted it, because the platform's injection and a tool's
      // re-presentation are the same card and two different facts. The PAYLOAD
      // is unchanged — the sink writes `{ viewType, schemaVersion, ref }` and
      // carries the delivery beside it — which is pinned in
      // __tests__/ag-ui-sink-injected-card.test.ts.
    ).toEqual({
      viewType: "artifact_review_gate",
      schemaVersion: LIFECYCLE_ENVELOPE_VERSION,
      ref: "ref-abc",
      provenance: "tool_represented",
    });
  });

  it("mints NOTHING for a byte-identical envelope from a non-allowlisted MCP server", () => {
    // The AC's forged-envelope case: an external connector returning exactly
    // the reserved bytes.
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: "wordpress-mcp",
        toolName: REVIEW_TOOL,
        result: envelope(),
      }),
    ).toBeNull();
  });

  it("mints NOTHING when an external server IMPERSONATES the first-party label but the tool is not allowlisted", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: "objects_list",
        result: envelope(),
      }),
    ).toBeNull();
  });

  it("mints NOTHING when the tool is allowlisted for a DIFFERENT viewType", () => {
    // Per-viewType allowlist: a verification renderer may not mint a review gate.
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: "verification_record_render",
        result: envelope(),
      }),
    ).toBeNull();
  });

  it("mints a trigger proposal ONLY through its own producer (S5 filled S1's empty allowlist)", () => {
    // S1 shipped this allowlist EMPTY — "registered on the wire and unmintable,
    // the correct fail-closed posture". cinatra#2569 fills exactly that seam,
    // and this assertion moves with it so the fill is a deliberate edit rather
    // than a drift nobody notices.
    expect(LIFECYCLE_PRODUCER_TOOLS.trigger_schedule_proposal).toEqual([
      "schedule_proposal_render",
    ]);
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: "schedule_proposal_render",
        result: envelope({ viewType: "trigger_schedule_proposal" }),
      }),
    ).not.toBeNull();
    // …and the per-viewType bind still holds in BOTH directions: a review
    // renderer cannot mint a proposal, and the proposal producer cannot mint a
    // review gate.
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: REVIEW_TOOL,
        result: envelope({ viewType: "trigger_schedule_proposal" }),
      }),
    ).toBeNull();
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: "schedule_proposal_render",
        result: envelope(),
      }),
    ).toBeNull();
  });

  it("mints NOTHING for a label VARIANT — acceptance is exact, rejection is broad", () => {
    // The injection boundary drops every label normalizing to the reserved one,
    // so a variant can only reach here from a path that bypassed it.
    for (const label of [" Cinatra ", "CINATRA", "cinatra-", "cinatra "]) {
      expect(
        recognizeLifecycleViewEnvelope({
          serverLabel: label,
          toolName: REVIEW_TOOL,
          result: envelope(),
        }),
      ).toBeNull();
    }
  });
});

describe("recognizeLifecycleViewEnvelope — refs only, never content", () => {
  it("rejects an envelope carrying ANY extra field", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: REVIEW_TOOL,
        result: envelope({ title: "Q3 re-engagement email" }),
      }),
    ).toBeNull();
  });

  it("rejects an unknown viewType", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: REVIEW_TOOL,
        result: envelope({ viewType: "recommendation_hold" }),
      }),
    ).toBeNull();
  });

  it("rejects a wrong envelope version", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: REVIEW_TOOL,
        result: envelope({ [LIFECYCLE_ENVELOPE_KEY]: 2 }),
      }),
    ).toBeNull();
  });

  it("rejects an oversized ref", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: REVIEW_TOOL,
        result: envelope({ ref: "r".repeat(LIFECYCLE_REF_MAX_LENGTH + 1) }),
      }),
    ).toBeNull();
  });
});

describe("recognizeLifecycleViewEnvelope — truncation and hostile input", () => {
  it("a result the runtime TRUNCATED cannot be recognized", () => {
    const padded = JSON.stringify({
      [LIFECYCLE_ENVELOPE_KEY]: LIFECYCLE_ENVELOPE_VERSION,
      viewType: "artifact_review_gate",
      ref: "ref-abc",
      pad: "x".repeat(3000),
    });
    const truncated = padded.slice(0, 2000) + "...";
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: REVIEW_TOOL,
        result: truncated,
      }),
    ).toBeNull();
  });

  it("never throws on hostile or non-string payloads", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      42,
      "not json",
      "[]",
      '"a string"',
      "{",
      JSON.stringify([1, 2, 3]),
    ];
    for (const result of hostile) {
      expect(() =>
        recognizeLifecycleViewEnvelope({
          serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
          toolName: REVIEW_TOOL,
          result,
        }),
      ).not.toThrow();
      expect(
        recognizeLifecycleViewEnvelope({
          serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
          toolName: REVIEW_TOOL,
          result,
        }),
      ).toBeNull();
    }
  });
});

describe("the generic refusal", () => {
  it("carries no identifier, no digit and no count", () => {
    expect(LIFECYCLE_REFUSAL_RESULT).not.toMatch(/\d/);
    expect(LIFECYCLE_REFUSAL_RESULT).not.toMatch(/[0-9a-f]{8}/i);
    expect(LIFECYCLE_REFUSAL_RESULT.length).toBeLessThan(80);
  });

  it("is not an envelope, so a refusal mints no DATA_PART", () => {
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: REVIEW_TOOL,
        result: LIFECYCLE_REFUSAL_RESULT,
      }),
    ).toBeNull();
  });
});

describe("buildLifecycleViewEnvelope", () => {
  it("round-trips through the recognizer", () => {
    const built = buildLifecycleViewEnvelope({
      viewType: "verification_summary",
      ref: "ref-v1",
    });
    expect(built).not.toBeNull();
    expect(
      recognizeLifecycleViewEnvelope({
        serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
        toolName: "verification_record_render",
        result: built!,
      }),
      // AMENDED BY cinatra#2930, for the reason above.
    ).toEqual({
      viewType: "verification_summary",
      schemaVersion: LIFECYCLE_ENVELOPE_VERSION,
      ref: "ref-v1",
      provenance: "tool_represented",
    });
  });

  it("refuses to build an out-of-bounds ref rather than emitting a droppable envelope", () => {
    expect(
      buildLifecycleViewEnvelope({
        viewType: "artifact_review_gate",
        ref: "r".repeat(LIFECYCLE_REF_MAX_LENGTH + 1),
      }),
    ).toBeNull();
    expect(
      buildLifecycleViewEnvelope({ viewType: "artifact_review_gate", ref: "" }),
    ).toBeNull();
  });

  it("every built envelope fits the accepted length bound", () => {
    const built = buildLifecycleViewEnvelope({
      viewType: "artifact_review_gate",
      ref: "r".repeat(LIFECYCLE_REF_MAX_LENGTH),
    });
    expect(built).not.toBeNull();
    expect(built!.length).toBeLessThanOrEqual(LIFECYCLE_ENVELOPE_MAX_LENGTH);
  });
});
