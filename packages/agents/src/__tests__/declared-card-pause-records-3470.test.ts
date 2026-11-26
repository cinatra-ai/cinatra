// cinatra#3470: THE CARD A STEP PAUSES WITH IS STORED BEFORE IT IS SHOWN.
//
// A MID-RUN pause whose binding declares a card writes its gate row FIRST. The write returns the row as
// stored (the row keeps the first card of a pause, or its absence), and the
// ONE frame then emitted carries exactly that stored card. A write that fails,
// returns no row, or finds another renderer fails the park and emits nothing.
// A schema key of that name the agent sent itself is dropped; a step whose
// binding declares no card is recorded in main's order (emit, read back, then
// a non-fatal row write). A setup step is never stamped.
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
import { declaredHitlCheckedAnswer } from "../hitl-gate-submit";
import { declaredCardOfStep } from "../review-task-actions";

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

type Row = { xRenderer: string; inputSchema: Record<string, unknown> };

/**
 * A gate-row store double with the row writer's rule: a later write of the
 * same pause (same renderer) keeps the first card, or its absence; the write
 * returns the row as stored.
 */
function rowStore(initial: Row | null = null) {
  let row = initial;
  return {
    get row() {
      return row;
    },
    write(a: HumanGateArtifact): Row {
      const { ["x-declared-screen"]: _incoming, ...rest } = a.schema;
      void _incoming;
      const schema =
        row && row.xRenderer === a.xRenderer
          ? Object.hasOwn(row.inputSchema, "x-declared-screen")
            ? { ...rest, "x-declared-screen": row.inputSchema["x-declared-screen"] }
            : rest
          : a.schema;
      row = { xRenderer: a.xRenderer, inputSchema: schema };
      return row;
    },
  };
}

type Park = {
  xRenderer?: string;
  schema?: Record<string, unknown>;
  /** The pause's existing row; `"setup"` parks a setup step (not mid-run). */
  row?: Row | null | "setup";
  /** Failed row writes before one lands (Infinity: never lands). */
  failedWrites?: number;
  /** What a landed write returns instead of the stored row. */
  writeReturns?: "row" | "none" | Row;
  alreadyParked?: boolean;
};

async function park({
  xRenderer = ID,
  schema = { type: "object" },
  row = null,
  failedWrites = 0,
  writeReturns = "row",
  alreadyParked = false,
}: Park = {}) {
  const store = rowStore(row === "setup" ? null : row);
  const order: string[] = [];
  const emitted: HumanGateArtifact[] = [];
  const parkRun = vi.fn(async () => {});
  const failRun = vi.fn(async (_error: string) => {});
  let writes = 0;
  const write = (a: HumanGateArtifact) => {
    writes += 1;
    if (writes <= failedWrites) throw new Error("fixture row write failed");
    order.push("write");
    const r = store.write(a);
    return writeReturns === "row" ? r : writeReturns === "none" ? null : writeReturns;
  };
  const outcome = await parkRunOnHumanGate({
    runId: "run-3470",
    gateLabel: "card step",
    alreadyParked,
    buildArtifact: async () => ({ schema, xRenderer, values: {}, reviewTaskId: "wayflow-3470" }),
    emitInterrupt: (a) => {
      order.push("emit");
      emitted.push(a);
    },
    readBackGate: async () => ({ reviewTaskId: "wayflow-3470", xRenderer }),
    ...(row === "setup" ? {} : { midRunStep: { recordStep: async (a: HumanGateArtifact) => write(a) } }),
    persistArtifact: async (a) => {
      write(a);
    },
    parkRun,
    failRun,
    attempts: 3,
    delayMs: 0,
  });
  return { outcome, emitted, row: store.row, parkRun, failRun, writes, order };
}

beforeEach(() => deploy(SCREEN));

describe("the card a step pauses with is stored before it is shown (cinatra#3470)", () => {
  it("a new mid-run pause: the row is written first, and the one frame carries the stored card and its digest", async () => {
    const { emitted, row, order, outcome } = await park();
    expect(outcome.outcome).toBe("parked");
    expect(order).toEqual(["write", "emit"]);
    expect(emitted.map((a) => a.schema)).toEqual([{ type: "object", ...stored(SCREEN) }]);
    expect(row!.inputSchema).toEqual({ type: "object", ...stored(SCREEN) });
  });

  it("a step whose binding declares no card is recorded in main's order, and an agent-sent key is dropped", async () => {
    const { emitted, row, order } = await park({ xRenderer: PLAIN_ID, schema: { type: "object", ...stored(SCREEN_V2) } });
    expect(order).toEqual(["emit", "write"]);
    expect(emitted.map((a) => a.schema)).toEqual([{ type: "object" }]);
    expect(row!.inputSchema).toEqual({ type: "object" });
  });
});

