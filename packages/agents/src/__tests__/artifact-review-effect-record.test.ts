/**
 * cinatra#3978 — the effect record's JSON contract and the CLOSED CMS apply
 * result schema, without a database. The store's bindings to stored state are
 * proved against real Postgres in artifact-review-effect-store.integration.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../cms-snapshot-readback-store", () => ({ readCmsSnapshotTargetByOperation: vi.fn() }));

import {
  parseCmsApplyEffectResult,
  reviewEffectId,
  REVIEW_EFFECT_RECORD_MAX_BYTES,
  serializeReviewEffectRecord,
  storedPinnedTargets,
} from "../artifact-review-effect-store";

const VALID = { remoteId: "42", remoteStatus: "published", remotePublishedAt: "2026-11-03T09:20:00.000Z" };

/** A plain object whose compact JSON text is exactly `bytes` UTF-8 bytes. */
function recordOfBytes(bytes: number, filler = "a"): Record<string, string> {
  const overhead = Buffer.byteLength(JSON.stringify({ k: "" }), "utf8");
  const unit = Buffer.byteLength(filler, "utf8");
  const room = bytes - overhead;
  const count = Math.floor(room / unit);
  const pad = "a".repeat(room - count * unit);
  const value = { k: filler.repeat(count) + pad };
  expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBe(bytes);
  return value;
}

