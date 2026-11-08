/**
 * cinatra#3978 — the effect record's JSON contract and the CLOSED CMS apply
 * result schema, without a database. The store's bindings to stored state are
 * proved against real Postgres in artifact-review-effect-store.integration.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../cms-snapshot-readback-store", () => ({ readCmsSnapshotTargetByOperation: vi.fn() }));

import { readCmsSnapshotTargetByOperation } from "../cms-snapshot-readback-store";
import {
  parseCmsApplyEffectResult,
  recordCmsApplyEffect,
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
  const holey = { a: [1, , 3] };
  const extraKey = Object.assign([1], { extra: 2 });
  /** A plain object `levels` objects deep below the top-level object. */
  function nest(levels: number): Record<string, unknown> {
    let v: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < levels; i += 1) v = { d: v };
    return v;
  }
  const deep = nest(40);

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
    ["a NUL character in a key", { "a\u0000b": 1 }],
    ["a lone high surrogate in a key", { "\ud800": 1 }],
    ["a lone low surrogate in a nested key", { a: { "x\udc00": 1 } }],
    ["nesting past the depth limit", deep],
  ])("refuses %s", (_n, value) => {
    expect(serializeReviewEffectRecord(value)).toEqual({ ok: false, code: "invalid-value" });
  });

  it("accepts a key with a surrogate pair, and nesting 32 levels deep but not 33", () => {
    expect(serializeReviewEffectRecord({ "😀": 1 })).toEqual({ ok: true, json: '{"😀":1}' });
    expect(serializeReviewEffectRecord(nest(32)).ok).toBe(true);
    expect(serializeReviewEffectRecord(nest(33))).toEqual({ ok: false, code: "invalid-value" });
  });

  it("refuses a sparse array whose one extra key makes up the key count of a full array", () => {
    // [1, <hole>, 3] has the own keys 0, 2 and length; one extra key makes four, the count of a full array of three.
    const sparseExtra = Object.assign([1, , 3], { extra: 2 });
    expect(Reflect.ownKeys(sparseExtra)).toHaveLength(sparseExtra.length + 1);
    expect(serializeReviewEffectRecord({ a: sparseExtra })).toEqual({ ok: false, code: "invalid-value" });
  });

  it("runs no inherited index getter for a hole", () => {
    const spy = vi.fn(() => "inherited");
    Object.defineProperty(Array.prototype, "1", { get: spy, configurable: true });
    try {
      const sparseExtra = Object.assign([1, , 3], { extra: 2 });
      expect(serializeReviewEffectRecord({ a: sparseExtra })).toEqual({ ok: false, code: "invalid-value" });
    } finally {
      delete (Array.prototype as unknown as Record<string, unknown>)["1"];
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses an array key that is not a canonical index below the length", () => {
    const leadingZero = [1, 2];
    delete (leadingZero as unknown as Record<string, unknown>)["1"];
    (leadingZero as unknown as Record<string, unknown>)["01"] = 2;
    expect(serializeReviewEffectRecord({ a: leadingZero })).toEqual({ ok: false, code: "invalid-value" });
  });

  it("refuses a revoked proxy at the top, object or array, with a typed answer and no throw", () => {
    const obj = Proxy.revocable({}, {});
    const arr = Proxy.revocable([] as unknown[], {});
    obj.revoke();
    arr.revoke();
    expect(serializeReviewEffectRecord(obj.proxy)).toEqual({ ok: false, code: "invalid-value" });
    expect(serializeReviewEffectRecord(arr.proxy)).toEqual({ ok: false, code: "invalid-value" });
    expect(serializeReviewEffectRecord({ a: obj.proxy })).toEqual({ ok: false, code: "invalid-value" });
  });

  it("refuses a live array proxy at the top as a proxy, not as an array", () => {
    expect(serializeReviewEffectRecord(new Proxy([1], {}))).toEqual({ ok: false, code: "invalid-value" });
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

describe("parseCmsApplyEffectResult — the CLOSED apply result", () => {
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

  it("accepts an id of exactly 128 characters of its set", () => {
    const id = "Az09._:-".repeat(16);
    expect(id).toHaveLength(128);
    expect(parseCmsApplyEffectResult({ ...VALID, remoteId: id })?.remoteId).toBe(id);
  });

  it("checks the id's form only: any text of the set and length passes, whatever it means", () => {
    // The closed schema keeps out every other field (no response body, no remote
    // error text); it cannot tell what an id of the allowed form stands for.
    expect(parseCmsApplyEffectResult({ ...VALID, remoteId: "sk-live-123" })?.remoteId).toBe("sk-live-123");
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
    ["an impossible month", { ...VALID, remotePublishedAt: "2026-13-01T09:20:00.000Z" }],
    ["a numeric time", { ...VALID, remotePublishedAt: 1762161600000 }],
    ["a getter", Object.defineProperty({ remoteId: "42", remoteStatus: "draft" }, "remotePublishedAt", { get: () => null, enumerable: true })],
    ["a proxy", new Proxy({ ...VALID }, {})],
    ["a class instance", Object.assign(new (class R {})(), VALID)],
    ["null", null],
    ["an array", [VALID]],
  ])("refuses %s", (_n, value) => {
    expect(parseCmsApplyEffectResult(value)).toBeNull();
  });

  it("refuses a revoked proxy, object or array, with null and no throw", () => {
    const obj = Proxy.revocable({ ...VALID }, {});
    const arr = Proxy.revocable([VALID], {});
    obj.revoke();
    arr.revoke();
    expect(parseCmsApplyEffectResult(obj.proxy)).toBeNull();
    expect(parseCmsApplyEffectResult(arr.proxy)).toBeNull();
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
    ["an empty revision id", [{ artifactId: "a", representationRevisionId: "" }]],
    ["a numeric revision id", [{ artifactId: "a", representationRevisionId: 7 }]],
    ["one bad element among good ones", [{ artifactId: "a", representationRevisionId: "r" }, { artifactId: "b" }]],
    ["a class instance element", [Object.assign(new (class Pin {})(), { artifactId: "a", representationRevisionId: "r" })]],
    ["an element whose ids are inherited", [Object.create({ artifactId: "a", representationRevisionId: "r" }) as unknown]],
    ["a proxy element", [new Proxy({ artifactId: "a", representationRevisionId: "r" }, {})]],
    ["a proxy set", new Proxy([{ artifactId: "a", representationRevisionId: "r" }], {})],
    ["a hole", [, { artifactId: "a", representationRevisionId: "r" }]],
  ])("refuses %s as a whole", (_n, value) => {
    expect(storedPinnedTargets(value)).toBeNull();
  });

  it("refuses an element whose id is a getter, and runs no getter", () => {
    const spy = vi.fn(() => "a");
    const el = Object.defineProperty({ representationRevisionId: "r" }, "artifactId", { get: spy, enumerable: true });
    expect(storedPinnedTargets([el])).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("accepts a null-prototype element", () => {
    const el = Object.assign(Object.create(null) as Record<string, unknown>, { artifactId: "a", representationRevisionId: "r" });
    expect(storedPinnedTargets([el])).toEqual([{ artifactId: "a", representationRevisionId: "r" }]);
  });
});

describe("recordCmsApplyEffect — the operation id is the record's source, 1 to 256 UTF-8 bytes", () => {
  const BASE = { orgId: "org-1", runId: "run-1", gateId: "gate-1", result: VALID };
  const lookup = vi.mocked(readCmsSnapshotTargetByOperation);

  it.each([
    ["an empty id", ""],
    ["an id of 257 bytes", "a".repeat(257)],
    ["an id of 129 characters and 257 bytes", `${"ü".repeat(128)}a`],
    ["a non-string id", 42 as unknown as string],
  ])("refuses %s as invalid-operation before any read", async (_n, operationId) => {
    lookup.mockClear();
    expect(await recordCmsApplyEffect({ ...BASE, operationId })).toEqual({ ok: false, code: "invalid-operation" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["one byte", "a"],
    ["256 bytes", "a".repeat(256)],
    ["128 two-byte characters", "ü".repeat(128)],
  ])("passes an id of %s on to the stored-state reads", async (_n, operationId) => {
    lookup.mockClear();
    lookup.mockResolvedValueOnce(null);
    expect(await recordCmsApplyEffect({ ...BASE, operationId })).toEqual({ ok: false, code: "target-not-found" });
    expect(lookup).toHaveBeenCalledWith(operationId);
  });
});

describe("reviewEffectId", () => {
  it("is deterministic per (gate, artifact, revision) and separates the parts", () => {
    expect(reviewEffectId("g", "a", "r")).toBe(reviewEffectId("g", "a", "r"));
    expect(reviewEffectId("g", "a", "r")).toMatch(/^effect:[a-f0-9]{64}$/);
    expect(reviewEffectId("g", "ab", "r")).not.toBe(reviewEffectId("g", "a", "br"));
  });
});
