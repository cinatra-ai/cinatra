// A STEP A DECLARED CARD DRAWS LENDS NOTHING (cinatra#3470). The assistant's
// fill and submit do not write a declared card's answer, so the person answers
// it on the card: the lent road names no control for that step, and its grant
// names none. A step whose binding declares no screen still lends both.

import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-declared-card-lends";

const { CARD_ID, PLAIN_ID } = vi.hoisted(() => ({
  CARD_ID: "@acme-test/card-agent:brief",
  PLAIN_ID: "@acme-test/plain-agent:confirm",
}));
vi.mock("@/lib/generated/agent-bindings", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  GENERATED_FIELD_RENDERER_BINDINGS: [
    {
      id: CARD_ID,
      kind: "cta",
      priority: 90,
      midRunHitl: true,
      screen: { layout: "card", sections: [{ type: "field", key: "angle", label: "Angle" }] },
      declaredBy: "@acme-test/card-agent",
    },
    { id: PLAIN_ID, kind: "cta", priority: 90, midRunHitl: true, declaredBy: "@acme-test/plain-agent" },
  ],
}));
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: vi.fn(async () => ({ ok: true })),
  readGatePinnedTargets: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({ readLatestDurableHitlGateArtifact: vi.fn() }));
vi.mock("@cinatra-ai/agents/trigger-store", () => ({ readRunTriggerByRunId: vi.fn() }));

import { controlsLentBy } from "../bound-reference-resolver";
import { grantedControlFor, primaryControlFor } from "../bound-card-binding";

type Resolution = Parameters<typeof controlsLentBy>[0];
const screen = (xRenderer: string) => ({ kind: "hitl_screen", runId: "run-1", xRenderer }) as unknown as Resolution;

describe("the lent road and a declared card's step (cinatra#3470)", () => {
  it("lends no fill and no submit, and the grant names no control", () => {
    expect(controlsLentBy(screen(CARD_ID))).toEqual([]);
    expect(primaryControlFor(screen(CARD_ID))).toBeNull();
    expect(grantedControlFor(screen(CARD_ID))).toBeNull();
  });

  it("a step whose binding declares no screen still lends fill and submit", () => {
    expect(controlsLentBy(screen(PLAIN_ID))).toEqual(["fill", "submit"]);
    expect(primaryControlFor(screen(PLAIN_ID))).toBe("submit");
  });
});
