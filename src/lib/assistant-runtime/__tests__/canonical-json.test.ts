// RFC 8785 (JSON Canonicalization Scheme) for the tool-manifest report
// (packages/agent-ui-protocol/CONTRACT.md section 5.2, "Canonical JSON").
// The vectors below are the RFC's own examples (section 3.2.2, 3.2.3 and
// selected Appendix B numbers), so the function is pinned to the standard,
// not to itself.

import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalizeJson } from "../canonical-json";

function fromIeeeHex(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe("canonicalizeJson (RFC 8785)", () => {
  it("serializes the RFC 3.2.2 example: sorted keys, ES numbers, RFC escapes", () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    );
    expect(canonicalizeJson(input)).toBe(
      '{"literals":[null,true,false],' +
        '"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("sorts object keys by UTF-16 code units (RFC 3.2.3)", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    const keys = Object.keys(JSON.parse(canonicalizeJson(input)) as object);
    // JSON.parse re-orders the integer-like key "1" first, so compare the raw text order.
    const text = canonicalizeJson(input);
    const order = [
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ].map((v) => text.indexOf(`"${v}"`));
    expect(order.every((pos) => pos > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(keys).toHaveLength(7);
  });

  it("sorts keys at every depth and keeps array order", () => {
    expect(canonicalizeJson({ b: [3, { z: 1, a: 2 }, 1], a: { d: 1, c: null } })).toBe(
      '{"a":{"c":null,"d":1},"b":[3,{"a":2,"z":1},1]}',
    );
  });

  it.each([
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
  ])("serializes the Appendix B number %s as %s", (hex, expected) => {
    expect(canonicalizeJson(fromIeeeHex(hex))).toBe(expected);
  });

  it("leaves out an object member whose value is undefined", () => {
    expect(canonicalizeJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("writes no white space", () => {
    expect(canonicalizeJson({ a: [1, 2], b: { c: "x y" } })).toBe('{"a":[1,2],"b":{"c":"x y"}}');
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a bigint", BigInt(1)],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
  ])("refuses %s anywhere in the value", (_label, bad) => {
    expect(() => canonicalizeJson(bad)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson({ nested: [{ bad }] })).toThrow(CanonicalJsonError);
  });

  it("refuses a value that is not plain JSON data (Date, Map, class instance)", () => {
    expect(() => canonicalizeJson({ when: new Date(0) })).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson(new Map([["a", 1]]))).toThrow(CanonicalJsonError);
    class Thing {
      a = 1;
    }
    expect(() => canonicalizeJson(new Thing())).toThrow(CanonicalJsonError);
  });

  it("refuses undefined as an array element and as the whole value", () => {
    expect(() => canonicalizeJson([1, undefined])).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson(undefined)).toThrow(CanonicalJsonError);
  });

  it("refuses a hole of a sparse array", () => {
    const holed: unknown[] = [1, 2, 3];
    delete holed[1];
    expect(() => canonicalizeJson(holed)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson(new Array(1))).toThrow(CanonicalJsonError);
    const late: unknown[] = [];
    late[1] = 1;
    expect(() => canonicalizeJson({ a: { b: late } })).toThrow(CanonicalJsonError);
  });

  it("escapes control characters as RFC 8785 states", () => {
    expect(canonicalizeJson("\b\t\n\f\r\u0000\u001f\u007f")).toBe(
      '"\\b\\t\\n\\f\\r\\u0000\\u001f\u007f"',
    );
  });

  it.each([
    ["a lone high surrogate", "\uD800"],
    ["a lone low surrogate", "\uDC00"],
    ["a high surrogate at the end", "a\uDBFF"],
    ["a low surrogate before a high one", "\uDC00\uD800"],
  ])("refuses %s in a string value and in an object key", (_label, bad) => {
    expect(() => canonicalizeJson(bad)).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson({ a: [{ default: bad }] })).toThrow(CanonicalJsonError);
    expect(() => canonicalizeJson({ [bad]: 1 })).toThrow(CanonicalJsonError);
  });

  it("keeps a valid surrogate pair as the character itself", () => {
    expect(canonicalizeJson({ "\uD83D\uDE00": "\uD83D\uDE00" })).toBe('{"\uD83D\uDE00":"\uD83D\uDE00"}');
  });

  it("refuses a cycle, direct, indirect and through an array", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalizeJson(a)).toThrow(CanonicalJsonError);
    const b: Record<string, unknown> = {};
    b.child = { grandchild: { back: b } };
    expect(() => canonicalizeJson(b)).toThrow(CanonicalJsonError);
    const list: unknown[] = [1];
    list.push({ inner: list });
    expect(() => canonicalizeJson(list)).toThrow(CanonicalJsonError);
  });

  it("serializes a shared object that is not a cycle at each place", () => {
    const shared = { a: 1 };
    const sharedList = [shared];
    expect(canonicalizeJson({ x: shared, y: shared, z: [sharedList, sharedList] })).toBe(
      '{"x":{"a":1},"y":{"a":1},"z":[[{"a":1}],[{"a":1}]]}',
    );
  });

  it("accepts an object with a null prototype", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.b = 1;
    o.a = 2;
    expect(canonicalizeJson(o)).toBe('{"a":2,"b":1}');
  });
});
