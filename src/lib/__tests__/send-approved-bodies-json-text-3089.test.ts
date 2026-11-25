/**
 * cinatra#3089 — the send's `approvedBodies` also arrives as JSON text.
 *
 * A model-free flow step reaches the send through the passthrough road, which
 * delivers a flow's template values as strings: the flow writes
 * `{{ emailBodies | tojson }}` and the list arrives as JSON text. The tool's
 * schema therefore accepts the list in both forms, the array and a JSON text
 * that parses to that same array, and the text goes through the SAME entry
 * schema and 1..50 bounds as the array. Whatever does not parse to a valid list
 * is refused by the schema, before the handler reads or mails anything.
 *
 *   npx vitest run src/lib/__tests__/send-approved-bodies-json-text-3089.test.ts
 */
import { describe, expect, it } from "vitest";
import { serviceAndCampaignIdSchema } from "../../../packages/trigger-email-send/src/mcp/schemas";

const base = { campaignId: "33333333-3333-4333-8333-333333333333" };

function entries(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    artifactId: `art-${i}`,
    representationRevisionId: `rev-${i}`,
    contactId: `contact-${i}`,
    recipientEmail: `p${i}@example.com`,
    subject: `Subject ${i}`,
  }));
}

function parseBodies(approvedBodies: unknown) {
  return serviceAndCampaignIdSchema.safeParse({ ...base, approvedBodies });
}

describe("approvedBodies as JSON text (cinatra#3089)", () => {
  it("J1 a JSON text of the list yields the same parsed value as the array", () => {
    const list = entries(2);
    const fromArray = parseBodies(list);
    const fromText = parseBodies(JSON.stringify(list));
    expect(fromArray.success).toBe(true);
    expect(fromText.success).toBe(true);
    expect(fromText.data).toEqual(fromArray.data);
    // red-first-expect: expected undefined to deeply equal [ { artifactId: 'art-0', …(4) }, …(1) ]
    expect(fromText.data?.approvedBodies).toEqual(list);
  });

  it("J2 the text of 50 entries is accepted and the text of 51 is refused", () => {
    expect(parseBodies(JSON.stringify(entries(50))).success).toBe(true);
    // red-first-expect: expected true to be false
    expect(parseBodies(JSON.stringify(entries(51))).success).toBe(false);
  });

  it("J3 the text form is refused when it does not parse or is not a list", () => {
    const texts = ["", "   ", "{not json", "[{", "null", "7", '"abc"', "true", JSON.stringify(entries(1)[0])];
    for (const text of texts) {
      const result = parseBodies(text);
      // red-first-expect: text "": expected true to be false
      expect(result.success, `text ${JSON.stringify(text)}`).toBe(false);
      expect(result.error?.issues.some((i) => i.path[0] === "approvedBodies" && /not valid JSON|JSON list/.test(i.message))).toBe(true);
    }
  });

  it("J4 the text form is refused for an empty list, as the array form is", () => {
    // red-first-expect: expected true to be false
    expect(parseBodies([]).success).toBe(false);
    expect(parseBodies("[]").success).toBe(false);
    const result = parseBodies("[]");
    expect(result.error?.issues.some((i) => /Too small/.test(i.message))).toBe(true);
  });

  it("J5 the text form is refused for an unknown key, a missing key or a wrong type, as the array form is", () => {
    const [entry] = entries(1);
    const refused = [
      [{ ...entry, text: "x" }],
      [{ artifactId: "a", representationRevisionId: "r" }],
      [{ artifactId: "a", representationRevisionId: "r", contactId: "c", subject: "S" }],
      [{ artifactId: "a", representationRevisionId: "r", contactId: "c", recipientEmail: "p@example.com" }],
      [entry, { artifactId: "a", representationRevisionId: "r", contactId: "c" }],
      [{ ...entry, recipientEmail: 7 }],
      [{ ...entry, subject: null }],
      [{ ...entry, artifactId: 7 }],
      [{ ...entry, contactId: "   " }],
      [{ ...entry, artifactId: "x".repeat(201) }],
      ["art-0"],
      [null],
    ];
    for (const list of refused) {
      const asArray = parseBodies(list);
      const asText = parseBodies(JSON.stringify(list));
      // red-first-expect: array [{"artifactId":"art-0","representationRevisionId":"rev-0","contactId":"contact-0","recipientEmail":"p0@example.com","subject":"Subject 0","text":"x"}]: expected true to be false
      expect(asArray.success, `array ${JSON.stringify(list)}`).toBe(false);
      expect(asText.success, `text ${JSON.stringify(list)}`).toBe(false);
      expect(asText.error?.issues.map((i) => i.message)).toEqual(asArray.error?.issues.map((i) => i.message));
    }
  });

  it("J6 a list inside a string inside the text (a double encoding) is refused", () => {
    const result = parseBodies(JSON.stringify(JSON.stringify(entries(1))));
    // red-first-expect: expected true to be false
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => /not valid JSON|JSON list/.test(i.message))).toBe(true);
  });

  it("J7 the array form and the absent form are unchanged", () => {
    const list = entries(3);
    // red-first-expect: expected undefined to deeply equal [ { artifactId: 'art-0', …(4) }, …(2) ]
    expect(parseBodies(list).data?.approvedBodies).toEqual(list);
    expect(serviceAndCampaignIdSchema.parse(base).approvedBodies).toBeUndefined();
    expect(parseBodies(entries(51)).success).toBe(false);
    expect(parseBodies(undefined).success).toBe(true);
    expect(parseBodies(5).success).toBe(false);
    expect(parseBodies({ artifactId: "a" }).success).toBe(false);
  });
});
