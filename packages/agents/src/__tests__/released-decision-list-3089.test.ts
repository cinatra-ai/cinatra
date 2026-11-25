// cinatra#3089: the ONE list of records a person released with a publish decision (`releasedDecisionList`), read from
// the decision's frozen values and checked against the list row of the card drawn from them. Pure: no database.
import { describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ db: {} }));

import { releasedDecisionList, releasedDecisionText } from "../publish-decision-store";

const FIELDS = ["artifactId", "representationRevisionId", "contactId", "recipientEmail", "subject"] as const;
const SHOWN = [{ field: "recipientEmail", column: "email" }, { field: "subject", column: "subject" }];

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

  it("L2 a list surfaced as JSON text is a list, but no card draws its bodies, so it is refused", () => {
    const list = entries(2);
    // red-first-expect: is not a function
    const answer = read(decision(JSON.stringify(list), { shown: list.map((e) => ({ email: e.recipientEmail, subject: e.subject })) }));
    expect(answer).toEqual({ ok: false, error: "no artifacts row of the released publish decision draws the bodies of the released list" });
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

  it("L8 a shown value is compared exactly: the entry is what is sent, so it must be the very cell the card drew", () => {
    const list = entries(1);
    const shownAs = (email: string, subject = "Subject 0") => decision(list, { shown: [{ email, subject }] });
    // Each of these looks the same, or nearly so, on the screen, and each is another value than the one sent.
    for (const d of [
      shownAs("  p0@example.com "),
      shownAs("p0@example.com\u00a0"),
      shownAs("P0@Example.com"),
      shownAs("p0@example.com", " Subject 0 "),
      shownAs("p0@example.com", "Subject  0"),
      shownAs("p0@example.com", "Subject\u00a00"),
    ]) {
      // red-first-expect: is not a function
      expect(read(d).ok).toBe(false);
    }
    // The same visible text in two Unicode normalisation forms is two values.
    const nfc = "R\u00e9sum\u00e9";
    const decomposed = [{ ...list[0]!, subject: nfc.normalize("NFD") }];
    expect(read(decision(decomposed, { shown: [{ email: "p0@example.com", subject: nfc }] })).ok).toBe(false);
    // Byte for byte equal: answered as released, never trimmed or normalised.
    const padded = [{ ...list[0]!, subject: " Padded  subject\u00a0" }];
    expect(read(decision(padded))).toEqual({ ok: true, list: padded });
  });

  it("L9 one drawn cell never proves two fields: each field is read from its own named column", () => {
    const list = [{ ...entries(1)[0]!, subject: "p0@example.com" }];
    const onlyEmail = {
      ...decision(list, { shown: [{ email: "p0@example.com" }] }),
      declaredRows: [{ kind: "list" as const, label: "Recipients", input: "recipients", columns: [{ label: "Email", field: "email" }] }],
    };
    const NO_ROW = { ok: false, error: "no list row of the released publish decision shows each record of the released list" };
    // red-first-expect: is not a function
    expect(read(onlyEmail as ReturnType<typeof decision>)).toEqual(NO_ROW);
    // The values drawn in each other's column do not show the entry either.
    const swapped = decision(entries(1), { shown: [{ email: "Subject 0", subject: "p0@example.com" }] });
    expect(read(swapped)).toEqual(NO_ROW);
    // A row that draws the named column under another field shows nothing.
    const otherColumn = {
      ...decision(entries(1), { shown: [{ mail: "p0@example.com", subject: "Subject 0" }] }),
      declaredRows: [{ kind: "list" as const, label: "Recipients", input: "recipients", columns: [{ label: "Email", field: "mail" }, { label: "Subject", field: "subject" }] }],
    };
    expect(read(otherColumn as ReturnType<typeof decision>)).toEqual(NO_ROW);
  });

  it("L10 a column named for two fields, or a field named twice, is refused", () => {
    const d = decision(entries(1));
    const twiceColumn = releasedDecisionList({ decision: d, entryFields: FIELDS, shownFields: [{ field: "recipientEmail", column: "email" }, { field: "subject", column: "email" }] });
    // red-first-expect: is not a function
    expect(twiceColumn.ok).toBe(false);
    const twiceField = releasedDecisionList({ decision: d, entryFields: FIELDS, shownFields: [{ field: "subject", column: "email" }, { field: "subject", column: "subject" }] });
    expect(twiceField.ok).toBe(false);
    const noColumn = releasedDecisionList({ decision: d, entryFields: FIELDS, shownFields: [{ field: "recipientEmail", column: "" }] });
    expect(noColumn.ok).toBe(false);
    const notAnEntryField = releasedDecisionList({ decision: d, entryFields: FIELDS, shownFields: [{ field: "name", column: "email" }] });
    expect(notAnEntryField.ok).toBe(false);
  });

  it("L11 the bodies count only when the decision declares an artifacts row over the same surfaced list (not a proof of what the screen drew)", () => {
    const list = entries(2);
    const NO_BODIES = { ok: false, error: "no artifacts row of the released publish decision draws the bodies of the released list" };
    const noArtifactsRow = { ...decision(list), declaredRows: decision(list).declaredRows.filter((r) => r.kind !== "artifacts") };
    // red-first-expect: is not a function
    expect(read(noArtifactsRow as ReturnType<typeof decision>)).toEqual(NO_BODIES);
    const otherInput = { ...decision(list), declaredRows: decision(list).declaredRows.map((r) => (r.kind === "artifacts" ? { ...r, input: "recipients" } : r)) };
    expect(read(otherInput as ReturnType<typeof decision>)).toEqual(NO_BODIES);
    // A target id with a space is not drawn by the card, so it is not shown.
    const spaced = [{ ...list[0]!, artifactId: "art 0" }, list[1]!];
    expect(read(decision(spaced))).toEqual(NO_BODIES);
  });

  it("L12 a released text counts only when a declared text row draws it", () => {
    const rows = [{ label: "From", input: "senderEmail" }];
    const released = (surfacedValues: Record<string, unknown>, declaredRows: unknown = rows) =>
      ({ status: "released", decidedBy: "user-2", surfacedValues, declaredRows }) as Parameters<typeof releasedDecisionText>[0]["decision"];
    // red-first-expect: releasedDecisionText is not a function
    expect(releasedDecisionText({ decision: released({ senderEmail: "a@example.com" }), input: "senderEmail" })).toEqual({ ok: true, value: "a@example.com" });
    // The value the row drew, as it drew it: never trimmed (the caller compares and sends this very value).
    expect(releasedDecisionText({ decision: released({ senderEmail: " a@example.com " }), input: "senderEmail" })).toEqual({ ok: true, value: " a@example.com " });
    // Blank or absent: the card draws no row and nothing is released.
    expect(releasedDecisionText({ decision: released({ senderEmail: "  " }), input: "senderEmail" })).toEqual({ ok: true, value: null });
    expect(releasedDecisionText({ decision: released({}), input: "senderEmail" })).toEqual({ ok: true, value: null });
    // A value the card never drew is refused, never used.
    const NOT_SHOWN = { ok: false, error: "the publish decision surfaced senderEmail, but no row of its card showed it" };
    expect(releasedDecisionText({ decision: released({ senderEmail: "a@example.com" }, []), input: "senderEmail" })).toEqual(NOT_SHOWN);
    expect(releasedDecisionText({ decision: released({ senderEmail: "a@example.com" }, null), input: "senderEmail" })).toEqual(NOT_SHOWN);
    expect(releasedDecisionText({ decision: released({ senderEmail: "a@example.com" }, [{ kind: "list", label: "From", input: "senderEmail", columns: [] }]), input: "senderEmail" })).toEqual(NOT_SHOWN);
    expect(releasedDecisionText({ decision: released({ senderEmail: 7 }), input: "senderEmail" }).ok).toBe(false);
    expect(releasedDecisionText({ decision: { ...released({ senderEmail: "a@example.com" }), status: "parked" }, input: "senderEmail" }).ok).toBe(false);
  });
});