describe("the card is stored once per pause", () => {
  it("re-emitting the same pause after the build's card changed emits the card its row stored", async () => {
    deploy(SCREEN_V2);
    const { emitted, row, order } = await park({
      alreadyParked: true,
      row: { xRenderer: ID, inputSchema: { type: "object", ...stored(SCREEN) } },
    });
    expect(order).toEqual(["write", "emit"]);
    expect(emitted.map((a) => a.schema)).toEqual([{ type: "object", ...stored(SCREEN) }]);
    expect(row!.inputSchema).toEqual({ type: "object", ...stored(SCREEN) });
  });

  it("re-emitting a pause whose row stored no card emits none, whatever the build declares now", async () => {
    const { emitted, order } = await park({ alreadyParked: true, row: { xRenderer: ID, inputSchema: { type: "object" } } });
    expect(order).toEqual(["write", "emit"]);
    expect(emitted.map((a) => a.schema)).toEqual([{ type: "object" }]);
  });

  it("a new pause after the change stores and emits the new card", async () => {
    deploy(SCREEN_V2);
    const { emitted } = await park();
    expect(emitted.map((a) => a.schema)).toEqual([{ type: "object", ...stored(SCREEN_V2) }]);
  });

  it("the row writer keeps the first card of a pause, or its absence, and returns the row as stored in the same statement", async () => {
    const calls: string[] = [];
    const query = (async (text: string) => {
      calls.push(text.replace(/\s+/g, " "));
      return [{ x_renderer: ID, input_schema: { type: "object", ...stored(SCREEN) } }];
    }) as never;
    const back = await writeDurableHitlGateArtifact(
      { runId: "run-3470", reviewTaskId: "wayflow-3470", xRenderer: ID, inputSchema: { type: "object", ...stored(SCREEN_V2) }, values: {} },
      { query },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(
      "WHEN agent_run_hitl_gates.x_renderer = EXCLUDED.x_renderer AND agent_run_hitl_gates.input_schema ? 'x-declared-screen' " +
        "THEN jsonb_set(EXCLUDED.input_schema, '{x-declared-screen}', agent_run_hitl_gates.input_schema -> 'x-declared-screen') " +
        "WHEN agent_run_hitl_gates.x_renderer = EXCLUDED.x_renderer THEN EXCLUDED.input_schema - 'x-declared-screen'",
    );
    expect(calls[0]).toContain("RETURNING x_renderer, input_schema");
    expect(back).toEqual({ xRenderer: ID, inputSchema: { type: "object", ...stored(SCREEN) } });
  });
});

describe("a declared card belongs to a mid-run step only", () => {
  it("a setup step naming a card-declaring renderer is not stamped", async () => {
    const { emitted, row } = await park({ row: "setup", schema: { type: "string", "x-required": true } });
    expect(emitted.map((a) => a.schema)).toEqual([{ type: "string", "x-required": true }]);
    expect(row!.inputSchema).toEqual({ type: "string", "x-required": true });
  });
});

describe("a step that carries a card is not shown or parked without its row", () => {
  it("a row write that fails once is retried, and the run is parked with its row", async () => {
    const { outcome, row, parkRun, writes, emitted } = await park({ failedWrites: 1 });
    expect(outcome.outcome).toBe("parked");
    expect(writes).toBe(2);
    expect(row!.inputSchema).toEqual({ type: "object", ...stored(SCREEN) });
    expect(emitted).toHaveLength(1);
    expect(parkRun).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["keeps failing", { failedWrites: Infinity }, "card could not be recorded with it (fixture row write failed)"],
    ["returns no row", { writeReturns: "none" as const }, "card could not be recorded with it (the gate row write returned no row)"],
    [
      "finds another renderer on the row",
      { writeReturns: { xRenderer: PLAIN_ID, inputSchema: { type: "object" } } },
      "gate row holds another renderer",
    ],
  ])("a row write that %s fails the run with a named error; nothing is emitted and it is never parked", async (_n, opts, named) => {
    const { outcome, parkRun, failRun, emitted } = await park(opts);
    expect(outcome.outcome).toBe("failed");
    expect(emitted).toEqual([]);
    expect(parkRun).not.toHaveBeenCalled();
    expect(failRun.mock.calls[0]![0]).toContain(named);
  });

  it("a step with no card keeps main's behaviour: one failed write is logged and the run is parked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { outcome, parkRun, writes } = await park({ xRenderer: PLAIN_ID, failedWrites: 1 });
    expect(outcome.outcome).toBe("parked");
    expect(writes).toBe(1);
    expect(parkRun).toHaveBeenCalledTimes(1);
  });
});

