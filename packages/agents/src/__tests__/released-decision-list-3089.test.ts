// cinatra#3089: the ONE list of records a person released with a publish decision (`releasedDecisionList`), read from
// the decision's frozen values and checked against the list row of the card drawn from them. Pure: no database.
import { describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ db: {} }));

import { releasedDecisionList } from "../publish-decision-store";

const FIELDS = ["artifactId", "representationRevisionId", "contactId", "recipientEmail", "subject"] as const;
const SHOWN = [{ field: "recipientEmail" }, { field: "subject" }];

function entries(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    artifactId: `art-${i}`,
    representationRevisionId: `rev-${i}`,
    contactId: `contact-${i}`,
    recipientEmail: `p${i}@example.com`,
    subject: `Subject ${i}`,
  }));
}

/** A released decision whose card shows `shown` on its list row and surfaces `list` as `emailBodies`. */
function decision(list: unknown, opts?: { shown?: Array<Record<string, unknown>>; status?: string; decidedBy?: string | null; extra?: Record<string, unknown> }) {
  const rows =
    opts?.shown ??
    (Array.isArray(list) ? list : entries(2)).map((e) => ({ email: e?.recipientEmail, subject: e?.subject }));
  return {
    status: (opts?.status ?? "released") as "released",
    decidedBy: opts && "decidedBy" in opts ? (opts.decidedBy ?? null) : "user-2",
    surfacedValues: { campaignId: "camp-1", recipients: rows, emailBodies: list, ...(opts?.extra ?? {}) },
    declaredRows: [
      { kind: "list" as const, label: "Recipients", input: "recipients", columns: [{ label: "Email", field: "email" }, { label: "Subject", field: "subject" }] },
      { kind: "artifacts" as const, label: "Emails", input: "emailBodies" },
    ],
  };
}

const read = (d: ReturnType<typeof decision>) => releasedDecisionList({ decision: d, entryFields: FIELDS, shownFields: SHOWN });

describe("releasedDecisionList (cinatra#3089)", () => {
  it("L1 the one surfaced list is answered as it was released", () => {
    const list = entries(2);
    // red-first-expect: is not a function
    expect(read(decision(list))).toEqual({ ok: true, list });
  });

  it("L2 a surfaced value as JSON text answers the same list as the array", () => {
    const list = entries(2);
    // red-first-expect: is not a function
    expect(read(decision(JSON.stringify(list), { shown: list.map((e) => ({ email: e.recipientEmail, subject: e.subject })) }))).toEqual({ ok: true, list });
  });

  it("L3 a decision that is not released by a person answers an error", () => {
    // red-first-expect: is not a function
    expect(read(decision(entries(1), { status: "parked" })).ok).toBe(false);
    expect(read(decision(entries(1), { status: "declined" })).ok).toBe(false);
    expect(read(decision(entries(1), { decidedBy: null }))).toEqual({ ok: false, error: "the publish decision is not released by a person" });
    expect(read(decision(entries(1), { decidedBy: "" })).ok).toBe(false);
  });

  it("L4 no surfaced list of the entry shape answers no list", () => {
    const notLists: unknown[] = [
      undefined, "", "   ", "{not json", "[{", "null", "7", '"abc"', "true", [], "[]",
      JSON.stringify(entries(1)[0]),
      JSON.stringify(JSON.stringify(entries(1))),
      entries(51), JSON.stringify(entries(51)),
      [{ ...entries(1)[0], text: "x" }],
      [{ artifactId: "a", representationRevisionId: "r" }],
      [{ ...entries(1)[0], recipientEmail: 7 }],
      [{ ...entries(1)[0], subject: null }],
      [entries(1)[0], null],
      ["art-0"],
    ];
    for (const value of notLists) {
      // red-first-expect: is not a function
      expect(read(decision(value)), JSON.stringify(value)).toEqual({ ok: true, list: null });
    }
  });

  it("L5 50 entries are a list and 51 are none", () => {
    const fifty = entries(50);
    // red-first-expect: is not a function
    expect(read(decision(fifty))).toEqual({ ok: true, list: fifty });
    expect(read(decision(entries(51)))).toEqual({ ok: true, list: null });
  });

  it("L6 two surfaced lists of the entry shape answer an error: which one was released cannot be told", () => {
    const list = entries(2);
    // red-first-expect: is not a function
    const answer = read(decision(list, { extra: { other: JSON.stringify(list) } }));
    expect(answer.ok).toBe(false);
    expect((answer as { error: string }).error).toContain("surfaced 2 lists");
  });

  it("L7 a list no card row shows record for record answers an error", () => {
    const list = entries(2);
    const shown = list.map((e) => ({ email: e.recipientEmail, subject: e.subject }));
    const refusals = [
      { ...decision(list), declaredRows: [] },
      { ...decision(list), declaredRows: null },
      { ...decision(list), declaredRows: [{ label: "Recipients", input: "recipients" }] },
      decision(list, { shown: [shown[1]!, shown[0]!] }),
      decision(list, { shown: [shown[0]!] }),
      decision(list, { shown: [shown[0]!, { ...shown[1]!, email: "other@example.com" }] }),
      decision(list, { shown: [shown[0]!, { ...shown[1]!, subject: "Subject 9" }] }),
      decision(list, { shown: [shown[0]!, { ...shown[1]!, email: "P1@EXAMPLE.COM" }] }),
    ];
    for (const d of refusals) {
      // red-first-expect: is not a function
      expect(read(d as ReturnType<typeof decision>)).toEqual({
        ok: false,
        error: "no list row of the released publish decision shows each record of the released list",
      });
    }
  });

  it("L8 a shown value is compared trimmed, and in any letter case only where the caller asks", () => {
    const list = entries(1);
    const padded = decision(list, { shown: [{ email: "  p0@example.com ", subject: "Subject 0" }] });
    // red-first-expect: is not a function
    expect(read(padded).ok).toBe(true);
    const upper = decision(list, { shown: [{ email: "P0@Example.com", subject: "Subject 0" }] });
    expect(read(upper).ok).toBe(false);
    expect(
      releasedDecisionList({ decision: upper, entryFields: FIELDS, shownFields: [{ field: "recipientEmail", caseInsensitive: true }, { field: "subject" }] }).ok,
    ).toBe(true);
  });
});
