// cinatra#792 — source-union validator coverage for the TYPED bundled
// discriminant and the additive verdaccio `activeDigest` field.
import { describe, expect, it } from "vitest";

import { isExtensionSource, validateExtensionSource } from "../canonical-types";

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
