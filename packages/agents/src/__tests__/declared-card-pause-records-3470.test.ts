// cinatra#3470: THE CARD A STEP PAUSES WITH IS RECORDED WITH THE STEP.
//
// When a MID-RUN pause is recorded, the park seam stamps the bundled binding's
// checked card, and its digest, into the step's schema before the frame is
// emitted and the gate row written, so both carry the same card. A schema key
// of that name the agent sent itself is dropped; a step whose binding declares
// no card is recorded as before.
//
// The card is stamped ONCE per pause (the gate row's run + review task, same
// renderer): a re-emission of the same pause carries what its row stored, and
// the row writer keeps a stored card whatever a later write brings. A setup
// step is never stamped. A step that carries a card is not parked without its
// row: the row write is retried, and a write that keeps failing fails the run.
//
//   cd packages/agents && pnpm exec vitest run src/__tests__/declared-card-pause-records-3470.test.ts
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ID, PLAIN_ID, SCREEN, SCREEN_V2, BINDINGS } = vi.hoisted(() => ({
  ID: "@acme/card-agent:brief",
  PLAIN_ID: "@acme/plain-agent:confirm",
  SCREEN: { layout: "card", sections: [{ type: "field", key: "angle", label: "Angle" }] },
  /** The same renderer in a newer build: its field is another one. */
  SCREEN_V2: { layout: "card", sections: [{ type: "field", key: "hook", label: "Hook" }] },
  BINDINGS: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/generated/agent-bindings", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  GENERATED_FIELD_RENDERER_BINDINGS: BINDINGS,
}));

import { parkRunOnHumanGate, type HumanGateArtifact } from "../human-gate-park";
import { writeDurableHitlGateArtifact } from "../store";

/** The stored form of a card: the card and the sha-256 of its canonical JSON. */
const canon = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(v);
const stored = (screen: unknown) => ({
  "x-declared-screen": { screen, digest: `sha256:${createHash("sha256").update(canon(screen)).digest("hex")}` },
});

/** Deploy a build whose card binding declares `screen`, or no binding for it (`null`). */
function deploy(screen: Record<string, unknown> | null): void {
  BINDINGS.splice(
    0,
    BINDINGS.length,
    ...(screen ? [{ id: ID, kind: "cta", priority: 90, midRunHitl: true, screen }] : []),
    { id: PLAIN_ID, kind: "cta", priority: 90, midRunHitl: true },
  );
}

type Row = { xRenderer: string; inputSchema: Record<string, unknown> } | null;
type Park = {
  xRenderer?: string;
  schema?: Record<string, unknown>;
  /** The mid-run gate's row reader; `"setup"` parks a setup step (no reader). */
  row?: Row | "setup" | "throws";
  /** Failed row writes before one lands (Infinity: never lands). */
  failedWrites?: number;
  alreadyParked?: boolean;
};

async function park({ xRenderer = ID, schema = { type: "object" }, row = null, failedWrites = 0, alreadyParked = false }: Park = {}) {
  const emitted: HumanGateArtifact[] = [];
  const persisted: HumanGateArtifact[] = [];
  const parkRun = vi.fn(async () => {});
  const failRun = vi.fn(async (_error: string) => {});
  let writes = 0;
  const outcome = await parkRunOnHumanGate({
    runId: "run-3470",
    gateLabel: "card step",
    alreadyParked,
    buildArtifact: async () => ({ schema, xRenderer, values: {}, reviewTaskId: "wayflow-3470" }),
    emitInterrupt: (a) => void emitted.push(a),
    readBackGate: async () => ({ reviewTaskId: "wayflow-3470", xRenderer }),
    ...(row === "setup"
      ? {}
      : {
          midRunStep: {
            readPausedRow: async () =>
              row === "throws" ? { read: "failed" as const } : row === null ? { read: "none" as const } : { read: "row" as const, gate: row },
          },
        }),
    persistArtifact: async (a) => {
      writes += 1;
      if (writes <= failedWrites) throw new Error("fixture row write failed");
      persisted.push(a);
    },
    parkRun,
    failRun,
    attempts: 3,
    delayMs: 0,
  });
  return { outcome, emitted: emitted[0]?.schema, persisted: persisted[0]?.schema, parkRun, failRun, writes };
}

beforeEach(() => deploy(SCREEN));

describe("the card a step pauses with is recorded with the step (cinatra#3470)", () => {
  it("a new mid-run pause: the frame and the gate row carry the checked card and its digest", async () => {
    const { emitted, persisted } = await park();
    expect(emitted).toEqual({ type: "object", ...stored(SCREEN) });
    expect(persisted).toEqual({ type: "object", ...stored(SCREEN) });
  });

  it("a step whose binding declares no card is recorded as before, and an agent-sent key is dropped", async () => {
    const { emitted, persisted } = await park({ xRenderer: PLAIN_ID, schema: { type: "object", ...stored(SCREEN_V2) } });
    expect(emitted).toEqual({ type: "object" });
    expect(persisted).toEqual({ type: "object" });
  });
});