describe("two first parks of one pause on different builds (cinatra#3470)", () => {
  // Worker A runs the build declaring SCREEN, worker B the build declaring
  // SCREEN_V2. Both park the same pause for the first time; their row writes
  // are held and then land in the order the case names. The store keeps the
  // first write's card; the emitter records every frame with its worker.
  it.each([
    ["A's write lands first", ["A", "B"] as const, SCREEN, SCREEN_V2],
    ["B's write lands first", ["B", "A"] as const, SCREEN_V2, SCREEN],
  ])("%s: each worker emits the STORED card exactly once, never the losing card", async (_n, landing, kept, losing) => {
    const store = rowStore();
    const log: string[] = [];
    const frames: Array<{ worker: string; schema: Record<string, unknown> }> = [];
    const release: Record<string, () => void> = {};
    const reached: Record<string, Promise<void>> = {};
    const arrivedAt: string[] = [];
    // A worker reaches its row write before anything is emitted, or the case fails here.
    const writeReached = async (worker: string) => {
      await Promise.race([reached[worker], new Promise((r) => setTimeout(r, 50))]);
      expect({ worker, writing: arrivedAt.includes(worker), frames: frames.length }).toEqual({ worker, writing: true, frames: 0 });
    };
    const parkAs = (worker: "A" | "B") => {
      let arrived!: () => void;
      reached[worker] = new Promise((r) => (arrived = r));
      const held = new Promise<void>((r) => (release[worker] = r));
      return parkRunOnHumanGate({
        runId: "run-3470",
        gateLabel: "card step",
        alreadyParked: false,
        buildArtifact: async () => ({ schema: { type: "object" }, xRenderer: ID, values: {}, reviewTaskId: "wayflow-3470" }),
        emitInterrupt: (a) => {
          log.push(`emit:${worker}`);
          frames.push({ worker, schema: a.schema });
        },
        readBackGate: async () => ({ reviewTaskId: "wayflow-3470", xRenderer: ID }),
        midRunStep: {
          recordStep: async (a) => {
            arrivedAt.push(worker);
            arrived();
            await held;
            log.push(`write:${worker}`);
            return store.write(a);
          },
        },
        persistArtifact: async () => {
          throw new Error("a declared card's row is written once, first");
        },
        parkRun: async () => {},
        failRun: async (e) => {
          throw new Error(`unexpected failure: ${e}`);
        },
        attempts: 1,
        delayMs: 0,
      });
    };
    // Each worker stamps the card of ITS build before the other deploys.
    deploy(SCREEN);
    const a = parkAs("A");
    await writeReached("A");
    deploy(SCREEN_V2);
    const b = parkAs("B");
    await writeReached("B");
    release[landing[0]]!();
    await new Promise((r) => setTimeout(r, 0));
    release[landing[1]]!();
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.outcome, rb.outcome]).toEqual(["parked", "parked"]);
    expect(frames.filter((f) => f.worker === "A")).toHaveLength(1);
    expect(frames.filter((f) => f.worker === "B")).toHaveLength(1);
    for (const f of frames) expect(f.schema).toEqual({ type: "object", ...stored(kept) });
    expect(frames.some((f) => canon(f.schema).includes(canon(losing)))).toBe(false);
    // Each frame follows its own worker's write.
    expect(log.indexOf("emit:A")).toBeGreaterThan(log.indexOf("write:A"));
    expect(log.indexOf("emit:B")).toBeGreaterThan(log.indexOf("write:B"));
    // The answer road reads the same card from the row.
    const card = declaredCardOfStep({ read: "row", gate: store.row! });
    if (card === null || card === "unknown") throw new Error("the row holds no readable card");
    const keyOf = (s: Record<string, unknown>) => (s.sections as Array<{ key: string }>)[0]!.key;
    const answer = { [keyOf(kept)]: "Why runs need a record" };
    expect(declaredHitlCheckedAnswer(card, {}, { ...answer, userResponse: JSON.stringify(answer), approved: true })).not.toHaveProperty("refusal");
    const other = { [keyOf(losing)]: "A hook" };
    expect(declaredHitlCheckedAnswer(card, {}, { ...other, userResponse: JSON.stringify(other), approved: true })).toHaveProperty("refusal");
  });
});
