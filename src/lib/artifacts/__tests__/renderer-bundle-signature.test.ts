/**
 * Host-side client-bundle signature admission (epic #1620 M1 Slice A —
 * cinatra#1630, plan §3.1): a genuine Ed25519 round-trip verifies; tamper /
 * wrong-key / non-strict-base64 / unsigned all fail closed for an in-page
 * (dynamic) renderer.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";

import {
  buildClientBundleSignaturePayload,
  type ClientBundleSignatureFields,
} from "@cinatra-ai/sdk-extensions/artifact-client-bundle";
import { sign as cryptoSign } from "node:crypto";
import type { TrustedPublicKey } from "@/lib/extension-signature";
import { publicKeyId } from "@/lib/extension-signature";
import {
  isClientBundleSignatureVerified,
  isStrictEd25519SignatureB64,
  resolveClientBundleSignatureVerdict,
  verifyClientBundleSignature,
} from "../renderer-bundle-signature";

function fields(over: Partial<ClientBundleSignatureFields> = {}): ClientBundleSignatureFields {
  return {
    packageName: "@cinatra-ai/json-artifact",
    slot: "detail",
    digest: "a".repeat(128),
    entry: "client/detail.js",
    propsApiVersion: 1,
    sdkAbiRange: "^2.4.0",
    reactPeerRange: "^19.0.0",
    reactDomPeerRange: "^19.0.0",
    tokenModuleAbi: "1.0.0",
    integrity: "sha512-Zm9v",
    ...over,
  };
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const trusted: TrustedPublicKey = { keyId: publicKeyId(pubB64), publicKeyDerB64: pubB64 };
  const sign = (f: ClientBundleSignatureFields) =>
    cryptoSign(null, Buffer.from(buildClientBundleSignaturePayload(f), "utf8"), privateKey).toString("base64");
  return { trusted, sign };
}

describe("Ed25519 round-trip admission", () => {
  it("verifies a genuine signature against a trusted key", () => {
    const { trusted, sign } = keypair();
    const f = fields();
    const sig = sign(f);
    expect(verifyClientBundleSignature(f, sig, [trusted])).toBe(true);
    expect(isClientBundleSignatureVerified(f, { signature: sig }, { trustedKeys: [trusted] })).toBe(true);
  });

  it("REJECTS a tampered field (binding property)", () => {
    const { trusted, sign } = keypair();
    const sig = sign(fields());
    expect(verifyClientBundleSignature(fields({ digest: "b".repeat(128) }), sig, [trusted])).toBe(false);
  });

  it("REJECTS a wrong key", () => {
    const a = keypair();
    const b = keypair();
    const sig = a.sign(fields());
    expect(verifyClientBundleSignature(fields(), sig, [b.trusted])).toBe(false);
  });

  it("REJECTS a non-canonical / non-strict signature base64", () => {
    expect(isStrictEd25519SignatureB64("not-base64")).toBe(false);
    expect(isStrictEd25519SignatureB64("A".repeat(88))).toBe(false);
    const { trusted, sign } = keypair();
    const sig = sign(fields());
    expect(verifyClientBundleSignature(fields(), `${sig}junk`, [trusted])).toBe(false);
  });
});

describe("fail-closed verdict for an in-page renderer", () => {
  it("no signature: required→false, not-required→undefined; both are UNVERIFIED", () => {
    expect(resolveClientBundleSignatureVerdict(fields(), { signature: null }, { trustedKeys: [], required: true })).toBe(false);
    expect(resolveClientBundleSignatureVerdict(fields(), { signature: null }, { trustedKeys: [], required: false })).toBeUndefined();
    expect(isClientBundleSignatureVerified(fields(), { signature: null }, { trustedKeys: [], required: false })).toBe(false);
  });

  it("no trusted key configured: cannot validate → not verified", () => {
    const { sign } = keypair();
    const sig = sign(fields());
    expect(resolveClientBundleSignatureVerdict(fields(), { signature: sig }, { trustedKeys: [], required: false })).toBeUndefined();
    expect(isClientBundleSignatureVerified(fields(), { signature: sig }, { trustedKeys: [], required: false })).toBe(false);
  });
});
