// cinatra#3470: THE CARD A STEP PAUSES WITH IS RECORDED WITH THE STEP.
//
// When a pause is recorded, the park seam stamps the bundled binding's checked
// card, and its digest, into the step's schema before the frame is emitted and
// the gate row written, so both carry the same card. A schema key of that name
// the agent sent itself is dropped; a step whose binding declares no card is
// recorded as before.
//
//   cd packages/agents && pnpm exec vitest run src/__tests__/declared-card-pause-records-3470.test.ts
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const { ID, PLAIN_ID, SCREEN } = vi.hoisted(() => ({
  ID: "@acme/card-agent:brief",
  PLAIN_ID: "@acme/plain-agent:confirm",
  SCREEN: { layout: "card", sections: [{ type: "field", key: "angle", label: "Angle" }] },
}));
vi.mock("@/lib/generated/agent-bindings", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  GENERATED_FIELD_RENDERER_BINDINGS: [
    { id: ID, kind: "cta", priority: 90, midRunHitl: true, screen: SCREEN },
    { id: PLAIN_ID, kind: "cta", priority: 90, midRunHitl: true },
  ],
}));

import { parkRunOnHumanGate, type HumanGateArtifact } from "../human-gate-park";

/** The stored form of a card: the card and the sha-256 of its canonical JSON. */
const canon = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(v);

async function park(xRenderer: string, schema: Record<string, unknown>) {
  const emitted: HumanGateArtifact[] = [];
  const persisted: HumanGateArtifact[] = [];
  await parkRunOnHumanGate({
    runId: "run-3470",
    gateLabel: "card step",
    alreadyParked: false,
    buildArtifact: async () => ({ schema, xRenderer, values: {}, reviewTaskId: "wayflow-3470" }),
    emitInterrupt: (a) => void emitted.push(a),
    readBackGate: async () => ({ reviewTaskId: "wayflow-3470", xRenderer }),
    persistArtifact: async (a) => void persisted.push(a),
    parkRun: async () => {},
    failRun: async () => {},
    attempts: 1,
    delayMs: 0,
  });
  return { emitted: emitted[0]!.schema, persisted: persisted[0]!.schema };
}

describe("the card a step pauses with is recorded with the step (cinatra#3470)", () => {
  it("the frame and the gate row carry the checked card and its digest", async () => {
    const { emitted, persisted } = await park(ID, { type: "object" });
    const digest = `sha256:${createHash("sha256").update(canon(SCREEN)).digest("hex")}`;
    const stamped = { type: "object", "x-declared-screen": { screen: SCREEN, digest } };
    expect(emitted).toEqual(stamped);
    expect(persisted).toEqual(stamped);
  });

  it("a step whose binding declares no card is recorded as before, and an agent-sent key is dropped", async () => {
    const { emitted, persisted } = await park(PLAIN_ID, { type: "object", "x-declared-screen": { screen: SCREEN, digest: "x" } });
    expect(emitted).toEqual({ type: "object" });
    expect(persisted).toEqual({ type: "object" });
  });
});
