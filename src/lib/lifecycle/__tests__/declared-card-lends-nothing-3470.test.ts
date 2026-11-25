// A STEP A DECLARED CARD DRAWS LENDS NOTHING (cinatra#3470). The assistant's
// fill and submit do not write a declared card's answer, so the person answers
// it on the card: the lent road names no control for that step, and its grant
// names none. The card is the one the step paused with, stored in its schema;
// a step that stored none (paused before the card was recorded, or with no
// card) still lends both, whatever the build's bindings say now.

import { describe, expect, it, vi } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-declared-card-lends";

vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  enforceReviewRunAccess: vi.fn(async () => ({ ok: true })),
  readGatePinnedTargets: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/store", () => ({ readLatestDurableHitlGateArtifact: vi.fn() }));
vi.mock("@cinatra-ai/agents/trigger-store", () => ({ readRunTriggerByRunId: vi.fn() }));

import { controlsLentBy } from "../bound-reference-resolver";
import { grantedControlFor, primaryControlFor } from "../bound-card-binding";

const ID = "@acme/card-agent:brief";
const STORED = {
  type: "object",
  "x-declared-screen": {
    screen: { layout: "card", sections: [{ type: "field", key: "angle", label: "Angle" }] },
    digest: "sha256:fixture",
  },
};

type Resolution = Parameters<typeof controlsLentBy>[0];
const screen = (schema: Record<string, unknown>) =>
  ({ kind: "hitl_screen", runId: "run-1", screenRef: "wayflow-1", xRenderer: ID, form: { schema, values: {} } }) as unknown as Resolution;

describe("the lent road and a declared card's step (cinatra#3470)", () => {
  it("a step that paused with a card lends no fill and no submit, and the grant names no control", () => {
    expect(controlsLentBy(screen(STORED))).toEqual([]);
    expect(primaryControlFor(screen(STORED))).toBeNull();
    expect(grantedControlFor(screen(STORED))).toBeNull();
  });

  it("a step that stored no card still lends fill and submit", () => {
    expect(controlsLentBy(screen({ type: "object" }))).toEqual(["fill", "submit"]);
    expect(primaryControlFor(screen({ type: "object" }))).toBe("submit");
  });
});