describe("serializeReviewEffectRecord — the persisted JSON contract", () => {
  it("accepts a plain object, a null-prototype object, nested arrays and nulls", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
    expect(serializeReviewEffectRecord(bare)).toEqual({ ok: true, json: '{"a":1}' });
    expect(serializeReviewEffectRecord({ a: [1, "x", null, { b: true }] })).toEqual({
      ok: true,
      json: '{"a":[1,"x",null,{"b":true}]}',
    });
  });

  it.each([
    ["null", null],
    ["an array", [1]],
    ["a string", "x"],
    ["a number", 1],
    ["undefined", undefined],
  ])("refuses a top level that is %s", (_n, value) => {
    expect(serializeReviewEffectRecord(value)).toEqual({ ok: false, code: "not-a-plain-object" });
  });

  class Box {
    a = 1;
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const getter = Object.defineProperty({}, "a", { get: () => 1, enumerable: true });
  const hidden = Object.defineProperty({}, "a", { value: 1, enumerable: false });
  const sym = { [Symbol("s")]: 1 };
  const holey = { a: [1, , 3] }; // eslint-disable-line no-sparse-arrays
  const extraKey = Object.assign([1], { extra: 2 });
  let deep: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 40; i += 1) deep = { d: deep };

  it.each([
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["undefined", { a: undefined }],
    ["a function", { a: () => 1 }],
    ["a symbol value", { a: Symbol("x") }],
    ["a bigint", { a: BigInt(1) }],
    ["a cycle", cyclic],
    ["a Buffer", { a: Buffer.from("x") }],
    ["a typed array", { a: new Uint8Array(2) }],
    ["an ArrayBuffer", { a: new ArrayBuffer(2) }],
    ["a Date", { a: new Date(0) }],
    ["a class instance", { a: new Box() }],
    ["a class instance at the top", new Box()],
    ["a getter", getter],
    ["a non-enumerable key", hidden],
    ["a symbol key", sym],
    ["a proxy", new Proxy({ a: 1 }, {})],
    ["a nested proxy", { a: new Proxy({}, {}) }],
    ["an own toJSON", { a: 1, toJSON: () => ({ b: 2 }) }],
    ["a nested toJSON", { a: { toJSON: () => "x" } }],
    ["a sparse array", holey],
    ["an array with an extra key", { a: extraKey }],
    ["a NUL character", { a: "x\u0000y" }],
    ["a lone high surrogate", { a: "\ud800" }],
    ["a lone low surrogate", { a: "x\udc00" }],
    ["nesting past the depth limit", deep],
  ])("refuses %s", (_n, value) => {
    expect(serializeReviewEffectRecord(value)).toEqual({ ok: false, code: "invalid-value" });
  });

  it("runs no getter while it reads", () => {
    const spy = vi.fn(() => 1);
    serializeReviewEffectRecord(Object.defineProperty({}, "toJSON", { get: spy, enumerable: true }));
    serializeReviewEffectRecord(Object.defineProperty({}, "a", { get: spy, enumerable: true }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("counts the limit in UTF-8 bytes of the compact text: 8192 passes, 8193 does not", () => {
    expect(REVIEW_EFFECT_RECORD_MAX_BYTES).toBe(8192);
    expect(serializeReviewEffectRecord(recordOfBytes(8192)).ok).toBe(true);
    expect(serializeReviewEffectRecord(recordOfBytes(8193))).toEqual({ ok: false, code: "too-large" });
  });

  it("counts multibyte text by its bytes, not its characters", () => {
    expect(serializeReviewEffectRecord(recordOfBytes(8192, "ü")).ok).toBe(true); // 2 bytes each
    expect(serializeReviewEffectRecord(recordOfBytes(8193, "€")).ok).toBe(false); // 3 bytes each
    expect(serializeReviewEffectRecord(recordOfBytes(8192, "😀")).ok).toBe(true); // 4 bytes, a surrogate pair
    const chars = { k: "ü".repeat(4093) }; // 4101 characters, 8194 bytes
    expect(JSON.stringify(chars).length).toBeLessThan(8192);
    expect(serializeReviewEffectRecord(chars)).toEqual({ ok: false, code: "too-large" });
  });
});

describe("parseCmsApplyEffectResult — the CLOSED, credential-free apply result", () => {
  it("accepts the three keys and rebuilds them in a fixed order", () => {
    const shuffled = { remotePublishedAt: VALID.remotePublishedAt, remoteStatus: "published", remoteId: "42" };
    const parsed = parseCmsApplyEffectResult(shuffled);
    expect(parsed).toEqual(VALID);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(VALID));
    expect(parsed).not.toBe(shuffled);
  });

  it("accepts a null publication time and every status of the closed set", () => {
    for (const s of ["published", "scheduled", "draft", "pending", "private"]) {
      expect(parseCmsApplyEffectResult({ ...VALID, remoteStatus: s, remotePublishedAt: null })?.remoteStatus).toBe(s);
    }
  });

  it.each([
    ["a secret field", { ...VALID, token: "sk-live-123" }],
    ["a private response field", { ...VALID, _links: { self: "https://site/wp-json" } }],
    ["a remote error message", { ...VALID, error: "<script>" }],
    ["a missing key", { remoteId: "42", remoteStatus: "published" }],
    ["an empty object", {}],
    ["an empty id", { ...VALID, remoteId: "" }],
    ["an id with a space", { ...VALID, remoteId: "4 2" }],
    ["an id with a slash", { ...VALID, remoteId: "https://site/?p=42" }],
    ["an id of 129 characters", { ...VALID, remoteId: "a".repeat(129) }],
    ["a numeric id", { ...VALID, remoteId: 42 }],
    ["a case-varied status", { ...VALID, remoteStatus: "Published" }],
    ["a site status word", { ...VALID, remoteStatus: "publish" }],
    ["an unknown status", { ...VALID, remoteStatus: "live" }],
    ["a time without milliseconds", { ...VALID, remotePublishedAt: "2026-11-03T09:20:00Z" }],
    ["a local time", { ...VALID, remotePublishedAt: "2026-11-03 09:20:00" }],
    ["an impossible date", { ...VALID, remotePublishedAt: "2026-02-30T09:20:00.000Z" }],
    ["a numeric time", { ...VALID, remotePublishedAt: 1762161600000 }],
    ["a getter", Object.defineProperty({ remoteId: "42", remoteStatus: "draft" }, "remotePublishedAt", { get: () => null, enumerable: true })],
    ["a proxy", new Proxy({ ...VALID }, {})],
    ["a class instance", Object.assign(new (class R {})(), VALID)],
    ["null", null],
    ["an array", [VALID]],
  ])("refuses %s", (_n, value) => {
    expect(parseCmsApplyEffectResult(value)).toBeNull();
  });
});

describe("storedPinnedTargets — the gate's stored pinned set, fail-closed", () => {
  it("reads a well-formed set", () => {
    expect(storedPinnedTargets([{ artifactId: "a", representationRevisionId: "r", extra: 1 }])).toEqual([
      { artifactId: "a", representationRevisionId: "r" },
    ]);
    expect(storedPinnedTargets([])).toEqual([]);
  });

  it.each([
    ["an object", { artifactId: "a", representationRevisionId: "r" }],
    ["null", null],
    ["a null element", [null]],
    ["an array element", [["a", "r"]]],
    ["an empty artifact id", [{ artifactId: "", representationRevisionId: "r" }]],
    ["a numeric revision id", [{ artifactId: "a", representationRevisionId: 7 }]],
    ["one bad element among good ones", [{ artifactId: "a", representationRevisionId: "r" }, { artifactId: "b" }]],
  ])("refuses %s as a whole", (_n, value) => {
    expect(storedPinnedTargets(value)).toBeNull();
  });
});

describe("reviewEffectId", () => {
  it("is deterministic per (gate, artifact, revision) and separates the parts", () => {
    expect(reviewEffectId("g", "a", "r")).toBe(reviewEffectId("g", "a", "r"));
    expect(reviewEffectId("g", "a", "r")).toMatch(/^effect:[a-f0-9]{64}$/);
    expect(reviewEffectId("g", "ab", "r")).not.toBe(reviewEffectId("g", "a", "br"));
  });
});
