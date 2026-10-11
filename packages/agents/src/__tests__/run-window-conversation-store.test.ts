// The per-run window conversation STORE (cinatra#2933, lifecycle-b W5b).
//
// AC1's first half: the exchange is stored WITH THE RUN, so a reload finds it.
// Plus the two invariants that make it safe to put it on `agent_run_messages`:
// the run's own replay thread never sees a window row, and a turn appends its
// own row rather than re-writing a transcript (the shape #2909 warns about).

import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;

const rows: Row[] = [];
let insertCalls: Row[] = [];
let failNextInsertWithUnique = 0;

vi.mock("../db", () => {
  const makeSelect = () => ({
    from: () => ({
      where: (w: unknown) => {
        const q = w as { __kind?: string; runId?: string; windowOnly?: boolean };
        const base = rows.filter((r) => r.runId === q.runId);
        if (q.__kind === "max") {
          const hw = base.reduce<number | null>(
            (a, r) => (a === null || (r.sequence as number) > a ? (r.sequence as number) : a),
            null,
          );
          return Promise.resolve([{ highWater: hw }]);
        }
        const filtered = q.windowOnly
          ? base.filter((r) => r.messageType === "window")
          : base;
        const ordered = [...filtered].sort(
          (a, b) => (a.sequence as number) - (b.sequence as number),
        );
        return { orderBy: () => Promise.resolve(ordered) };
      },
    }),
  });
  return {
    db: {
      select: (shape?: Record<string, unknown>) => {
        const isMax = !!shape && "highWater" in shape;
        const s = makeSelect();
        return {
          from: () => ({
            where: (w: unknown) => {
              const q = { ...(w as object), __kind: isMax ? "max" : "rows" };
              return s.from().where(q);
            },
          }),
        };
      },
      insert: () => ({
        values: (v: Row) => {
          insertCalls.push(v);
          if (failNextInsertWithUnique > 0) {
            failNextInsertWithUnique -= 1;
            const err = new Error("duplicate key") as Error & { code?: string };
            err.code = "23505";
            return Promise.reject(err);
          }
          rows.push(v);
          return Promise.resolve();
        },
      }),
    },
  };
});

vi.mock("../schema", () => ({
  agentRunMessages: {
    runId: "run_id",
    sequence: "sequence",
    messageType: "message_type",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: string, val: unknown) =>
    col === "run_id" ? { runId: val } : { windowOnly: val === "window" },
  ne: () => ({ notWindow: true }),
  and: (...parts: Array<Record<string, unknown>>) =>
    Object.assign({}, ...parts),
  asc: (c: string) => c,
  max: (c: string) => ({ __max: c }),
}));

const store = await import("../run-window-conversation-store");

beforeEach(() => {
  rows.length = 0;
  insertCalls = [];
  failNextInsertWithUnique = 0;
});

