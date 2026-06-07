// Resource substance-key canonicalization protects dedupe correctness and
// avoids ambiguous key derivation. DB operations are outside this unit
// contract; pure key derivation is tested here.
import { describe, it, expect } from "vitest";
import {
  deriveSubstanceKey,
  canonicalJSONStringify,
  assertJSONSafe,
} from "@/lib/artifacts/resource-store";

describe("canonicalJSONStringify — deterministic regardless of key order/formatting", () => {
  it("two view-specs differing only by key order produce the SAME string", () => {
    const a = { b: 1, a: { z: 2, y: [3, 1] }, c: 4 };
    const b = { c: 4, a: { y: [3, 1], z: 2 }, b: 1 };
    expect(canonicalJSONStringify(a)).toBe(canonicalJSONStringify(b));
  });
  it("array ORDER is preserved (semantically meaningful in a view-spec)", () => {
    expect(canonicalJSONStringify([1, 2])).not.toBe(canonicalJSONStringify([2, 1]));
  });
  it("nested objects sorted recursively; primitives untouched", () => {
    expect(canonicalJSONStringify({ x: { d: 1, c: 2 } })).toBe('{"x":{"c":2,"d":1}}');
  });
});

describe("assertJSONSafe — reject ambiguous non-JSON before fingerprinting", () => {
  it("accepts plain JSON-compatible data", () => {
    expect(() => assertJSONSafe({ a: 1, b: [true, "x", null], c: { d: 2 } })).not.toThrow();
  });
  it("rejects undefined / non-finite / bigint / function / symbol / Date / class instances", () => {
    expect(() => assertJSONSafe(undefined)).toThrow(/JSON-safe/);
    expect(() => assertJSONSafe({ a: undefined })).toThrow(/JSON-safe/);
    expect(() => assertJSONSafe(NaN)).toThrow(/JSON-safe/);
    expect(() => assertJSONSafe(Infinity)).toThrow(/JSON-safe/);
    expect(() => assertJSONSafe(BigInt(10))).toThrow(/JSON-safe/);
    expect(() => assertJSONSafe({ f: () => 1 })).toThrow(/JSON-safe/);
    expect(() => assertJSONSafe(new Date())).toThrow(/JSON-safe/);
    expect(() => assertJSONSafe({ d: new Map() })).toThrow(/JSON-safe/);
  });
  it("dashboard substance derivation FAILS LOUD on a non-JSON view-spec (never silent-collide)", () => {
    expect(() => deriveSubstanceKey({ kind: "dashboard", viewSpec: { a: undefined } })).toThrow(/JSON-safe/);
    expect(() => deriveSubstanceKey({ kind: "dashboard", viewSpec: new Date() })).toThrow(/JSON-safe/);
    // Silent collision between an invalid view-spec and an empty object is impossible:
    expect(() => deriveSubstanceKey({ kind: "dashboard", viewSpec: { a: undefined } })).toThrow();
    expect(deriveSubstanceKey({ kind: "dashboard", viewSpec: {} })).toMatch(/^dashboard:/);
  });
});

describe("deriveSubstanceKey — canonical + namespaced per kind", () => {
  it("blob: blob:<sha256>", () => {
    expect(deriveSubstanceKey({ kind: "blob", sha256: "abc123" })).toBe("blob:abc123");
  });

  it("connector: namespaced; a changed etag/revision changes the key (no wrong dedupe)", () => {
    const base = {
      kind: "connector" as const,
      connectorKind: "google-docs",
      accountScope: "org:acme",
      externalObjectId: "doc-1",
      resolvedMime: "application/vnd.google-apps.document",
    };
    const k1 = deriveSubstanceKey({ ...base, revisionOrEtag: "etag-1" });
    const k2 = deriveSubstanceKey({ ...base, revisionOrEtag: "etag-2" });
    expect(k1).not.toBe(k2);
    expect(k1.startsWith("connector:google-docs:")).toBe(true);
    // different external object ⇒ different key even with same etag
    const k3 = deriveSubstanceKey({ ...base, externalObjectId: "doc-2", revisionOrEtag: "etag-1" });
    expect(k3).not.toBe(k1);
  });

  it("connector: bijective encoding — colon-injection AND %-literal cannot forge a component", () => {
    const base = { kind: "connector" as const, connectorKind: "x", revisionOrEtag: "r", resolvedMime: "m" };
    const injected = deriveSubstanceKey({ ...base, accountScope: "a:b", externalObjectId: "c" });
    const distinct = deriveSubstanceKey({ ...base, accountScope: "a", externalObjectId: "b:c" });
    expect(injected).not.toBe(distinct);
    // "a:b" vs literal "a%3Ab" must NOT collide.
    const real = deriveSubstanceKey({ ...base, accountScope: "a:b", externalObjectId: "c" });
    const lit = deriveSubstanceKey({ ...base, accountScope: "a%3Ab", externalObjectId: "c" });
    expect(real).not.toBe(lit);
    // and a literal '%' is itself round-trip-distinct
    const pct = deriveSubstanceKey({ ...base, accountScope: "a%b", externalObjectId: "c" });
    expect(new Set([real, lit, pct]).size).toBe(3);
  });

  it("dashboard: fingerprint is canonical (key-order-insensitive) and namespaced", () => {
    const k1 = deriveSubstanceKey({ kind: "dashboard", viewSpec: { a: 1, b: 2 } });
    const k2 = deriveSubstanceKey({ kind: "dashboard", viewSpec: { b: 2, a: 1 } });
    expect(k1).toBe(k2);
    expect(k1.startsWith("dashboard:")).toBe(true);
    const k3 = deriveSubstanceKey({ kind: "dashboard", viewSpec: { a: 1, b: 3 } });
    expect(k3).not.toBe(k1);
  });

  it("cross-kind keys never collide (namespace prefix)", () => {
    const blob = deriveSubstanceKey({ kind: "blob", sha256: "x" });
    const dash = deriveSubstanceKey({ kind: "dashboard", viewSpec: "x" });
    expect(blob.split(":")[0]).toBe("blob");
    expect(dash.split(":")[0]).toBe("dashboard");
    expect(blob).not.toBe(dash);
  });
});
