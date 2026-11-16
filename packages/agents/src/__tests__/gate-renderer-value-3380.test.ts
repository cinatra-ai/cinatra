/**
 * cinatra#3380 — THE RULE A MID-RUN CONTINUE IS HELD BY.
 *
 * The renderer-value section of `hitl-gate-submit.ts` reads a gate's schema and
 * the buffer its renderer wrote. A property declared `"x-required": true` (with
 * no `default`) is a value the renderer must produce before the Continue may
 * send. The object-level `required` list is not read: the email gates declare
 * `required: ["decision"]`, no renderer of theirs writes `decision`, and the
 * Continue's payload carries `approved`, so a rule over that list would hold
 * those gates.
 *
 * The three surfaces that draw a mid-run Continue (the run panel, the stepper
 * and the conversation card) each read this rule; their own files pin them.
 *
 * Run:
 *   cd packages/agents && pnpm exec vitest run src/__tests__/gate-renderer-value-3380.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  gateAwaitsRendererValue,
  gateCarriesPresentationHint,
  gateRequiredRendererKeys,
  hitlGateIdentityKey,
  withDeclaredRendererValues,
} from "../hitl-gate-submit";

const PICKED_JSON = JSON.stringify({ artifactId: "a-2", representationRevisionId: "r-2" });

const DECLARING_SCHEMA: Record<string, unknown> = {
  type: "object",
  "x-renderer": "@cinatra-test/pick-agent:pick",
  properties: {
    selectedIdeaJson: { type: "string", title: "Selected idea (JSON)", "x-required": true },
  },
};

const UNDECLARING_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "revise", "reject"] },
  },
  required: ["decision"],
};

describe("gateAwaitsRendererValue (cinatra#3380)", () => {
  it("holds nothing for a gate that declares no renderer value", () => {
    expect(gateAwaitsRendererValue(UNDECLARING_SCHEMA, {})).toBe(false);
    expect(gateAwaitsRendererValue({ type: "object" }, {})).toBe(false);
    expect(gateAwaitsRendererValue(null, {})).toBe(false);
    expect(gateAwaitsRendererValue(undefined, undefined)).toBe(false);
    expect(gateRequiredRendererKeys(UNDECLARING_SCHEMA)).toEqual([]);
  });

  it("holds a declaring gate until its renderer writes the declared key", () => {
    expect(gateRequiredRendererKeys(DECLARING_SCHEMA)).toEqual(["selectedIdeaJson"]);
    expect(gateAwaitsRendererValue(DECLARING_SCHEMA, {})).toBe(true);
    expect(gateAwaitsRendererValue(DECLARING_SCHEMA, undefined)).toBe(true);
    expect(gateAwaitsRendererValue(DECLARING_SCHEMA, { userResponse: PICKED_JSON })).toBe(true);
    expect(
      gateAwaitsRendererValue(DECLARING_SCHEMA, {
        selectedIdeaJson: PICKED_JSON,
        userResponse: PICKED_JSON,
      }),
    ).toBe(false);
  });

  it("reads nothing as no answer: null, a blank string and an empty list; 0 and false are answers", () => {
    const schemaOf = (property: Record<string, unknown>) => ({
      type: "object",
      properties: { v: { ...property, "x-required": true } },
    });
    expect(gateAwaitsRendererValue(schemaOf({ type: "string" }), { v: null })).toBe(true);
    expect(gateAwaitsRendererValue(schemaOf({ type: "string" }), { v: "   " })).toBe(true);
    expect(gateAwaitsRendererValue(schemaOf({ type: "array" }), { v: [] })).toBe(true);
    expect(gateAwaitsRendererValue(schemaOf({ type: "number" }), { v: 0 })).toBe(false);
    expect(gateAwaitsRendererValue(schemaOf({ type: "boolean" }), { v: false })).toBe(false);
  });

  it("holds nothing for a declared property that has a default", () => {
    const schema = {
      type: "object",
      properties: { v: { type: "string", "x-required": true, default: "" } },
    };
    expect(gateAwaitsRendererValue(schema, {})).toBe(false);
  });

  it("reads only a literal true, only object properties, and holds until every declared key is written", () => {
    const declared = { type: "string", "x-required": true };
    // "x-required" that is not the literal true declares nothing.
    expect(
      gateAwaitsRendererValue({ type: "object", properties: { v: { type: "string", "x-required": "true" } } }, {}),
    ).toBe(false);
    // properties that are not an object, and a property that is not an object, declare nothing.
    expect(gateAwaitsRendererValue({ type: "object", properties: [declared] }, {})).toBe(false);
    expect(gateAwaitsRendererValue({ type: "object", properties: { v: true } }, {})).toBe(false);
    // two declared keys: one written is not enough.
    const two = { type: "object", properties: { a: declared, b: declared } };
    expect(gateRequiredRendererKeys(two)).toEqual(["a", "b"]);
    expect(gateAwaitsRendererValue(two, { a: "x" })).toBe(true);
    expect(gateAwaitsRendererValue(two, { a: "x", b: "y" })).toBe(false);
    // a key inherited from the prototype is not a written value.
    expect(gateAwaitsRendererValue({ type: "object", properties: { toString: declared } }, {})).toBe(true);
  });

  it("reads null properties, a null default, x-required 1 and a nested x-required as no hold; a null buffer holds a declaring gate", () => {
    const declared = { type: "string", "x-required": true };
    expect(gateAwaitsRendererValue({ type: "object", properties: null }, {})).toBe(false);
    // A declared default answers the property, even a blank one, as on the setup road.
    expect(
      gateAwaitsRendererValue({ type: "object", properties: { v: { ...declared, default: null } } }, {}),
    ).toBe(false);
    expect(
      gateAwaitsRendererValue({ type: "object", properties: { v: { type: "string", "x-required": 1 } } }, {}),
    ).toBe(false);
    // Only the gate's own properties are read; a nested declaration is not.
    expect(
      gateAwaitsRendererValue(
        { type: "object", properties: { v: { type: "object", properties: { w: declared } } } },
        {},
      ),
    ).toBe(false);
    // A null buffer is nothing written: a declaring gate holds, an undeclaring one does not.
    expect(gateAwaitsRendererValue(DECLARING_SCHEMA, null)).toBe(true);
    expect(gateAwaitsRendererValue(UNDECLARING_SCHEMA, null)).toBe(false);
  });

  it("reads a presentation hint only as an object with a string type", () => {
    expect(gateCarriesPresentationHint({ presentation: { type: "card_list", items: [] } })).toBe(true);
    expect(gateCarriesPresentationHint({ presentation: { title: "no type" } })).toBe(false);
    expect(gateCarriesPresentationHint({ presentation: [{ type: "card_list" }] })).toBe(false);
    expect(gateCarriesPresentationHint({ presentation: null })).toBe(false);
    expect(gateCarriesPresentationHint({ ideas: [] })).toBe(false);
    expect(gateCarriesPresentationHint(null)).toBe(false);
    expect(gateCarriesPresentationHint(undefined)).toBe(false);
  });

  it("does not read the object-level required list", () => {
    const schema = {
      type: "object",
      properties: { selectedIdeaJson: { type: "string" } },
      required: ["selectedIdeaJson"],
    };
    expect(gateAwaitsRendererValue(schema, {})).toBe(false);
  });

  it("reads an object or NaN as an answer, an own undefined default as answered, and a root x-required as no declaration", () => {
    expect(gateAwaitsRendererValue(DECLARING_SCHEMA, { selectedIdeaJson: {} })).toBe(false);
    expect(gateAwaitsRendererValue(DECLARING_SCHEMA, { selectedIdeaJson: { x: 1 } })).toBe(false);
    expect(gateAwaitsRendererValue(DECLARING_SCHEMA, { selectedIdeaJson: Number.NaN })).toBe(false);
    expect(
      gateRequiredRendererKeys({
        type: "object",
        properties: { pick: { type: "string", "x-required": true, default: undefined } },
      }),
    ).toEqual([]);
    expect(gateRequiredRendererKeys({ type: "string", "x-required": true })).toEqual([]);
  });
});

describe("withDeclaredRendererValues (cinatra#3380)", () => {
  const HOST = { approved: true, approvedAt: "2026-11-03T00:00:00.000Z", userResponse: "host text" };
  const declaring = (...keys: string[]) => ({
    type: "object",
    properties: Object.fromEntries(keys.map((k) => [k, { "x-required": true }])),
  });

  it("puts a declared key the renderer wrote back over the host's own value, false and an empty object included", () => {
    expect(withDeclaredRendererValues(declaring("approved"), { approved: false }, HOST)).toEqual({
      ...HOST,
      approved: false,
    });
    expect(
      withDeclaredRendererValues(
        declaring("approvedAt", "userResponse"),
        { approvedAt: "2020-01-02T03:04:05.000Z", userResponse: { pick: {} } },
        HOST,
      ),
    ).toEqual({ ...HOST, approvedAt: "2020-01-02T03:04:05.000Z", userResponse: { pick: {} } });
  });

  it("keeps the host's value for a declared key that is blank, absent or only inherited, and leaves undeclared keys alone", () => {
    const inherited = Object.create({ approved: false }) as Record<string, unknown>;
    expect(withDeclaredRendererValues(declaring("approved"), inherited, HOST)).toBe(HOST);
    expect(withDeclaredRendererValues(declaring("userResponse"), { userResponse: "  " }, HOST)).toBe(HOST);
    expect(withDeclaredRendererValues(declaring("approved"), {}, HOST)).toBe(HOST);
    expect(withDeclaredRendererValues(declaring("selectedIdeaJson"), { approved: false }, HOST)).toBe(HOST);
  });

  it("returns the same payload for a gate that declares nothing, a declared default, or no buffer", () => {
    expect(withDeclaredRendererValues(UNDECLARING_SCHEMA, { decision: "approve", approved: false }, HOST)).toBe(HOST);
    expect(
      withDeclaredRendererValues(
        { type: "object", properties: { approved: { "x-required": true, default: true } } },
        { approved: false },
        HOST,
      ),
    ).toBe(HOST);
    expect(withDeclaredRendererValues(null, { approved: false }, HOST)).toBe(HOST);
    expect(withDeclaredRendererValues(declaring("approved"), null, HOST)).toBe(HOST);
  });

  it("does not change the payload it was given", () => {
    const payload = { ...HOST };
    withDeclaredRendererValues(declaring("approved"), { approved: false }, payload);
    expect(payload).toEqual(HOST);
  });
});

describe("hitlGateIdentityKey (cinatra#3380)", () => {
  it("tells two gates apart by their review task alone, and carries the boundaries of its parts", () => {
    const gate = { reviewTaskId: "task-1", xRenderer: "@pack:pick" };
    expect(hitlGateIdentityKey(gate)).toBe(hitlGateIdentityKey({ ...gate, fieldName: null }));
    expect(hitlGateIdentityKey(gate)).not.toBe(hitlGateIdentityKey({ ...gate, reviewTaskId: "task-2" }));
    expect(hitlGateIdentityKey({ reviewTaskId: "a::", xRenderer: "b" })).not.toBe(
      hitlGateIdentityKey({ reviewTaskId: "a", xRenderer: "::b" }),
    );
  });
});
