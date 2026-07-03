// cinatra#792 — source-union validator coverage for the TYPED bundled
// discriminant and the additive verdaccio `activeDigest` field.
// cinatra#795 — `bundled.digest` is an IDENTITY field (the bundled half of
// `<kind>/<slug>/<digest>` parity): when present it must satisfy the store
// digest-segment grammar, mirrored here as BUNDLED_SOURCE_DIGEST_RE.
import { describe, expect, it } from "vitest";

import {
  BUNDLED_SOURCE_DIGEST_RE,
  isExtensionSource,
  validateExtensionSource,
} from "../canonical-types";
// Canonical grammar (host store module) — the parity guard for the mirror.
// Relative import on purpose: binds the authored implementation, not an alias.
import { isStoreDigestSegment } from "../../../../src/lib/extension-package-store-core";

const DIGEST = "d".repeat(128);

describe("isExtensionSource / validateExtensionSource — bundled (cinatra#792)", () => {
  it("accepts a bundled source (digest optional until #795 records the image hash)", () => {
    const src = { type: "bundled", packageName: "@cinatra-ai/x", version: "1.0.0" };
    expect(isExtensionSource(src)).toBe(true);
    expect(validateExtensionSource(src)).toEqual([]);
  });

  it("accepts a bundled source WITH a digest", () => {
    const src = { type: "bundled", packageName: "@cinatra-ai/x", version: "1.0.0", digest: DIGEST };
    expect(isExtensionSource(src)).toBe(true);
    expect(validateExtensionSource(src)).toEqual([]);
  });

  it("rejects a bundled source missing packageName/version", () => {
    expect(isExtensionSource({ type: "bundled", packageName: "@cinatra-ai/x" })).toBe(false);
    expect(validateExtensionSource({ type: "bundled", version: "1.0.0" })).toEqual([
      "bundled.packageName",
    ]);
    expect(validateExtensionSource({ type: "bundled", packageName: "@cinatra-ai/x" })).toEqual([
      "bundled.version",
    ]);
  });

  it("rejects a bundled source whose PRESENT digest is empty", () => {
    const src = { type: "bundled", packageName: "@cinatra-ai/x", version: "1.0.0", digest: "" };
    expect(isExtensionSource(src)).toBe(false);
    expect(validateExtensionSource(src)).toEqual(["bundled.digest"]);
  });

  it("rejects a PRESENT digest that violates the identity grammar (cinatra#795)", () => {
    for (const bad of ["not-hex", "ABCD".repeat(32), "a".repeat(63), "a".repeat(129), "sha512-abc"]) {
      const src = { type: "bundled", packageName: "@cinatra-ai/x", version: "1.0.0", digest: bad };
      expect(isExtensionSource(src)).toBe(false);
      expect(validateExtensionSource(src)).toEqual(["bundled.digest"]);
    }
    // Both hex sha256 (64) and hex sha512 (128) lengths are well-formed.
    for (const good of ["a".repeat(64), "0123456789abcdef".repeat(8)]) {
      const src = { type: "bundled", packageName: "@cinatra-ai/x", version: "1.0.0", digest: good };
      expect(isExtensionSource(src)).toBe(true);
      expect(validateExtensionSource(src)).toEqual([]);
    }
  });

  it("BUNDLED_SOURCE_DIGEST_RE mirrors isStoreDigestSegment exactly (parity guard)", () => {
    const corpus = [
      "a".repeat(63),
      "a".repeat(64),
      "a".repeat(100),
      "a".repeat(128),
      "a".repeat(129),
      "A".repeat(128),
      "g".repeat(128),
      "",
      "sha512-x",
      "0123456789abcdef".repeat(8),
    ];
    for (const candidate of corpus) {
      expect(BUNDLED_SOURCE_DIGEST_RE.test(candidate)).toBe(isStoreDigestSegment(candidate));
    }
  });

  it("rejects placeholder sentinels in bundled fields", () => {
    expect(
      isExtensionSource({ type: "bundled", packageName: "@cinatra-ai/x", version: "latest" }),
    ).toBe(false);
  });
});

describe("isExtensionSource / validateExtensionSource — verdaccio.activeDigest (cinatra#792)", () => {
  const base = {
    type: "verdaccio",
    registryUrl: "https://registry.cinatra.ai",
    packageName: "@cinatra-ai/x",
    version: "1.0.0",
    integrity: "sha512-abc",
  };

  it("activeDigest stays OPTIONAL (legacy rows validate)", () => {
    expect(isExtensionSource(base)).toBe(true);
    expect(validateExtensionSource(base)).toEqual([]);
  });

  it("a PRESENT activeDigest must be a real value", () => {
    expect(isExtensionSource({ ...base, activeDigest: DIGEST })).toBe(true);
    expect(validateExtensionSource({ ...base, activeDigest: DIGEST })).toEqual([]);
    expect(isExtensionSource({ ...base, activeDigest: "" })).toBe(false);
    expect(validateExtensionSource({ ...base, activeDigest: "" })).toEqual([
      "verdaccio.activeDigest",
    ]);
  });
});