describe("the run's window conversation is kept with the run", () => {
  it("appends the person's message and the assistant's answer in order, and reads them back", async () => {
    await store.appendRunWindowMessage({
      runId: "run-1",
      role: "user",
      surface: "run-page",
      text: "tighten the opening paragraph",
    });
    await store.appendRunWindowMessage({
      runId: "run-1",
      role: "assistant",
      surface: "run-page",
      text: "Done — I shortened it.",
    });

    // A RELOAD is exactly this: a fresh read of what the run holds.
    const after = await store.readRunWindowMessages("run-1");
    expect(after.map((m) => [m.role, m.text])).toEqual([
      ["user", "tighten the opening paragraph"],
      ["assistant", "Done — I shortened it."],
    ]);
    expect(after.map((m) => m.sequence)).toEqual([1, 2]);
    expect(after.every((m) => m.surface === "run-page")).toBe(true);
  });

  it("keeps every window's turns on the run, and can narrow to one window", async () => {
    for (const surface of ["run-page", "step-by-step", "schedule", "armed-trigger", "review"] as const) {
      await store.appendRunWindowMessage({
        runId: "run-1",
        role: "user",
        surface,
        text: `asked on ${surface}`,
      });
    }
    const all = await store.readRunWindowMessages("run-1");
    expect(all).toHaveLength(5);
    expect(all.map((m) => m.surface)).toEqual([
      "run-page",
      "step-by-step",
      "schedule",
      "armed-trigger",
      "review",
    ]);
    const review = await store.readRunWindowMessages("run-1", { surface: "review" });
    expect(review.map((m) => m.text)).toEqual(["asked on review"]);
  });

  it("writes ONE row per turn and never re-writes an existing one", async () => {
    await store.appendRunWindowMessage({
      runId: "run-1", role: "user", surface: "review", text: "one",
    });
    await store.appendRunWindowMessage({
      runId: "run-1", role: "assistant", surface: "review", text: "two",
    });
    // The shape #2909 warns about is a whole-transcript body that can commit
    // late and undo a newer one. There is no such body here: two turns produced
    // two inserts, each carrying ONLY its own text.
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls.map((c) => c.content)).toEqual(["one", "two"]);
    for (const call of insertCalls) {
      expect(typeof call.content).toBe("string");
      expect(String(call.contentJson)).not.toContain("transcript");
    }
  });

  it("retries onto the next free sequence when two turns race for one number", async () => {
    await store.appendRunWindowMessage({
      runId: "run-1", role: "user", surface: "review", text: "first",
    });
    // The next insert loses the race for sequence 2 exactly once.
    failNextInsertWithUnique = 1;
    const second = await store.appendRunWindowMessage({
      runId: "run-1", role: "assistant", surface: "review", text: "second",
    });
    expect(second.text).toBe("second");
    // Two attempts, one landed — and the row that lost is not the row that
    // disappears: both messages are readable.
    expect(insertCalls).toHaveLength(3);
    const after = await store.readRunWindowMessages("run-1");
    expect(after.map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("refuses a window name it does not know, instead of storing it and relabelling it", async () => {
    await expect(
      store.appendRunWindowMessage({
        runId: "run-1",
        role: "user",
        // A server action's payload is whatever reached the process; TypeScript
        // checks nothing at that boundary.
        surface: "somewhere-else" as never,
        text: "hello",
      }),
    ).rejects.toThrow(/Unknown prompt window/);
    expect(insertCalls).toHaveLength(0);
  });

  it("records which message an answer answered, and round-trips it", async () => {
    const asked = await store.appendRunWindowMessage({
      runId: "run-1", role: "user", surface: "review", text: "tighten it",
    });
    await store.appendRunWindowMessage({
      runId: "run-1", role: "assistant", surface: "review", text: "Done.",
      replyToSequence: asked.sequence,
    });
    const after = await store.readRunWindowMessages("run-1");
    expect(after[0]?.replyToSequence).toBeNull();
    // Adjacency is not the pairing: two turns in flight can land interleaved.
    expect(after[1]?.replyToSequence).toBe(asked.sequence);
  });

  it("marks every row with the window discriminator the replay reader excludes", async () => {
    await store.appendRunWindowMessage({
      runId: "run-1", role: "user", surface: "schedule", text: "every monday at 9",
    });
    expect(insertCalls[0].messageType).toBe(store.RUN_WINDOW_MESSAGE_TYPE);
    expect(store.RUN_WINDOW_MESSAGE_TYPE).toBe("window");
  });
});

// ---------------------------------------------------------------------------
// W5C ADDITIONS (cinatra#2934) — the fill and the files, kept with the run.
//
// The plan: "the assistant returns the filled values, the screen writes them
// into its own fields" and "A file attached beside your message travels with
// your answer to the waiting agent exactly as it does today … must not leave it
// behind when the answer is finally sent." Both are stored HERE, on the run,
// because that is the only place both halves of each road can read them: the
// screen writes the values into its fields, and the submit reads back what was
// shown and what was attached.
// ---------------------------------------------------------------------------
describe("the fill and the attached files are kept with the run too", () => {
  it("stores a fill as a row of its own, with no text of its own", async () => {
    await store.appendRunWindowMessage({
      runId: "run-1",
      role: "assistant",
      surface: "run-page",
      text: "",
      fill: { ref: "ref-a", values: { subject: "Hello" } },
    });
    const rowsBack = await store.readRunWindowMessages("run-1");
    expect(rowsBack).toHaveLength(1);
    expect(rowsBack[0]?.text).toBe("");
    expect(rowsBack[0]?.fill).toEqual({ ref: "ref-a", values: { subject: "Hello" } });
  });

  it("hands the submit THIS MESSAGE's fills for that screen, in order, and no others", async () => {
    // Two turns on the same run — a second tab, or a second person. A submit
    // must send what ITS OWN message placed, never the run's newest values.
    await store.appendRunWindowMessage({
      runId: "run-1", role: "assistant", surface: "run-page", text: "",
      fill: { ref: "ref-a", values: { subject: "mine, first" } }, messageId: "turn-1",
    });
    await store.appendRunWindowMessage({
      runId: "run-1", role: "assistant", surface: "run-page", text: "",
      fill: { ref: "ref-b", values: { subject: "another screen" } }, messageId: "turn-1",
    });
    await store.appendRunWindowMessage({
      runId: "run-1", role: "assistant", surface: "run-page", text: "",
      fill: { ref: "ref-a", values: { body: "mine, second" } }, messageId: "turn-1",
    });
    await store.appendRunWindowMessage({
      runId: "run-1", role: "assistant", surface: "run-page", text: "",
      fill: { ref: "ref-a", values: { subject: "SOMEBODY ELSE'S" } }, messageId: "turn-2",
    });
    // BOTH of this message's fills, oldest first — a turn that filled twice left
    // both in the fields.
    expect(await store.readRunWindowFillsForMessage("run-1", "ref-a", "turn-1")).toEqual([
      { ref: "ref-a", values: { subject: "mine, first" } },
      { ref: "ref-a", values: { body: "mine, second" } },
    ]);
    // Another screen, another message, and a row written before message ids
    // existed: none of them.
    expect(await store.readRunWindowFillsForMessage("run-1", "ref-c", "turn-1")).toEqual([]);
    expect(await store.readRunWindowFillsForMessage("run-1", "ref-a", "")).toEqual([]);
  });

  it("keeps the files on the person's own row, and reads back THIS message's", async () => {
    await store.appendRunWindowMessage({
      runId: "run-1", role: "user", surface: "run-page", text: "here is the brief",
      attachments: [{ artifactId: "a1" }], messageId: "turn-1",
    });
    await store.appendRunWindowMessage({
      runId: "run-1", role: "assistant", surface: "run-page", text: "Got it.",
      messageId: "turn-1",
    });
    // A LATER turn's file must not travel under this message's press.
    await store.appendRunWindowMessage({
      runId: "run-1", role: "user", surface: "run-page", text: "and this one",
      attachments: [{ artifactId: "b1" }], messageId: "turn-2",
    });
    expect(await store.readRunWindowAttachmentsForMessage("run-1", "turn-1")).toEqual([
      { artifactId: "a1" },
    ]);
    expect(await store.readRunWindowAttachmentsForMessage("run-1", "turn-3")).toBeNull();
    const rowsBack = await store.readRunWindowMessages("run-1");
    expect(rowsBack[0]?.attachments).toEqual([{ artifactId: "a1" }]);
    // The ANSWER carries none of its own — the files are the person's.
    expect(rowsBack[1]?.attachments).toBeNull();
  });

  it("reads a malformed body as no fill and no files, rather than half-reading it", async () => {
    await store.appendRunWindowMessage({
      runId: "run-1", role: "assistant", surface: "run-page", text: "plain",
    });
    rows[0].contentJson = JSON.stringify({
      messageType: "window", role: "assistant", surface: "run-page", text: "plain",
      fill: { ref: "" }, attachments: "not an array",
    });
    const rowsBack = await store.readRunWindowMessages("run-1");
    expect(rowsBack[0]?.fill).toBeNull();
    expect(rowsBack[0]?.attachments).toBeNull();
  });
});
