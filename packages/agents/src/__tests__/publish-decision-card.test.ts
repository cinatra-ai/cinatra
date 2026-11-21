// cinatra#4150 part 7a-1a: the publish card's state shape and its transport parse.
// A parse that returns null is a FAILURE, never a state: the card keeps its last authorized answer rather than settling
// on a shape it did not understand. Every state the card draws round-trips.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PUBLISH_DECISION_CARD_NONE,
  PUBLISH_LIST_ROW_ITEMS_MAX,
  PUBLISH_ROW_COLUMNS_MAX,
  PUBLISH_ROWS_MAX,
  parsePublishDecisionCardState,
  publishDecisionCardRows,
  publishRowKind,
  type PublishRowDeclaration,
  type PublishDecisionCardState,
} from "../publish-decision-card";

const COMMON = { runId: "run-1", agentName: "Launch writer", rows: [{ label: "Title", value: "Autumn launch" }] };

describe("parsePublishDecisionCardState", () => {
  it.each<PublishDecisionCardState>([
    { state: "none" },
    { state: "pending", ...COMMON, mayDecide: true },
    { state: "pending", ...COMMON, rows: [], mayDecide: false },
    { state: "approved", ...COMMON, deciderName: "Dana Okafor" },
    { state: "approved", ...COMMON, deciderName: null },
    { state: "declined", ...COMMON, deciderName: "Dana Okafor", reason: "Not ready yet." },
    { state: "declined", ...COMMON, deciderName: null, reason: null },
    { state: "expired", ...COMMON },
  ])("round-trips %o", (state) => {
    expect(parsePublishDecisionCardState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("none is the frozen silence", () => {
    expect(parsePublishDecisionCardState({ state: "none" })).toBe(PUBLISH_DECISION_CARD_NONE);
    expect(Object.isFrozen(PUBLISH_DECISION_CARD_NONE)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "pending"],
    ["an unknown state", { ...COMMON, state: "loading" }],
    ["no run id", { ...COMMON, state: "expired", runId: "" }],
    ["no agent name", { ...COMMON, state: "expired", agentName: 7 }],
    ["rows not a list", { ...COMMON, state: "expired", rows: {} }],
    ["a row without a value", { ...COMMON, state: "expired", rows: [{ label: "Title" }] }],
    ["a pending card without mayDecide", { ...COMMON, state: "pending" }],
    ["an approved card with a numeric name", { ...COMMON, state: "approved", deciderName: 1 }],
    ["a declined card without a reason field", { ...COMMON, state: "declined", deciderName: null }],
  ])("refuses %s", (_name, data) => {
    expect(parsePublishDecisionCardState(data)).toBeNull();
  });

  it("drops fields the state does not carry", () => {
    expect(
      parsePublishDecisionCardState({ ...COMMON, state: "expired", deciderName: "Dana Okafor", extra: 1 }),
    ).toEqual({ state: "expired", ...COMMON });
  });
});

describe("the split between the shape and the read", () => {
  const src = (name: string) => readFileSync(join(__dirname, "..", name), "utf8");
  it("the shape module a card imports reaches no store, database or server-only module", () => {
    const imports = [...src("publish-decision-card.ts").matchAll(/from\s+"([^"]+)"|import\s+"([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    expect(imports).toEqual([]);
  });
  it("the read is server-only and the session entry is a server action", () => {
    expect(src("publish-decision-card-core.ts")).toMatch(/^import "server-only";/m);
    expect(src("publish-decision-card-actions.ts").startsWith('"use server";')).toBe(true);
  });
});

// cinatra#4150 W4: the list row. A table over a surfaced list of records, its cells plain text, capped, with the total.
const LIST_DECL = {
  kind: "list" as const,
  label: "Recipients",
  input: "people",
  columns: [
    { label: "Name", field: "name" },
    { label: "Email", field: "email" },
  ],
};
const LIST_ROW = { kind: "list", label: "Recipients", columns: ["Name", "Email"], items: [["Ada", "ada@example.test"]], total: 3 };

describe("the list row (W4)", () => {
  it("the caps are four rows, four columns and fifty records", () => {
    expect([PUBLISH_ROWS_MAX, PUBLISH_ROW_COLUMNS_MAX, PUBLISH_LIST_ROW_ITEMS_MAX]).toEqual([4, 4, 50]);
  });

  it("projects each record into one cell per column, plain values only, an absent or nested field as an empty cell", () => {
    const rows = publishDecisionCardRows([{ label: "Title", input: "title" }, LIST_DECL], {
      title: "Autumn",
      people: [
        { name: "Ada", email: "ada@example.test", secretId: "row-77" },
        { name: "Bo", email: { raw: "x" } },
        "not a record",
        { name: 7, email: true },
      ],
    });
    expect(rows).toEqual([
      { label: "Title", value: "Autumn" },
      { kind: "list", label: "Recipients", columns: ["Name", "Email"], items: [["Ada", "ada@example.test"], ["Bo", ""], ["7", "true"]], total: 3 },
    ]);
    expect(JSON.stringify(rows)).not.toContain("row-77");
  });

  it("draws at most fifty records and counts them all", () => {
    const people = Array.from({ length: 120 }, (_, i) => ({ name: `P${i}`, email: `p${i}@example.test` }));
    const [row] = publishDecisionCardRows([LIST_DECL], { people });
    expect(row).toMatchObject({ kind: "list", total: 120 });
    expect((row as { items: string[][] }).items).toHaveLength(50);
    expect((row as { items: string[][] }).items[49]).toEqual(["P49", "p49@example.test"]);
  });

  it("a list with no record, a value that is not a list, and a missing input draw no row", () => {
    for (const surfaced of [{ people: [] }, { people: ["a", 1] }, { people: "Ada" }, {}]) {
      expect(publishDecisionCardRows([LIST_DECL], surfaced)).toEqual([]);
    }
  });

  it("a field named after an Object.prototype member reads as an empty cell", () => {
    const decl = { ...LIST_DECL, columns: [{ label: "C", field: "constructor" }] };
    expect(publishDecisionCardRows([decl], { people: [{}] })).toEqual([
      { kind: "list", label: "Recipients", columns: ["C"], items: [[""]], total: 1 },
    ]);
  });

  it("round-trips a card that holds a text row and a list row", () => {
    const state = { state: "pending", ...COMMON, rows: [...COMMON.rows, LIST_ROW], mayDecide: true };
    expect(parsePublishDecisionCardState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it.each([
    ["an artifacts row", { kind: "artifacts", label: "Page", targets: [] }],
    ["a text row that carries a kind", { kind: "text", label: "Title", value: "x" }],
    ["a list row with no items", { ...LIST_ROW, items: [] }],
    ["a list row with five columns", { ...LIST_ROW, columns: ["a", "b", "c", "d", "e"], items: [["1", "2", "3", "4", "5"]] }],
    ["a list row whose record has the wrong cell count", { ...LIST_ROW, items: [["Ada"]] }],
    ["a list row with a cell that is not text", { ...LIST_ROW, items: [["Ada", 1]] }],
    ["a list row whose total is under its items", { ...LIST_ROW, total: 0 }],
    ["a list row with 51 items", { ...LIST_ROW, items: Array.from({ length: 51 }, () => ["a", "b"]), total: 51 }],
  ])("refuses %s", (_name, row) => {
    // Red first at the base: the base reads a list row as unreadable too, so the valid list row is pinned first.
    expect(parsePublishDecisionCardState({ ...COMMON, state: "expired", rows: [LIST_ROW] })).not.toBeNull();
    expect(parsePublishDecisionCardState({ ...COMMON, state: "expired", rows: [row] })).toBeNull();
  });
});

// pre-2 findings 2 and 4: the transport holds the four-row cap, and every reader takes a row's kind from its OWN property
// only, so an inherited kind or a kind no reader draws is never drawn as something else. Each case is red at base 46f770fe.
describe("the row cap on the transport and the own-kind reading (pre-2)", () => {
  const TEXT = { label: "Title", value: "x" };

  it("four transported rows parse; five are unreadable", () => {
    expect(parsePublishDecisionCardState({ ...COMMON, state: "expired", rows: [TEXT, TEXT, TEXT, LIST_ROW] })).not.toBeNull();
    expect(parsePublishDecisionCardState({ ...COMMON, state: "expired", rows: [TEXT, TEXT, TEXT, TEXT, LIST_ROW] })).toBeNull();
  });

  it("publishRowKind reads only an own kind: none is text, own list is list, any other own kind is null", () => {
    const inherited = Object.assign(Object.create({ kind: "list" }), { label: "Title", value: "x" }) as object;
    expect(publishRowKind(inherited)).toBe("text");
    expect(publishRowKind({ kind: "list" })).toBe("list");
    for (const kind of ["artifacts", "text", undefined, null]) expect(publishRowKind({ kind })).toBeNull();
  });

  it("a declaration whose list kind is inherited projects as the text row it is", () => {
    const proto = { kind: "list", columns: [{ label: "Name", field: "name" }] };
    const decl = Object.assign(Object.create(proto), { label: "Title", input: "title" }) as PublishRowDeclaration;
    expect(publishDecisionCardRows([decl], { title: "Autumn" })).toEqual([{ label: "Title", value: "Autumn" }]);
  });

  // fold3 NOTE 3: a transported list row meets the compiler's label rule (red at f3722269: only "is text" was checked).
  it.each([
    ["an empty list label", { ...LIST_ROW, label: "" }],
    ["a list label with a line break", { ...LIST_ROW, label: "Re\ncipients" }],
    ["a list label over 60 characters", { ...LIST_ROW, label: "x".repeat(61) }],
    ["an empty column label", { ...LIST_ROW, columns: ["", "Email"] }],
    ["a column label with a leading space", { ...LIST_ROW, columns: [" Name", "Email"] }],
  ])("a transported list row with %s is unreadable", (_name, row) => {
    expect(parsePublishDecisionCardState({ ...COMMON, state: "expired", rows: [LIST_ROW] })).not.toBeNull();
    expect(parsePublishDecisionCardState({ ...COMMON, state: "expired", rows: [row] })).toBeNull();
  });

  it("a declaration with an own kind no reader draws is dropped, never drawn as text", () => {
    const decl = { kind: "artifacts", label: "Page", input: "page" } as unknown as PublishRowDeclaration;
    expect(publishDecisionCardRows([decl, { label: "Title", input: "title" }], { page: "row-77", title: "Autumn" })).toEqual([
      { label: "Title", value: "Autumn" },
    ]);
  });
});