describe("the card is stamped once per pause", () => {
  it.each([
    ["changed", SCREEN_V2],
    ["removed", null],
  ])("re-emitting the same pause after the build's binding %s carries the card its row stored", async (_n, next) => {
    deploy(next);
    const { emitted, persisted } = await park({
      alreadyParked: true,
      row: { xRenderer: ID, inputSchema: { type: "object", ...stored(SCREEN) } },
    });
    expect(emitted).toEqual({ type: "object", ...stored(SCREEN) });
    expect(persisted).toEqual({ type: "object", ...stored(SCREEN) });
  });

  it("re-emitting a pause whose row stored no card stamps none, whatever the build declares now", async () => {
    const { emitted } = await park({ alreadyParked: true, row: { xRenderer: ID, inputSchema: { type: "object" } } });
    expect(emitted).toEqual({ type: "object" });
  });

  it("a new pause after the change stamps the new card", async () => {
    deploy(SCREEN_V2);
    const { emitted } = await park({ row: null });
    expect(emitted).toEqual({ type: "object", ...stored(SCREEN_V2) });
  });

  it.each([
    ["the build still declares the card", SCREEN],
    ["a later build removed the declaration", null],
  ])("a row read that fails (%s) fails the park: no frame is emitted against the row", async (_n, now) => {
    deploy(now);
    const { outcome, emitted, parkRun, failRun } = await park({ alreadyParked: true, row: "throws" });
    expect(outcome.outcome).toBe("failed");
    expect(emitted).toBeUndefined();
    expect(parkRun).not.toHaveBeenCalled();
    expect(failRun.mock.calls[0]![0]).toContain("recorded card could not be read");
  });

  it("a first park whose row read fails: a renderer with a card now fails the park; one with none is recorded as before", async () => {
    const withCard = await park({ row: "throws" });
    expect(withCard.outcome.outcome).toBe("failed");
    expect(withCard.emitted).toBeUndefined();
    const plain = await park({ xRenderer: PLAIN_ID, row: "throws" });
    expect(plain.outcome.outcome).toBe("parked");
    expect(plain.emitted).toEqual({ type: "object" });
  });

  it("the row writer keeps a stored card for the same pause whatever a later write brings", async () => {
    const calls: string[] = [];
    const query = (async (text: string) => {
      calls.push(text.replace(/\s+/g, " "));
      return [];
    }) as never;
    await writeDurableHitlGateArtifact(
      { runId: "run-3470", reviewTaskId: "wayflow-3470", xRenderer: ID, inputSchema: { type: "object", ...stored(SCREEN_V2) }, values: {} },
      { query },
    );
    expect(calls[0]).toContain(
      "input_schema = CASE WHEN agent_run_hitl_gates.x_renderer = EXCLUDED.x_renderer AND agent_run_hitl_gates.input_schema ? 'x-declared-screen' " +
        "THEN jsonb_set(EXCLUDED.input_schema, '{x-declared-screen}', agent_run_hitl_gates.input_schema -> 'x-declared-screen') ELSE EXCLUDED.input_schema END",
    );
  });
});

describe("a declared card belongs to a mid-run step only", () => {
  it("a setup step naming a card-declaring renderer is not stamped", async () => {
    const { emitted, persisted } = await park({ row: "setup", schema: { type: "string", "x-required": true } });
    expect(emitted).toEqual({ type: "string", "x-required": true });
    expect(persisted).toEqual({ type: "string", "x-required": true });
  });
});

describe("a step that carries a card is not parked without its row", () => {
  it("a row write that fails once is retried, and the run is parked with its row", async () => {
    const { outcome, persisted, parkRun, writes } = await park({ failedWrites: 1 });
    expect(outcome.outcome).toBe("parked");
    expect(writes).toBe(2);
    expect(persisted).toEqual({ type: "object", ...stored(SCREEN) });
    expect(parkRun).toHaveBeenCalledTimes(1);
  });

  it("a row write that keeps failing fails the run with a named error; it is never parked", async () => {
    const { outcome, parkRun, failRun } = await park({ failedWrites: Infinity });
    expect(outcome.outcome).toBe("failed");
    expect(parkRun).not.toHaveBeenCalled();
    expect(failRun.mock.calls[0]![0]).toContain("card could not be recorded with it");
  });

  it("a step with no card keeps main's behaviour: one failed write is logged and the run is parked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { outcome, parkRun, writes } = await park({ xRenderer: PLAIN_ID, failedWrites: 1 });
    expect(outcome.outcome).toBe("parked");
    expect(writes).toBe(1);
    expect(parkRun).toHaveBeenCalledTimes(1);
  });
});
