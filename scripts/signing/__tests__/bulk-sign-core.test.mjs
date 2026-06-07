import { describe, it, expect } from "vitest";
import {
  filterScopePackages,
  buildSignerArgv,
  injectSignatureIntoPackument,
  isAlreadySigned,
  assertServedIntegrityMatches,
  selectPushMode,
  summarizeRun,
} from "../lib/bulk-sign-core.mjs";
import {
  generateExtensionSigningKeyPair,
  signExtension,
  verifyExtensionSignature,
  loadTrustedPublicKeys,
} from "@/lib/extension-signature";

const PKG = "@cinatra-ai/notes-connector";
const VERSION = "1.2.0";
const INTEGRITY = "sha512-abc";

function packument(over = {}) {
  return {
    _id: PKG,
    _rev: "5-deadbeef",
    name: PKG,
    "dist-tags": { latest: VERSION },
    versions: {
      "1.1.0": { name: PKG, version: "1.1.0", dist: { tarball: "https://r/notes/-/1.1.0.tgz", shasum: "aaa", integrity: "sha512-old" } },
      [VERSION]: { name: PKG, version: VERSION, dist: { tarball: "https://r/notes/-/1.2.0.tgz", shasum: "bbb", integrity: INTEGRITY } },
    },
    _attachments: { "notes-1.2.0.tgz": { data: "BASE64TARBALL", length: 999 } },
    ...over,
  };
}

describe("filterScopePackages", () => {
  it("keeps only the given scope", () => {
    expect(filterScopePackages(["@cinatra-ai/a", "@other/b", "@cinatra-ai/c", "loose"], "@cinatra-ai")).toEqual(["@cinatra-ai/a", "@cinatra-ai/c"]);
  });
});

describe("buildSignerArgv", () => {
  it("builds sign argv with no key on argv", () => {
    expect(buildSignerArgv({ packageName: PKG, version: VERSION, integrity: INTEGRITY })).toEqual([
      "sign", "--package", PKG, "--version", VERSION, "--integrity", INTEGRITY,
    ]);
  });
  it("rejects a non-sha512 integrity + missing fields", () => {
    expect(() => buildSignerArgv({ packageName: PKG, version: VERSION, integrity: "sha256-x" })).toThrow(/sha512/);
    expect(() => buildSignerArgv({ packageName: PKG, version: "", integrity: INTEGRITY })).toThrow(/required/);
  });
});

describe("injectSignatureIntoPackument", () => {
  it("sets versions[v].dist.cinatraSignature, preserves _rev + siblings, strips _attachments, no input mutation", () => {
    const input = packument();
    const out = injectSignatureIntoPackument(input, VERSION, "SIG");
    expect(out.versions[VERSION].dist.cinatraSignature).toBe("SIG");
    // preserved
    expect(out._rev).toBe("5-deadbeef");
    expect(out.versions[VERSION].dist.integrity).toBe(INTEGRITY);
    expect(out.versions[VERSION].dist.tarball).toBe("https://r/notes/-/1.2.0.tgz");
    expect(out.versions["1.1.0"]).toEqual(input.versions["1.1.0"]);
    // metadata-only: no _attachments in the PATCH body
    expect(out._attachments).toBeUndefined();
    // input untouched
    expect(input.versions[VERSION].dist.cinatraSignature).toBeUndefined();
    expect(input._attachments).toBeDefined();
  });
  it("fail-closed: throws when the version or its dist is absent", () => {
    expect(() => injectSignatureIntoPackument(packument(), "9.9.9", "SIG")).toThrow(/not present/);
    const noDist = packument();
    delete noDist.versions[VERSION].dist;
    expect(() => injectSignatureIntoPackument(noDist, VERSION, "SIG")).toThrow(/no dist.integrity/);
    expect(() => injectSignatureIntoPackument(packument(), VERSION, "")).toThrow(/signature/);
  });
});

describe("assertServedIntegrityMatches — PATCH race guard", () => {
  it("passes when the served integrity still equals what was signed", () => {
    expect(() => assertServedIntegrityMatches(packument(), VERSION, INTEGRITY)).not.toThrow();
  });
  it("throws when the served integrity changed since signing (digest churn / re-publish)", () => {
    const p = packument();
    p.versions[VERSION].dist.integrity = "sha512-CHANGED";
    expect(() => assertServedIntegrityMatches(p, VERSION, INTEGRITY)).toThrow(/changed since signing/);
  });
  it("throws when the version/dist is absent", () => {
    expect(() => assertServedIntegrityMatches(packument(), "9.9.9", INTEGRITY)).toThrow(/expected/);
  });
});

describe("isAlreadySigned", () => {
  it("true only when the served signature already equals", () => {
    const signed = injectSignatureIntoPackument(packument(), VERSION, "SIG");
    expect(isAlreadySigned(signed, VERSION, "SIG")).toBe(true);
    expect(isAlreadySigned(signed, VERSION, "OTHER")).toBe(false);
    expect(isAlreadySigned(packument(), VERSION, "SIG")).toBe(false);
  });
});

describe("selectPushMode", () => {
  it("defaults to patch; accepts bump; rejects unknown", () => {
    expect(selectPushMode(undefined)).toBe("patch");
    expect(selectPushMode("PATCH")).toBe("patch");
    expect(selectPushMode("bump")).toBe("bump");
    expect(() => selectPushMode("rebuild")).toThrow(/unknown push mode/);
  });
});

describe("summarizeRun", () => {
  it("tallies signed/verified/failed + allVerified gate", () => {
    expect(summarizeRun([
      { packageName: "a", signature: "s", verifiedLocal: true },
      { packageName: "b", signature: "s", verifiedLocal: true },
    ])).toEqual({ total: 2, signed: 2, verified: 2, failed: 0, allVerified: true });
    expect(summarizeRun([
      { packageName: "a", signature: "s", verifiedLocal: true },
      { packageName: "b", error: "boom" },
    ]).allVerified).toBe(false);
  });
});

describe("end-to-end: injected signature is host-verifiable where the consumer reads it", () => {
  it("host sign -> inject into packument -> the served dist.cinatraSignature verifies against the public key", () => {
    const kp = generateExtensionSigningKeyPair();
    const prev = process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    try {
      // produce the signature the same byte-exact way the signer + host do
      const signature = signExtension({ packageName: PKG, version: VERSION, integrity: INTEGRITY }, kp.privateKeyPkcs8DerB64);
      // inject it into the packument exactly as the bulk tool's PATCH body would
      const served = injectSignatureIntoPackument(packument(), VERSION, signature);
      const dist = served.versions[VERSION].dist;
      // the consumer reads dist.cinatraSignature for THIS version + verifies vs the stored integrity
      expect(dist.cinatraSignature).toBe(signature);
      const ok = verifyExtensionSignature(
        { packageName: PKG, version: VERSION, integrity: dist.integrity },
        dist.cinatraSignature,
        loadTrustedPublicKeys(),
      );
      expect(ok).toBe(true);
      // a tampered integrity must NOT verify (binds the bytes)
      expect(
        verifyExtensionSignature({ packageName: PKG, version: VERSION, integrity: "sha512-TAMPERED" }, dist.cinatraSignature, loadTrustedPublicKeys()),
      ).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
      else process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = prev;
    }
  });
});
