/**
 * cinatra#4244 - what the WayFlow continue road records as the submitted
 * values of a gate answer, while the resume text goes to the flow verbatim.
 *
 * A schema-drawn gate that asks for ONE text field sends that text verbatim as
 * `userResponse` (the flow's InputMessageNode has one string output) and names
 * the field it belongs to in `userResponseFieldName`. The server records the
 * answer under that field, even when the text itself reads as JSON. Every
 * other road keeps the reading it had.
 *
 * The reader lives in hitl-gate-submit.ts, beside the payload builder that
 * names the field. A module of its own would add a first-party module to every
 * locked route of the route-graph ratchet.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run src/__tests__/wayflow-submitted-values-4244.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Reader = (values: unknown) => Record<string, unknown> | null;

async function reader(): Promise<Reader> {
  const mod = (await import("../hitl-gate-submit").catch(() => ({}))) as {
    readWayflowSubmittedValues?: Reader;
  };
  if (typeof mod.readWayflowSubmittedValues !== "function") {
    throw new Error("readWayflowSubmittedValues is not exported");
  }
  return mod.readWayflowSubmittedValues;
}

const STAMP = { approved: true, approvedAt: "2026-11-12T00:00:00.000Z" };

describe("readWayflowSubmittedValues (cinatra#4244)", () => {
  it("records a named single text answer under its field, JSON-looking or not", async () => {
    const read = await reader();
    for (const text of ["42", '{"tone":"warm"}', "null", "Warm."]) {
      expect(
        read({ brandVoice: text, ...STAMP, userResponse: text, userResponseFieldName: "brandVoice" }),
        text,
      ).toEqual({ brandVoice: text });
    }
  });

  it("records a named answer to a field called __proto__ as an own key", async () => {
    const read = await reader();
    const values = JSON.parse(
      '{"__proto__":"warm","userResponse":"warm","userResponseFieldName":"__proto__"}',
    );
    const out = read(values)!;
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toBe("warm");
  });

  it("keeps the earlier readings for every other road", async () => {
    const read = await reader();
    // Structured round-trip: the JSON object in userResponse.
    expect(read({ ...STAMP, userResponse: '{"tags":["a"]}' })).toEqual({ tags: ["a"] });
    // Text that is not JSON: the values without userResponse.
    expect(read({ note: "x", ...STAMP, userResponse: "plain" })).toEqual({ note: "x", ...STAMP });
    // A field name whose value is not the resume text is not believed.
    expect(
      read({ brandVoice: "other", ...STAMP, userResponse: '{"a":1}', userResponseFieldName: "brandVoice" }),
    ).toEqual({ a: 1 });
    // No userResponse: the values themselves.
    expect(read({ ...STAMP })).toEqual({ ...STAMP });
    expect(read(null)).toBeNull();
  });
});

describe("approveReviewTaskInternal uses the reader (cinatra#4244)", () => {
  it("reads the submitted values through readWayflowSubmittedValues", () => {
    const src = readFileSync(join(__dirname, "..", "review-task-actions.ts"), "utf8");
    expect(src).toMatch(/submittedValues\s*=\s*readWayflowSubmittedValues\(\s*values\s*\)/);
    expect(src).toMatch(/import \{ readWayflowSubmittedValues \} from "\.\/hitl-gate-submit";/);
  });

  it("adds no module of its own for the reader or the gate's hold context", () => {
    for (const leaf of ["wayflow-submitted-values.ts", "gate-continue-hold-context.ts"]) {
      expect(existsSync(join(__dirname, "..", leaf)), leaf).toBe(false);
    }
  });
});
