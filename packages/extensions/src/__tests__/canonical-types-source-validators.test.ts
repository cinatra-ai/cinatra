// cinatra#792 — source-union validator coverage for the TYPED bundled
// discriminant and the additive verdaccio `activeDigest` field.
// cinatra#795 — `bundled.digest` is an IDENTITY field (the bundled half of
// `<kind>/<slug>/<digest>` parity): when present it must satisfy the store
// digest-segment grammar, mirrored here as BUNDLED_SOURCE_DIGEST_RE.
import { describe, expect, it } from "vitest";

import {
  BUNDLED_SOURCE_DIGEST_RE,
  SUPPLIED_SOURCE_CONTENT_DIGEST_RE,
  isExtensionSource,
  isSuppliedDigestSource,
  validateExtensionSource,
} from "../canonical-types";
// cinatra#3204 D2 — the dependency-inversion leaf owns the ONE content-digest
// grammar; the canonical-types mirror is parity-tested against it below.
import { CONTENT_DIGEST_RE } from "@cinatra-ai/extension-types";
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

// ---------------------------------------------------------------------------
// cinatra#3204 D2 — the SUPPLIED `contentDigest` on the non-registry sources.
// ---------------------------------------------------------------------------

const CONTENT_DIGEST = "e".repeat(64);

describe("isExtensionSource / validateExtensionSource — supplied contentDigest (cinatra#3204)", () => {
  const github = { type: "github", repo: "owner/repo", ref: "main", resolvedSha: "f".repeat(40) };
  const local = { type: "local", path: "snapshots/x.tgz", resolvedCommitOrTreeHash: "abc123" };

  it("contentDigest stays OPTIONAL on both supplied sources (pre-#3204 rows validate)", () => {
    expect(isExtensionSource(github)).toBe(true);
    expect(validateExtensionSource(github)).toEqual([]);
    expect(isExtensionSource(local)).toBe(true);
    expect(validateExtensionSource(local)).toEqual([]);
  });

  it("accepts a well-formed contentDigest on both", () => {
    expect(isExtensionSource({ ...github, contentDigest: CONTENT_DIGEST })).toBe(true);
    expect(validateExtensionSource({ ...github, contentDigest: CONTENT_DIGEST })).toEqual([]);
    expect(isExtensionSource({ ...local, contentDigest: CONTENT_DIGEST })).toBe(true);
    expect(validateExtensionSource({ ...local, contentDigest: CONTENT_DIGEST })).toEqual([]);
  });

  it("refuses a PRESENT contentDigest that is malformed — the install entry treats it as a trust input", () => {
    for (const bad of ["", "pending-resolution", "a".repeat(63), "a".repeat(128), "A".repeat(64), "sha256-abc"]) {
      expect(isExtensionSource({ ...github, contentDigest: bad })).toBe(false);
      expect(validateExtensionSource({ ...github, contentDigest: bad })).toEqual(["github.contentDigest"]);
      expect(isExtensionSource({ ...local, contentDigest: bad })).toBe(false);
      expect(validateExtensionSource({ ...local, contentDigest: bad })).toEqual(["local.contentDigest"]);
    }
  });

  it("SUPPLIED_SOURCE_CONTENT_DIGEST_RE mirrors the leaf's CONTENT_DIGEST_RE exactly (parity guard)", () => {
    const corpus = [
      "a".repeat(63),
      "a".repeat(64),
      "a".repeat(100),
      "a".repeat(128),
      "a".repeat(129),
      "A".repeat(64),
      "g".repeat(64),
      "",
      "sha256-x",
      "0123456789abcdef".repeat(4),
    ];
    for (const candidate of corpus) {
      expect(SUPPLIED_SOURCE_CONTENT_DIGEST_RE.test(candidate)).toBe(CONTENT_DIGEST_RE.test(candidate));
    }
  });

  it("the content-digest grammar is NARROWER than the store digest-segment grammar", () => {
    // A 128-hex store digest is a well-formed BUNDLED digest and is NOT a
    // well-formed content digest: they are different values over different
    // inputs, and admitting one where the other belongs would let a row store a
    // digest nothing computes.
    const storeDigest = "a".repeat(128);
    expect(BUNDLED_SOURCE_DIGEST_RE.test(storeDigest)).toBe(true);
    expect(SUPPLIED_SOURCE_CONTENT_DIGEST_RE.test(storeDigest)).toBe(false);
  });
});

describe("isSuppliedDigestSource — the one predicate the pipeline gate reads", () => {
  it("is true for a supplied source carrying a well-formed digest", () => {
    expect(
      isSuppliedDigestSource({ type: "local", path: "s.tgz", resolvedCommitOrTreeHash: "x", contentDigest: CONTENT_DIGEST }),
    ).toBe(true);
    expect(
      isSuppliedDigestSource({ type: "github", repo: "o/r", ref: "main", resolvedSha: "s", contentDigest: CONTENT_DIGEST }),
    ).toBe(true);
  });

  it("is FALSE for every local/github row that exists today — no silent widening", () => {
    expect(isSuppliedDigestSource({ type: "local", path: "s", resolvedCommitOrTreeHash: "x" })).toBe(false);
    expect(isSuppliedDigestSource({ type: "github", repo: "o/r", ref: "main", resolvedSha: "s" })).toBe(false);
    expect(isSuppliedDigestSource({ type: "local", path: "s", contentDigest: "not-a-digest" })).toBe(false);
  });

  it("is FALSE for registry and bundled sources — they are not supplied at all", () => {
    expect(
      isSuppliedDigestSource({
        type: "verdaccio",
        registryUrl: "https://registry.cinatra.ai",
        packageName: "@cinatra-ai/x",
        version: "1.0.0",
        integrity: "sha512-abc",
      }),
    ).toBe(false);
    expect(isSuppliedDigestSource({ type: "bundled", packageName: "@cinatra-ai/x", version: "1.0.0" })).toBe(false);
    expect(isSuppliedDigestSource(null)).toBe(false);
    expect(isSuppliedDigestSource(undefined)).toBe(false);
  });
});
